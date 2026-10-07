use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
  Created,
  Removed,
  Changed,
  Renamed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
  pub dir: String,
  pub name: String,
  pub kind: ChangeKind,
  /// Whether the entry is a directory, when the event can answer it without a
  /// guess. The frontend places a new row by sorting, and sorting needs to know
  /// this; without it every create turned into a full re-read of the directory.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub is_dir: Option<bool>,
  /// The previous name, when a rename stayed inside one directory — the frontend
  /// cannot infer it, and re-reading to find out is exactly what this avoids.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub from: Option<String>,
}

/// One watcher instance shared by every watched directory.
///
/// Creating a `recommended_watcher` per directory costs its own inotify +
/// epoll descriptors; a large tree exhausts the process fd limit within
/// seconds (EMFILE). A single instance multiplexes thousands of watches over
/// one descriptor, which is what makes per-expanded-directory watching viable.
pub struct WatchState {
  app: AppHandle,
  dirs: Mutex<HashSet<PathBuf>>,
  watcher: Mutex<Option<Box<notify::RecommendedWatcher>>>,
}

impl WatchState {
  fn is_watched(&self, dir: &str) -> bool {
    self
      .dirs
      .lock()
      .map(|d| d.contains(Path::new(dir)))
      .unwrap_or(false)
  }

  fn ensure_watcher(&self) -> Result<(), String> {
    let mut slot = self.watcher.lock().map_err(|_| "watcher poisoned".to_string())?;
    if slot.is_some() {
      return Ok(());
    }
    let app = self.app.clone();
    let state_dir = PathBuf::from("/");
    let _ = state_dir;
    let handle = app.clone();
    // The callback needs to ask "is this dir watched?"; it reads the shared set
    // through the app state, so no per-watcher registry is required.
    let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
      if let Ok(event) = res {
        if let Some(change) = normalize(&event) {
          let state = handle.state::<WatchState>();
          if state.is_watched(&change.dir) {
            // The dir changed, so its cached pages describe a filesystem that no
            // longer exists. Dropping them here means the next page request reads
            // the new listing instead of a stale one — and it happens at most
            // once per request no matter how many events a build tool emits.
            handle.state::<crate::dirindex::DirIndexStore>().invalidate(&change.dir);
            let _ = handle.emit("fs:change", &change);
          }
        }
      }
    })
    .map_err(|e| format!("recommended_watcher failed: {e}"))?;
    *slot = Some(Box::new(watcher));
    Ok(())
  }

  fn sync(&self, wanted: &[String]) {
    if let Ok(mut dirs) = self.dirs.lock() {
      let want: HashSet<PathBuf> = wanted.iter().map(PathBuf::from).collect();
      dirs.retain(|d| want.contains(d));
    }
    if wanted.is_empty() {
      return;
    }
    if let Err(err) = self.ensure_watcher() {
      log::warn!("{err}");
      return;
    }
    let Ok(mut slot) = self.watcher.lock() else { return };
    let Some(watcher) = slot.as_mut() else { return };
    let Ok(mut dirs) = self.dirs.lock() else { return };

    for dir in wanted {
      let path = PathBuf::from(dir);
      if dirs.contains(&path) {
        continue;
      }
      match watcher.watch(&path, RecursiveMode::NonRecursive) {
        Ok(()) => {
          dirs.insert(path);
        }
        Err(err) => log::warn!("watch {dir:?} failed: {err}"),
      }
    }
  }

}

/// One `metadata()` call, on the one path an event is about. Everything else
/// stays allocation-light: this runs for every event a build tool emits.
fn is_dir_of(path: &Path) -> Option<bool> {
  match fs::symlink_metadata(path) {
    Ok(meta) => Some(meta.is_dir()),
    // A file that was created and deleted again between the event and the stat.
    // Better to answer "unknown" than to answer wrong.
    Err(_) => None,
  }
}

fn change(dir: &Path, name: String, kind: ChangeKind) -> Option<Change> {
  Some(Change {
    dir: dir.to_string_lossy().to_string(),
    name,
    kind,
    is_dir: None,
    from: None,
  })
}

fn normalize(event: &Event) -> Option<Change> {
  if matches!(
    event.kind,
    EventKind::Modify(notify::event::ModifyKind::Name(_))
  ) {
    if event.paths.len() >= 2 {
      let from_path = &event.paths[0];
      let to = &event.paths[1];
      let name = to.file_name()?.to_string_lossy().to_string();
      let dir = to.parent()?;
      let mut out = change(dir, name, ChangeKind::Renamed)?;
      // Same directory: the frontend can move the row itself.
      if from_path.parent() == Some(dir) {
        if let Some(old) = from_path.file_name() {
          out.from = Some(old.to_string_lossy().to_string());
        }
        out.is_dir = is_dir_of(to);
      }
      return Some(out);
    }
  }
  let target = event.paths.first()?;
  let name = target.file_name()?.to_string_lossy().to_string();
  let dir = target.parent()?;
  let kind = match event.kind {
    EventKind::Create(_) => ChangeKind::Created,
    EventKind::Remove(_) => ChangeKind::Removed,
    _ => ChangeKind::Changed,
  };
  let mut out = change(dir, name, kind)?;
  if kind == ChangeKind::Created {
    // The entry exists right now, so one stat answers the only question the
    // frontend cannot: where does this row sort?
    out.is_dir = is_dir_of(target);
  }
  Some(out)
}

#[tauri::command]
pub fn sync_watch(app: tauri::AppHandle, dirs: Vec<String>) -> Result<Vec<String>, String> {
  let state = app.state::<WatchState>();
  state.sync(&dirs);
  Ok(dirs)
}

pub fn init(app: &mut tauri::App) {
  app.manage(WatchState {
    app: app.handle().clone(),
    dirs: Mutex::new(HashSet::new()),
    watcher: Mutex::new(None),
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_created_event_carries_the_kind_the_row_sorts_by() {
    let dir = std::env::temp_dir().join(format!("rg-watch-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let sub = dir.join("sub");
    fs::create_dir_all(&sub).unwrap();
    let file = dir.join("a.rs");
    fs::write(&file, b"x").unwrap();

    let dir_event = notify::Event {
      kind: EventKind::Create(notify::event::CreateKind::Folder),
      paths: vec![sub.clone()],
      attrs: Default::default(),
    };
    let json = serde_json::to_value(normalize(&dir_event).expect("normalize")).unwrap();
    // ChangeKind is `rename_all = "camelCase"`, so it reaches the frontend as
    // the lower-camel spelling the TS union uses.
    assert_eq!(json["kind"], "created");
    assert_eq!(json["isDir"], true);

    let file_event = notify::Event {
      kind: EventKind::Create(notify::event::CreateKind::File),
      paths: vec![file.clone()],
      attrs: Default::default(),
    };
    let json = serde_json::to_value(normalize(&file_event).expect("normalize")).unwrap();
    assert_eq!(json["isDir"], false);

    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_rename_inside_one_directory_reports_the_old_name() {
    let dir = std::env::temp_dir().join(format!("rg-watch-rn-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let to = dir.join("b.rs");
    fs::write(&to, b"x").unwrap();
    let event = notify::Event {
      kind: EventKind::Modify(notify::event::ModifyKind::Name(
        notify::event::RenameMode::Both,
      )),
      paths: vec![dir.join("a.rs"), to],
      attrs: Default::default(),
    };
    let json = serde_json::to_value(normalize(&event).expect("normalize")).unwrap();
    assert_eq!(json["name"], "b.rs");
    assert_eq!(json["from"], "a.rs");
    assert_eq!(json["isDir"], false);

    // Across directories there is no old name to report, and the field is omitted
    // rather than sent as null so the frontend can tell "unknown" from "none".
    let other = std::env::temp_dir().join(format!("rg-watch-rn2-{}", std::process::id()));
    let _ = fs::remove_dir_all(&other);
    fs::create_dir_all(&other).unwrap();
    let moved = other.join("c.rs");
    fs::write(&moved, b"x").unwrap();
    let event = notify::Event {
      kind: EventKind::Modify(notify::event::ModifyKind::Name(
        notify::event::RenameMode::Both,
      )),
      paths: vec![dir.join("d.rs"), moved],
      attrs: Default::default(),
    };
    let json = serde_json::to_value(normalize(&event).expect("normalize")).unwrap();
    assert!(json.get("from").is_none());

    let _ = fs::remove_dir_all(&dir);
    let _ = fs::remove_dir_all(&other);
  }

  #[test]
  fn dotfiles_are_reported_like_any_other_entry() {
    let dir = std::env::temp_dir();
    let event = notify::Event {
      kind: EventKind::Create(notify::event::CreateKind::File),
      paths: vec![dir.join(".cache")],
      attrs: Default::default(),
    };
    let out = normalize(&event).expect("a dotfile is an ordinary entry here");
    assert_eq!(out.name, ".cache");
  }
}
