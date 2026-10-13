//! The interaction log: every record of a turn, persisted in the order it
//! happened.
//!
//! A turn is two things at once. It is the conversation the model reads back on
//! the next prompt, and it is the record the user can come back to — and the
//! second one has to survive the first one being wrong. So each interaction is
//! written to a file of its own as it is produced, numbered by a counter rather
//! than by a clock: two records can land inside the same millisecond, and a
//! timestamp that repeats is an ordering that cannot be recovered afterwards.
//! The number is the identity, the order, and the sort order on disk.
//!
//! A turn is written whole or not at all. A record that fails to write takes
//! the turn's other records down with it, and the whole turn is retried once,
//! together, when it ends. Half a turn on disk reads as a conversation that
//! stopped making sense for a reason the reader cannot see, and nothing
//! downstream can tell it apart from a turn the user deliberately abandoned.
//!
//! The tree, next to `llm.json` because that is where the app keeps what it
//! would hate to lose:
//!
//! ```text
//! agent/log/000/000/000000000001.json
//! agent/log/000/000/000000000002.json
//! agent/log/000/001/000000001001.json
//! ```
//!
//! Two levels of a thousand each, so no directory holds more than a thousand
//! files however long the log gets. One flat directory of one file per record
//! is unreadable past a few thousand and unusable at a few hundred thousand.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use super::config::config_dir;

/// Records per directory, and with it the size of the largest directory.
const FANOUT: u64 = 1000;

/// One interaction, as it goes to disk.
///
/// `message` is the exact value the model saw rather than a rendering of it:
/// the log has to be enough to rebuild the transcript, and a reworded message
/// would make it a plausible-looking lie. `tool` is the other half of the same
/// record — what the panel showed for it — and is absent for anything that is
/// not a tool result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
  pub seq: u64,
  pub turn: u64,
  pub at: u64,
  pub model: String,
  pub message: Value,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tool: Option<ToolRecord>,
}

/// What the panel showed for one tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRecord {
  pub call_id: String,
  pub name: String,
  pub input: Value,
  pub ok: bool,
  pub summary: String,
  pub ms: u64,
}

/// The log tree: a counter, and the files that counter names.
pub struct Store {
  root: PathBuf,
  next: u64,
}

impl Store {
  /// The tree for this app, continuing after whatever the last run left.
  pub fn open(app: &AppHandle) -> Result<Self, String> {
    let store = Self::at(config_dir(app)?.join("agent").join("log"));
    log::info!("[agent] interaction log: {}", store.root.display());
    Ok(store)
  }

  /// A store over an arbitrary tree. The counter starts after the highest
  /// number on disk, so a second run of the app appends to the log it left
  /// rather than writing over the beginning of it.
  pub fn at(root: PathBuf) -> Self {
    let next = highest(&root) + 1;
    Self { root, next }
  }

  pub fn dir(&self) -> &Path {
    &self.root
  }

  /// The next number, and the counter moves.
  ///
  /// One call per record, always in the order the records happened, so the
  /// order on disk is decided by the counter rather than by whatever order the
  /// writes happen to land in.
  pub fn reserve(&mut self) -> u64 {
    let seq = self.next;
    self.next += 1;
    seq
  }

  /// Where a number lives.
  ///
  /// Zero-padded, so listing a directory in name order is the order the
  /// records happened in — `10` sorts before `9` in any listing that is not
  /// reading it as a number.
  pub fn file(&self, seq: u64) -> PathBuf {
    let at = seq.saturating_sub(1);
    self
      .root
      .join(format!("{:03}", at / (FANOUT * FANOUT)))
      .join(format!("{:03}", (at / FANOUT) % FANOUT))
      .join(format!("{seq:012}.json"))
  }

  /// Writes one record in one step: a temp file and a rename, so a crash
  /// mid-write leaves no half record for the retry to trip over.
  pub fn append(&mut self, seq: u64, record: &Record) -> Result<(), String> {
    let path = self.file(seq);
    let parent = path
      .parent()
      .ok_or_else(|| format!("{} has no parent", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    let body = serde_json::to_vec(record).map_err(|e| format!("cannot serialise record {seq}: {e}"))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, &body).map_err(|e| format!("cannot write {}: {e}", temp.display()))?;
    fs::rename(&temp, &path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
  }

  /// A whole turn, in one pass and in order.
  ///
  /// Stops at the first failure. The caller discards, so writing the rest of a
  /// turn already known to be broken would only produce files to delete.
  pub fn append_all(&mut self, records: &[(u64, Record)]) -> Result<(), String> {
    for (seq, record) in records {
      self.append(*seq, record)?;
    }
    Ok(())
  }

  /// Removes every record from `from` up to the counter. The counter does not
  /// move.
  ///
  /// It cannot, mid-turn: the numbers already handed out belong to records that
  /// are still being produced, and rewinding here would give the next record of
  /// this turn a number that an earlier one of it already holds. The retry
  /// writes those records back at the numbers they were given, which is what
  /// keeps the log in the order things happened rather than the order they were
  /// saved.
  pub fn discard(&mut self, from: u64) {
    for seq in from..self.next {
      let path = self.file(seq);
      match fs::remove_file(&path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::warn!("cannot discard {}: {err}", path.display()),
      }
    }
  }

  /// Hands the numbers from `to` up to the counter back.
  ///
  /// Only safe once nothing is holding one: the caller either gives up on the
  /// turn or is about to write those very numbers again, and a record still in
  /// hand would be left pointing at a file someone else owns.
  pub fn rewind(&mut self, to: u64) {
    self.next = to.min(self.next);
  }
}

/// A turn as it is written: the records it has produced, and whether the tree
/// can still take them.
pub struct Recorder {
  store: Store,
  turn: u64,
  records: Vec<(u64, Record)>,
  broken: bool,
}

impl Recorder {
  pub fn new(store: Store) -> Self {
    Self {
      store,
      turn: 0,
      records: Vec::new(),
      broken: false,
    }
  }

  /// Starts the next turn, clean whatever the last one ended like.
  pub fn begin_turn(&mut self) {
    self.turn += 1;
    self.records.clear();
    self.broken = false;
  }

  /// One interaction: numbered now, written now.
  ///
  /// The record is kept either way. That is what makes the rollback possible —
  /// a turn whose files have been deleted still has the records to write them
  /// back from, which is the difference between "persistence failed" and "this
  /// turn no longer exists".
  pub fn push(&mut self, model: String, message: Value, tool: Option<ToolRecord>) {
    let seq = self.store.reserve();
    let record = Record {
      seq,
      turn: self.turn,
      at: now_millis(),
      model,
      message,
      tool,
    };

    if !self.broken {
      if let Err(err) = self.store.append(seq, &record) {
        let from = self.records.first().map(|(first, _)| *first).unwrap_or(seq);
        log::warn!(
          "[agent] record {seq} did not persist ({err}); taking turn {} down with it, from {from}",
          self.turn
        );
        self.store.discard(from);
        self.broken = true;
      }
    }
    self.records.push((seq, record));
  }

  /// The turn is over. One retry, whole, for everything that did not land.
  ///
  /// Once. A second failure is logged and the numbers are given back rather
  /// than retried again: a disk that is full now will still be full a moment
  /// later, and the next turn must not be blocked behind a turn that never
  /// worked.
  pub fn end_turn(&mut self) {
    if !self.broken {
      self.records.clear();
      return;
    }

    let records = std::mem::take(&mut self.records);
    let count = records.len();
    match self.store.append_all(&records) {
      Ok(()) => log::info!("[agent] turn {} persisted on retry: {count} records", self.turn),
      Err(err) => {
        log::warn!("[agent] turn {} could not be persisted ({err}); {count} records are lost", self.turn);
        // The numbers go back with the files, so the tree stays dense and the
        // next turn starts where this one did rather than in a hole.
        if let Some((from, _)) = records.first() {
          self.store.discard(*from);
          self.store.rewind(*from);
        }
      }
    }
    self.broken = false;
  }
}

/// The highest number on disk under `root`, or zero for an empty tree.
fn highest(root: &Path) -> u64 {
  let mut highest = 0u64;
  // Two levels of fan-out plus the files: read them as levels rather than as a
  // recursive walk, because the depth is fixed and this stays flat.
  let Ok(outer) = fs::read_dir(root) else {
    return 0;
  };
  for high in outer.flatten() {
    if !high.file_type().is_ok_and(|kind| kind.is_dir()) {
      continue;
    }
    let Ok(inner) = fs::read_dir(high.path()) else {
      continue;
    };
    for mid in inner.flatten() {
      if !mid.file_type().is_ok_and(|kind| kind.is_dir()) {
        continue;
      }
      let Ok(files) = fs::read_dir(mid.path()) else {
        continue;
      };
      for file in files.flatten() {
        if let Some(seq) = number_of(&file.file_name()) {
          highest = highest.max(seq);
        }
      }
    }
  }
  highest
}

/// The number in `000000000042.json`, and `None` for anything else in the tree.
fn number_of(name: &OsStr) -> Option<u64> {
  name.to_str()?.strip_suffix(".json")?.parse().ok()
}

fn now_millis() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  /// A tree of this test's own, removed even when an assertion fails.
  struct Tree(PathBuf);

  impl Tree {
    fn new(name: &str) -> Self {
      let path = std::env::temp_dir().join(format!(
        "researchgo-log-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .unwrap()
          .as_nanos()
      ));
      let _ = fs::remove_dir_all(&path);
      Self(path)
    }
  }

  impl Drop for Tree {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  fn message(text: &str) -> Value {
    json!({ "role": "assistant", "content": text })
  }

  /// The numbers on disk, sorted as the padded names sort.
  fn on_disk(store: &Store) -> Vec<u64> {
    let mut found = Vec::new();
    let mut stack = vec![store.dir().to_path_buf()];
    while let Some(dir) = stack.pop() {
      let Ok(entries) = fs::read_dir(&dir) else { continue };
      for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
          stack.push(entry.path());
        } else if let Some(seq) = number_of(&entry.file_name()) {
          found.push(seq);
        }
      }
    }
    found.sort();
    found
  }

  fn read(store: &Store, seq: u64) -> Record {
    let raw = fs::read_to_string(store.file(seq)).expect("the record is on disk");
    serde_json::from_str(&raw).expect("the record parses")
  }

  /// Records one interaction the way the loop does: take a number, write it.
  fn put(store: &mut Store, turn: u64, text: &str) -> u64 {
    let seq = store.reserve();
    store
      .append(
        seq,
        &Record {
          seq,
          turn,
          at: 0,
          model: "m".into(),
          message: message(text),
          tool: None,
        },
      )
      .expect("writes");
    seq
  }

  /// Makes one leaf of the tree unwritable, by putting a file where the
  /// directory has to be. Every write into it fails from here on.
  fn break_leaf(store: &Store, seq: u64) -> PathBuf {
    let leaf = store.file(seq).parent().expect("a leaf").to_path_buf();
    let _ = fs::create_dir_all(&leaf);
    let _ = fs::remove_dir_all(&leaf);
    fs::write(&leaf, b"not a directory").expect("sabotage");
    leaf
  }

  /// A recorder over the same tree, so a test can look at what was written
  /// without the recorder having to hand its store back afterwards.
  fn recorder(store: &mut Store) -> Recorder {
    Recorder::new(Store {
      root: store.dir().to_path_buf(),
      next: store.reserve(),
    })
  }

  #[test]
  fn the_counter_names_the_files_in_the_order_the_records_happened() {
    let tree = Tree::new("order");
    let mut store = Store::at(tree.0.clone());
    put(&mut store, 1, "first");
    put(&mut store, 1, "second");

    assert_eq!(on_disk(&store), vec![1, 2]);
    assert_eq!(read(&store, 1).message["content"], "first");
    assert_eq!(read(&store, 2).message["content"], "second");
  }

  #[test]
  fn the_tree_fans_out_so_no_directory_grows_without_bound() {
    let tree = Tree::new("fanout");
    let store = Store::at(tree.0.clone());

    assert_eq!(store.file(1), tree.0.join("000/000/000000000001.json"));
    assert_eq!(store.file(1000), tree.0.join("000/000/000000001000.json"));
    // The thousandth record is the last one in the first leaf directory.
    assert_eq!(store.file(1001), tree.0.join("000/001/000000001001.json"));
    assert_eq!(store.file(1_000_000), tree.0.join("000/999/000001000000.json"));
    assert_eq!(store.file(1_000_001), tree.0.join("001/000/000001000001.json"));
  }

  #[test]
  fn a_second_run_continues_after_what_the_last_one_left() {
    let tree = Tree::new("resume");
    let mut store = Store::at(tree.0.clone());
    put(&mut store, 1, "old");

    // A fresh store over the same tree: what the next launch of the app does.
    let mut reopened = Store::at(tree.0.clone());
    assert_eq!(reopened.reserve(), 2);
  }

  #[test]
  fn discarding_a_turn_takes_its_files_and_leaves_the_numbers_alone() {
    let tree = Tree::new("discard");
    let mut store = Store::at(tree.0.clone());
    put(&mut store, 1, "kept");
    put(&mut store, 2, "doomed");
    put(&mut store, 2, "doomed too");

    store.discard(2);

    assert_eq!(on_disk(&store), vec![1]);
    // The counter has not moved: the numbers 2 and 3 belong to records the
    // turn is still holding, and the retry writes them back where they were.
    assert_eq!(store.reserve(), 4);
  }

  #[test]
  fn a_record_that_will_not_write_takes_its_turn_down_and_the_retry_brings_it_back() {
    let tree = Tree::new("retry");
    let mut store = Store::at(tree.0.clone());
    let mut rec = recorder(&mut store);
    rec.begin_turn();
    rec.push("m".into(), message("one"), None);
    assert_eq!(on_disk(&store), vec![1]);

    let leaf = break_leaf(&store, 2);
    rec.push("m".into(), message("two"), None);
    rec.push("m".into(), message("three"), None);
    assert_eq!(on_disk(&store), Vec::<u64>::new(), "the turn left nothing behind");

    // The turn ends and the retry happens once, for the whole turn.
    let _ = fs::remove_file(&leaf);
    rec.end_turn();

    assert_eq!(on_disk(&store), vec![1, 2, 3]);
    // The records kept the numbers they were given, so the log reads in the
    // order things happened rather than in the order the retry wrote them.
    assert_eq!(read(&store, 2).message["content"], "two");
    assert_eq!(read(&store, 3).message["content"], "three");
    assert_eq!(read(&store, 2).turn, 1);
  }

  #[test]
  fn a_retry_that_fails_too_gives_the_numbers_back_and_lets_the_next_turn_write() {
    let tree = Tree::new("lost");
    let mut store = Store::at(tree.0.clone());
    let mut rec = recorder(&mut store);
    rec.begin_turn();

    let leaf = break_leaf(&store, 1);
    rec.push("m".into(), message("doomed"), None);
    rec.end_turn();

    // A tree that is broken now is still broken at the retry: one attempt, and
    // then the turn is given up on rather than retried forever.
    assert_eq!(on_disk(&store), Vec::<u64>::new());

    // The next turn writes normally, from the number the lost turn gave back.
    let _ = fs::remove_file(&leaf);
    rec.begin_turn();
    rec.push("m".into(), message("after"), None);
    rec.end_turn();
    assert_eq!(read(&store, 1).message["content"], "after");
    assert_eq!(read(&store, 1).turn, 2);
  }

  #[test]
  fn a_turn_records_its_own_number_and_what_the_panel_showed() {
    let tree = Tree::new("shape");
    let mut store = Store::at(tree.0.clone());
    let mut rec = recorder(&mut store);
    rec.begin_turn();
    rec.push(
      "gpt-4o".into(),
      json!({ "role": "tool", "tool_call_id": "call_1", "content": "42" }),
      Some(ToolRecord {
        call_id: "call_1".into(),
        name: "read".into(),
        input: json!({ "path": "a.txt" }),
        ok: true,
        summary: "1 line".into(),
        ms: 12,
      }),
    );
    rec.end_turn();

    let raw = fs::read_to_string(store.file(1)).expect("the record is on disk");
    assert!(raw.contains("\"seq\":1"), "{raw}");
    assert!(raw.contains("\"turn\":1"), "{raw}");
    assert!(raw.contains("\"callId\":\"call_1\""), "{raw}");
    assert!(raw.contains("\"ms\":12"), "{raw}");
    // The message is the model's own, not a rendering of it.
    assert_eq!(read(&store, 1).message["content"], "42");

    // A record with no tool half leaves the field out rather than writing null.
    rec.begin_turn();
    rec.push("gpt-4o".into(), message("plain"), None);
    rec.end_turn();
    let plain = fs::read_to_string(store.file(2)).expect("the record is on disk");
    assert!(!plain.contains("\"tool\""), "plain message: {plain}");
    assert_eq!(read(&store, 2).turn, 2, "turns are numbered, not stored once");
  }
}
