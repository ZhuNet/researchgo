//! Paged directory listings with a hard memory ceiling.
//!
//! The previous implementation called `read_dir` and returned every entry of a
//! directory as one array. That caps the tree at "one directory fits in RAM",
//! which a single `node_modules` or a data dump breaks.
//!
//! Here a directory is served as *pages* of a sorted index:
//!
//! - Small directories (the overwhelming majority) are sorted in memory and kept
//!   there, in a FIFO store with an entry ceiling. No disk traffic, and no more
//!   work than `read_dir` plus a sort.
//! - Large directories are sorted with bounded memory — a chunk is sorted and
//!   spilled to a run file, runs are merged `FANIN` at a time — and the result
//!   lands in an on-disk index plus an offset table. A page is then a seek and a
//!   short read, so resident memory is `O(page)` no matter how many entries the
//!   directory holds.
//!
//! Sorting is why this is not `read_dir` + `skip(offset)`: the order has to be
//! stable across pages, otherwise the first page would have to be kept forever
//! and row indices would shift under the reader.
//!
//! Validity is decided by the directory's mtime, and mutations plus watcher
//! events invalidate explicitly, so a stale page is never served.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAGIC: &[u8; 4] = b"RGDI";
const VERSION: u32 = 1;
/// magic, version, count, files, dirs, mtime, reserved, path_len, body_start
const HEADER_LEN: usize = 56;
const CHUNK: usize = 32_768;
const FANIN: usize = 4;
const IO_BUF: usize = 256 * 1024;
/// One page is one range read; anything larger is a bug or an abuse.
pub const MAX_LIMIT: usize = 4_096;
pub const DEFAULT_PAGE: usize = 512;
const MEM_MAX_ENTRIES: usize = 200_000;
const MEM_MAX_DIRS: usize = 8_192;
/// Indexes nobody has read in a week are dead weight on disk.
const SWEEP_AGE_SECS: u64 = 7 * 24 * 3600;
/// Merge leftovers from a crashed build.
const RUN_AGE_SECS: u64 = 3600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
  pub name: String,
  pub path: String,
  pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirPage {
  pub dir: String,
  pub offset: usize,
  pub entries: Vec<DirEntry>,
  /// Children in the whole index, not just in this page.
  pub total: usize,
  /// How many of those children are files, and how many are directories.
  pub files: usize,
  pub dirs: usize,
  pub has_more: bool,
}

#[derive(Clone)]
struct Rec {
  name: String,
  dir: bool,
}

impl Rec {
  /// Directories first, then case-insensitively by name, then by exact name, so
  /// the order is total: a page boundary can never hold two equal entries.
  fn key(&self, other: &Rec) -> std::cmp::Ordering {
    other
      .dir
      .cmp(&self.dir)
      .then_with(|| cmp_ci(&self.name, &other.name))
      .then_with(|| self.name.cmp(&other.name))
  }
}

fn fold(c: char) -> char {
  c.to_lowercase().next().unwrap_or(c)
}

/// Allocation-free for ASCII, which is what filenames overwhelmingly are.
fn cmp_ci(a: &str, b: &str) -> std::cmp::Ordering {
  let mut ai = a.chars();
  let mut bi = b.chars();
  loop {
    match (ai.next(), bi.next()) {
      (None, None) => return std::cmp::Ordering::Equal,
      (None, Some(_)) => return std::cmp::Ordering::Less,
      (Some(_), None) => return std::cmp::Ordering::Greater,
      (Some(x), Some(y)) => {
        if x == y {
          continue;
        }
        let (lx, ly) = (fold(x), fold(y));
        if lx != ly {
          return lx.cmp(&ly);
        }
        return x.cmp(&y);
      }
    }
  }
}

fn join(dir: &str, name: &str) -> String {
  if dir == "/" {
    format!("/{name}")
  } else {
    format!("{dir}/{name}")
  }
}

fn io(e: std::io::Error) -> String {
  e.to_string()
}

fn secs(t: SystemTime) -> u64 {
  t
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

fn mtime_of(path: &Path) -> Result<u64, String> {
  let meta = fs::metadata(path).map_err(|e| format!("stat failed: {e}"))?;
  Ok(secs(meta.modified().unwrap_or(UNIX_EPOCH)))
}

fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
  let mut got = 0;
  while got < buf.len() {
    match reader.read(&mut buf[got..]) {
      Ok(0) => break,
      Ok(n) => got += n,
      Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
      Err(e) => return Err(e),
    }
  }
  Ok(got)
}

fn encode(rec: &Rec, out: &mut Vec<u8>) {
  out.extend_from_slice(&(rec.name.len() as u32).to_le_bytes());
  out.push(u8::from(rec.dir));
  out.extend_from_slice(rec.name.as_bytes());
}

/// `None` at a clean end of stream, `Err` on a truncated record.
fn decode(reader: &mut impl Read) -> Result<Option<Rec>, String> {
  let mut len = [0u8; 4];
  let got = read_full(reader, &mut len).map_err(io)?;
  if got == 0 {
    return Ok(None);
  }
  if got < 4 {
    return Err("truncated record header".into());
  }
  let n = u32::from_le_bytes(len) as usize;
  let mut kind = [0u8; 1];
  read_full(reader, &mut kind).map_err(io)?;
  let mut name = vec![0u8; n];
  read_full(reader, &mut name).map_err(io)?;
  Ok(Some(Rec {
    name: String::from_utf8_lossy(&name).into_owned(),
    dir: kind[0] == 1,
  }))
}

struct MemListing {
  recs: Vec<Rec>,
  files: usize,
  dirs: usize,
  /// The directory's mtime when this listing was built. The watcher only
  /// covers expanded directories, so a file can land while a directory is
  /// collapsed (or in the gap before a fresh watch engages) and no event
  /// ever invalidates this entry — the mtime is the backstop that catches it.
  mtime: u64,
}

/// FIFO by insertion order, not by access. A directory the user scrolls back into
/// is re-listed rather than kept alive forever, which is what keeps the ceiling
/// real; the caller only asks for the page it needs, so a miss costs one
/// `read_dir`.
#[derive(Default)]
struct MemStore {
  map: HashMap<String, MemListing>,
  order: VecDeque<String>,
  /// Front of `order`; entries before it are gone and are skipped over.
  head: usize,
  entries: usize,
  max_entries: usize,
  max_dirs: usize,
}

impl MemStore {
  fn new(max_entries: usize, max_dirs: usize) -> Self {
    MemStore {
      max_entries,
      max_dirs,
      ..Default::default()
    }
  }

  fn insert(&mut self, dir: &str, recs: Vec<Rec>, files: usize, dirs: usize, mtime: u64) {
    self.drop_dir(dir);
    self.entries += recs.len();
    self.map.insert(
      dir.to_string(),
      MemListing { recs, files, dirs, mtime },
    );
    self.order.push_back(dir.to_string());
    self.evict();
  }

  fn evict(&mut self) {
    while (self.entries > self.max_entries || self.map.len() > self.max_dirs)
      && self.head < self.order.len()
    {
      if let Some(dir) = self.order.get(self.head).cloned() {
        self.head += 1;
        self.drop_dir(&dir);
      }
    }
    if self.head > 64 && self.head * 2 > self.order.len() {
      self.order.drain(..self.head);
      self.head = 0;
    }
  }

  fn drop_dir(&mut self, dir: &str) {
    if let Some(prev) = self.map.remove(dir) {
      self.entries -= prev.recs.len();
    }
  }

  fn clear(&mut self) {
    self.map.clear();
    self.order.clear();
    self.head = 0;
    self.entries = 0;
  }
}

struct Header {
  count: usize,
  files: usize,
  dirs: usize,
  mtime: u64,
}

pub struct DirIndex {
  root: PathBuf,
  /// One build at a time: there is a single client, and letting two builds race
  /// would just write the same file twice.
  build: Mutex<()>,
  mem: Mutex<MemStore>,
  /// Directories known to be stale. Consulted before the on-disk index so a
  /// mutation made a moment ago is never answered from an older build.
  invalid: Mutex<HashSet<String>>,
}

impl DirIndex {
  fn new(root: PathBuf) -> Self {
    let _ = fs::create_dir_all(root.join("tmp"));
    DirIndex {
      root,
      build: Mutex::new(()),
      mem: Mutex::new(MemStore::new(MEM_MAX_ENTRIES, MEM_MAX_DIRS)),
      invalid: Mutex::new(HashSet::new()),
    }
  }

  fn idx_path(&self, dir: &str) -> PathBuf {
    self.root.join(format!("{}.idx", key_of(dir)))
  }

  fn off_path(&self, dir: &str) -> PathBuf {
    self.root.join(format!("{}.off", key_of(dir)))
  }

  fn run_path(&self, tag: &str) -> PathBuf {
    self.root.join("tmp").join(format!("{tag}.run"))
  }

  fn is_invalid(&self, dir: &str) -> bool {
    self.invalid.lock().map(|s| s.contains(dir)).unwrap_or(false)
  }

  fn clear_invalid(&self, dir: &str) {
    if let Ok(mut set) = self.invalid.lock() {
      set.remove(dir);
    }
  }

  pub fn invalidate(&self, dir: &str) {
    if let Ok(mut mem) = self.mem.lock() {
      mem.drop_dir(dir);
    }
    if let Ok(mut set) = self.invalid.lock() {
      set.insert(dir.to_string());
    }
  }

  pub fn invalidate_all(&self) {
    if let Ok(mut mem) = self.mem.lock() {
      mem.clear();
    }
    if let Ok(mut set) = self.invalid.lock() {
      set.clear();
    }
  }

  pub fn page(&self, dir: &str, offset: usize, limit: usize) -> Result<DirPage, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let path = Path::new(dir);
    if !path.is_dir() {
      return Err(format!("not a directory: {dir}"));
    }
    let mtime = mtime_of(path)?;

    if !self.is_invalid(dir) {
      let mem = self.mem.lock().map_err(|_| "dir index poisoned".to_string())?;
      if let Some(listing) = mem.map.get(dir)
        && listing.mtime == mtime
      {
        return Ok(page_from_slice(dir, listing, offset, limit));
      }
      // A listing whose mtime has moved on means the directory changed
      // without an event reaching us. Fall through and rebuild rather than
      // answering from the old listing.
      drop(mem);
      if let Some(hit) = self.page_from_disk(dir, offset, limit, mtime)? {
        return Ok(hit);
      }
    }

    self.ensure(dir, path, mtime)?;
    self.clear_invalid(dir);
    let mem = self.mem.lock().map_err(|_| "dir index poisoned".to_string())?;
    if let Some(listing) = mem.map.get(dir) {
      return Ok(page_from_slice(dir, listing, offset, limit));
    }
    drop(mem);
    match self.page_from_disk(dir, offset, limit, mtime)? {
      Some(hit) => Ok(hit),
      None => Err(format!("dir index unavailable: {dir}")),
    }
  }

  fn page_from_disk(
    &self,
    dir: &str,
    offset: usize,
    limit: usize,
    mtime: u64,
  ) -> Result<Option<DirPage>, String> {
    let idx = self.idx_path(dir);
    let off = self.off_path(dir);
    let Ok(mut file) = File::open(&idx) else {
      return Ok(None);
    };
    let Some(header) = read_header(&mut file, dir)? else {
      return Ok(None);
    };
    if header.mtime != mtime {
      return Ok(None);
    }

    if offset >= header.count {
      return Ok(Some(DirPage {
        dir: dir.to_string(),
        offset,
        entries: Vec::new(),
        total: header.count,
        files: header.files,
        dirs: header.dirs,
        has_more: false,
      }));
    }
    let want = limit.min(header.count - offset);

    let mut offsets = File::open(&off).map_err(|e| format!("open offset table failed: {e}"))?;
    offsets
      .seek(SeekFrom::Start((offset * 8) as u64))
      .map_err(io)?;
    let mut slot = [0u8; 8];
    if read_full(&mut offsets, &mut slot).map_err(io)? != 8 {
      return Ok(None);
    }

    file.seek(SeekFrom::Start(u64::from_le_bytes(slot))).map_err(io)?;
    let mut reader = BufReader::with_capacity(IO_BUF, file);
    let mut entries = Vec::with_capacity(want);
    for _ in 0..want {
      match decode(&mut reader)? {
        Some(rec) => entries.push(DirEntry {
          path: join(dir, &rec.name),
          kind: if rec.dir { "dir" } else { "file" },
          name: rec.name,
        }),
        None => break,
      }
    }
    if entries.len() != want {
      // Truncated body: drop the index so the next request rebuilds it instead
      // of asking for a directory that can no longer answer.
      let _ = fs::remove_file(&idx);
      let _ = fs::remove_file(&off);
      return Ok(None);
    }
    Ok(Some(DirPage {
      dir: dir.to_string(),
      offset,
      entries,
      total: header.count,
      files: header.files,
      dirs: header.dirs,
      has_more: offset + want < header.count,
    }))
  }

  fn ensure(&self, dir: &str, path: &Path, mtime: u64) -> Result<(), String> {
    let _guard = self.build.lock().map_err(|_| "dir index poisoned".to_string())?;
    {
      let mem = self.mem.lock().map_err(|_| "dir index poisoned".to_string())?;
      // The mtime matters here too: `page` falls through on a moved-on
      // directory, and short-circuiting on the stale entry would serve it
      // again from the second lookup below.
      if mem.map.get(dir).is_some_and(|l| l.mtime == mtime) {
        return Ok(());
      }
    }
    if !self.is_invalid(dir) && self.index_valid(dir, mtime)? {
      return Ok(());
    }
    self.build_at(dir, path, mtime, CHUNK)
  }

  fn index_valid(&self, dir: &str, mtime: u64) -> Result<bool, String> {
    if !self.off_path(dir).exists() {
      return Ok(false);
    }
    let Ok(mut file) = File::open(self.idx_path(dir)) else {
      return Ok(false);
    };
    let Some(header) = read_header(&mut file, dir)? else {
      return Ok(false);
    };
    if header.mtime != mtime {
      return Ok(false);
    }
    let size = fs::metadata(self.idx_path(dir)).map(|m| m.len()).unwrap_or(0);
    Ok(size >= (HEADER_LEN + dir.len()) as u64)
  }

  /// `chunk` is the sort chunk size, i.e. the memory ceiling of a build: entries
  /// beyond it spill to run files. Parameterised so tests can exercise the spill
  /// path without writing tens of thousands of files.
  fn build_at(&self, dir: &str, path: &Path, mtime: u64, chunk: usize) -> Result<(), String> {
    let tag = key_of(dir);
    let mut buf: Vec<Rec> = Vec::with_capacity(chunk.min(8192));
    let mut runs: Vec<PathBuf> = Vec::new();
    let mut files = 0usize;
    let mut dir_count = 0usize;
    let mut run_id = 0usize;

    let spill = |buf: &mut Vec<Rec>, runs: &mut Vec<PathBuf>, run_id: &mut usize| -> Result<(), String> {
      buf.sort_by(|a, b| a.key(b));
      let run = self.run_path(&format!("{tag}-{run_id}"));
      *run_id += 1;
      write_run(buf, &run)?;
      runs.push(run);
      buf.clear();
      Ok(())
    };

    scan(path, |rec| {
      if rec.dir {
        dir_count += 1;
      } else {
        files += 1;
      }
      buf.push(rec);
      if buf.len() == chunk {
        spill(&mut buf, &mut runs, &mut run_id)?;
      }
      Ok(())
    })?;

    if runs.is_empty() {
      buf.sort_by(|a, b| a.key(b));
      let mut mem = self.mem.lock().map_err(|_| "dir index poisoned".to_string())?;
      mem.insert(dir, buf, files, dir_count, mtime);
      return Ok(());
    }
    if !buf.is_empty() {
      spill(&mut buf, &mut runs, &mut run_id)?;
    }

    while runs.len() > 1 {
      let mut next: Vec<PathBuf> = Vec::with_capacity(runs.len() / FANIN + 1);
      for group in runs.chunks(FANIN) {
        if group.len() == 1 {
          next.push(group[0].clone());
          continue;
        }
        let out = self.run_path(&format!("{tag}-{run_id}"));
        run_id += 1;
        let outcome = (|| -> Result<(), String> {
          let file = File::create(&out).map_err(io)?;
          let mut writer = BufWriter::with_capacity(IO_BUF, file);
          let merged = merge_into(group, &mut writer, 0, None);
          writer.flush().map_err(io)?;
          merged
        })();
        for stale in group {
          let _ = fs::remove_file(stale);
        }
        outcome?;
        next.push(out);
      }
      runs = next;
    }

    let tmp_idx = self.run_path(&format!("{tag}.idx"));
    let tmp_off = self.run_path(&format!("{tag}.off"));
    let body_start = HEADER_LEN + dir.len();
    {
      let body = File::create(&tmp_idx).map_err(io)?;
      let mut writer = BufWriter::with_capacity(IO_BUF, body);
      // Reserve the header: record offsets are absolute, so nothing needs
      // fixing up afterwards.
      writer
        .write_all(&vec![0u8; body_start])
        .map_err(io)?;
      let mut offs = BufWriter::with_capacity(IO_BUF, File::create(&tmp_off).map_err(io)?);
      {
        let mut sink = |offset: u64| offs.write_all(&offset.to_le_bytes()).map_err(io);
        merge_into(&runs, &mut writer, body_start as u64, Some(&mut sink))?;
        offs.flush().map_err(io)?;
      }
      writer.flush().map_err(io)?;
    }
    let _ = fs::remove_file(&runs[0]);

    let mut header = vec![0u8; body_start];
    header[0..4].copy_from_slice(MAGIC);
    header[4..8].copy_from_slice(&VERSION.to_le_bytes());
    header[8..16].copy_from_slice(&((files + dir_count) as u64).to_le_bytes());
    header[16..24].copy_from_slice(&(files as u64).to_le_bytes());
    header[24..32].copy_from_slice(&(dir_count as u64).to_le_bytes());
    header[32..40].copy_from_slice(&mtime.to_le_bytes());
    header[48..52].copy_from_slice(&(dir.len() as u32).to_le_bytes());
    header[52..56].copy_from_slice(&(body_start as u32).to_le_bytes());
    header[HEADER_LEN..].copy_from_slice(dir.as_bytes());
    let mut head = File::options().write(true).open(&tmp_idx).map_err(io)?;
    head.write_all(&header).map_err(io)?;
    head.flush().map_err(io)?;
    drop(head);

    fs::rename(&tmp_idx, self.idx_path(dir)).map_err(io)?;
    fs::rename(&tmp_off, self.off_path(dir)).map_err(io)?;
    Ok(())
  }

  /// Deletes index files nobody has read in a week, plus merge leftovers.
  pub fn sweep(&self) {
    let now = secs(SystemTime::now());
    if let Ok(entries) = fs::read_dir(&self.root) {
      for entry in entries.flatten() {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
          continue;
        };
        if ext != "idx" && ext != "off" {
          continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if now.saturating_sub(secs(meta.modified().unwrap_or(UNIX_EPOCH))) > SWEEP_AGE_SECS {
          let _ = fs::remove_file(&path);
        }
      }
    }
    if let Ok(entries) = fs::read_dir(self.root.join("tmp")) {
      for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if now.saturating_sub(secs(meta.modified().unwrap_or(UNIX_EPOCH))) > RUN_AGE_SECS {
          let _ = fs::remove_file(entry.path());
        }
      }
    }
  }
}

fn read_header(file: &mut File, dir: &str) -> Result<Option<Header>, String> {
  let mut head = [0u8; HEADER_LEN];
  if read_full(file, &mut head).map_err(io)? != HEADER_LEN {
    return Ok(None);
  }
  if &head[0..4] != MAGIC || u32::from_le_bytes(head[4..8].try_into().unwrap()) != VERSION {
    return Ok(None);
  }
  let path_len = u32::from_le_bytes(head[48..52].try_into().unwrap()) as usize;
  let mut stored = vec![0u8; path_len];
  if read_full(file, &mut stored).map_err(io)? != path_len {
    return Ok(None);
  }
  if stored != dir.as_bytes() {
    return Ok(None);
  }
  Ok(Some(Header {
    count: u64::from_le_bytes(head[8..16].try_into().unwrap()) as usize,
    files: u64::from_le_bytes(head[16..24].try_into().unwrap()) as usize,
    dirs: u64::from_le_bytes(head[24..32].try_into().unwrap()) as usize,
    mtime: u64::from_le_bytes(head[32..40].try_into().unwrap()),
  }))
}

fn page_from_slice(dir: &str, listing: &MemListing, offset: usize, limit: usize) -> DirPage {
  let total = listing.recs.len();
  let start = offset.min(total);
  let end = (start + limit).min(total);
  let entries = listing.recs[start..end]
    .iter()
    .map(|rec| DirEntry {
      path: join(dir, &rec.name),
      kind: if rec.dir { "dir" } else { "file" },
      name: rec.name.clone(),
    })
    .collect();
  DirPage {
    dir: dir.to_string(),
    offset: start,
    entries,
    total,
    files: listing.files,
    dirs: listing.dirs,
    has_more: end < total,
  }
}

fn scan(path: &Path, mut sink: impl FnMut(Rec) -> Result<(), String>) -> Result<(), String> {
  let iter = fs::read_dir(path).map_err(|e| format!("read_dir failed: {e}"))?;
  for entry in iter.flatten() {
    let name = entry.file_name().to_string_lossy().into_owned();
    // `file_type` comes from the directory entry itself on the platforms we
    // target, so this stays one syscall per entry. The `metadata` call per entry
    // this replaces is what made opening a huge directory feel like a hang.
    let ft = match entry.file_type() {
      Ok(ft) => ft,
      Err(_) => continue,
    };
    let is_dir = if ft.is_symlink() {
      fs::metadata(entry.path())
        .map(|m| m.is_dir())
        .unwrap_or(false)
    } else {
      ft.is_dir()
    };
    sink(Rec { name, dir: is_dir })?;
  }
  Ok(())
}

fn write_run(recs: &[Rec], path: &Path) -> Result<(), String> {
  let file = File::create(path).map_err(io)?;
  let mut out = BufWriter::with_capacity(IO_BUF, file);
  let mut buf: Vec<u8> = Vec::with_capacity(IO_BUF);
  for rec in recs {
    encode(rec, &mut buf);
    if buf.len() >= IO_BUF {
      out.write_all(&buf).map_err(io)?;
      buf.clear();
    }
  }
  if !buf.is_empty() {
    out.write_all(&buf).map_err(io)?;
  }
  out.flush().map_err(io)?;
  Ok(())
}

/// k-way merge of sorted run bodies into `writer`, writing records from byte
/// `base` onwards. With a `sink` it reports the absolute offset of every record,
/// which is what turns "read page N" into one seek plus a short read.
fn merge_into(
  runs: &[PathBuf],
  writer: &mut BufWriter<File>,
  base: u64,
  mut sink: Option<&mut dyn FnMut(u64) -> Result<(), String>>,
) -> Result<(), String> {
  let mut readers: Vec<BufReader<File>> = Vec::with_capacity(runs.len());
  for run in runs {
    readers.push(BufReader::with_capacity(IO_BUF, File::open(run).map_err(io)?));
  }
  let mut heads: Vec<Option<Rec>> = Vec::with_capacity(readers.len());
  for reader in readers.iter_mut() {
    heads.push(decode(reader)?);
  }

  let mut buf: Vec<u8> = Vec::with_capacity(IO_BUF);
  let mut offset = base;
  loop {
    let mut best: Option<usize> = None;
    for i in 0..heads.len() {
      let Some(candidate) = heads[i].as_ref() else {
        continue;
      };
      match best {
        None => best = Some(i),
        Some(b) => {
          let incumbent = heads[b].as_ref().expect("best index has a head");
          if candidate.key(incumbent) == std::cmp::Ordering::Less {
            best = Some(i);
          }
        }
      }
    }
    let Some(pick) = best else { break };
    let rec = heads[pick].take().expect("pick index has a head");
    if let Some(sink) = sink.as_deref_mut() {
      sink(offset)?;
    }
    encode(&rec, &mut buf);
    offset += (5 + rec.name.len()) as u64;
    if buf.len() >= IO_BUF {
      writer.write_all(&buf).map_err(io)?;
      buf.clear();
    }
    heads[pick] = decode(&mut readers[pick])?;
  }
  if !buf.is_empty() {
    writer.write_all(&buf).map_err(io)?;
  }
  Ok(())
}

/// FNV-1a: stable across runs, cheap, dependency-free. Collisions would make one
/// directory shadow another's index, and the path stored in the header is what
/// catches it.
fn key_of(dir: &str) -> String {
  let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
  for byte in dir.as_bytes() {
    hash ^= *byte as u64;
    hash = hash.wrapping_mul(0x1000_0000_01b3);
  }
  format!("{hash:016x}")
}

pub struct DirIndexStore {
  index: Arc<DirIndex>,
}

/// Cloned before an `await` so the work can move to a blocking thread: building
/// an index for a directory with hundreds of thousands of entries is I/O plus
/// sorting, and on the main thread that is a frozen window.
pub fn shared(app: &AppHandle) -> Arc<DirIndex> {
  Arc::clone(&app.state::<DirIndexStore>().index)
}

pub fn store(app: &AppHandle) -> tauri::State<'_, DirIndexStore> {
  app.state::<DirIndexStore>()
}

impl DirIndexStore {
  pub fn invalidate(&self, dir: &str) {
    self.index.invalidate(dir);
  }
  pub fn invalidate_all(&self) {
    self.index.invalidate_all();
  }
}

pub fn init(app: &mut tauri::App) {
  let root = app
    .path()
    .app_cache_dir()
    .map(|p| p.join("dirindex"))
    .unwrap_or_else(|_| std::env::temp_dir().join("researchgo-dirindex"));
  let index = DirIndex::new(root);
  index.sweep();
  app.manage(DirIndexStore {
    index: Arc::new(index),
  });
}
#[cfg(test)]
mod tests {
  use super::*;

  /// A data directory plus an index cache kept *outside* it, so the cache's own
  /// subdirectories never show up as entries of the directory under test.
  struct Scratch {
    root: PathBuf,
    data: PathBuf,
    cache: PathBuf,
  }

  impl Scratch {
    fn new(tag: &str) -> Scratch {
      let root = std::env::temp_dir().join(format!("rg-dirindex-{tag}-{}", std::process::id()));
      let _ = fs::remove_dir_all(&root);
      let data = root.join("data");
      let cache = root.join("cache");
      fs::create_dir_all(&data).expect("scratch");
      Scratch { root, data, cache }
    }
    fn index(&self) -> DirIndex {
      DirIndex::new(self.cache.clone())
    }
    fn put(&self, name: &str, dir: bool) -> PathBuf {
      let target = self.data.join(name);
      if dir {
        fs::create_dir_all(&target).expect("mkdir");
      } else {
        fs::write(&target, b"x").expect("write");
      }
      target
    }
  }

  impl Drop for Scratch {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.root);
    }
  }

  fn names(page: &DirPage) -> Vec<String> {
    page.entries.iter().map(|e| e.name.clone()).collect()
  }

  #[test]
  fn small_directory_is_served_from_memory_in_sorted_order() {
    let scratch = Scratch::new("small");
    for name in ["b.rs", "a.rs", "C.rs"] {
      scratch.put(name, false);
    }
    scratch.put("sub", true);
    let index = scratch.index();
    let dir = scratch.data.to_string_lossy().to_string();
    let page = index.page(&dir, 0, 512).expect("page");
    // Directories first, then case-insensitive by name — the order the frontend
    // assumes when it patches a listing in place.
    assert_eq!(names(&page), vec!["sub", "a.rs", "b.rs", "C.rs"]);
    assert_eq!(page.total, 4);
    assert_eq!(page.files, 3);
    assert_eq!(page.dirs, 1);
    assert!(!page.has_more);
  }

  #[test]
  fn dot_directories_are_listed_because_the_build_lives_in_one() {
    // Compiling writes to `<project>/.rg/build`. A tree that hides dot entries
    // makes every build look like it produced nothing, so nothing is filtered out.
    let scratch = Scratch::new("dot");
    scratch.put(".rg", true);
    scratch.put(".gitignore", false);
    scratch.put("main.tex", false);
    let index = scratch.index();
    let dir = scratch.data.to_string_lossy().to_string();
    let page = index.page(&dir, 0, 512).expect("page");
    assert_eq!(names(&page), vec![".rg", ".gitignore", "main.tex"]);
    assert_eq!(page.total, 3);
  }

  #[test]
  fn pages_reassemble_into_the_whole_directory() {
    let scratch = Scratch::new("pages");
    for i in 0..25 {
      scratch.put(&format!("f{i:02}.rs"), false);
    }
    let index = scratch.index();
    let dir = scratch.data.to_string_lossy().to_string();

    let mut all: Vec<String> = Vec::new();
    let mut offset = 0usize;
    loop {
      let page = index.page(&dir, offset, 10).expect("page");
      assert_eq!(page.offset, offset);
      all.extend(names(&page));
      if !page.has_more {
        break;
      }
      offset = page.offset + page.entries.len();
      assert!(offset < 100, "paging must terminate");
    }
    let mut expected: Vec<String> = (0..25).map(|i| format!("f{i:02}.rs")).collect();
    expected.sort_by(|a, b| cmp_ci(a, b));
    assert_eq!(all, expected);
  }

  #[test]
  fn a_directory_larger_than_the_sort_chunk_spills_and_still_pages() {
    // The "theoretically unbounded" path: the listing does not fit in one chunk,
    // so it is sorted on disk in runs and merged. Chunk 4 with 25 entries forces
    // several merge levels.
    let scratch = Scratch::new("spill");
    for i in 0..25 {
      scratch.put(&format!("f{i:02}.rs"), false);
    }
    for i in 0..5 {
      scratch.put(&format!("d{i}"), true);
    }
    let index = scratch.index();
    let dir = scratch.data.to_string_lossy().to_string();
    let mtime = mtime_of(&scratch.data).unwrap();
    index.build_at(&dir, &scratch.data, mtime, 4).expect("build");

    assert!(!index.mem.lock().unwrap().map.contains_key(&dir));

    let mut all: Vec<String> = Vec::new();
    // Counts describe the whole listing, so every page must agree on them.
    let first = index.page(&dir, 0, 7).expect("page");
    assert_eq!((first.total, first.dirs, first.files), (30, 5, 25));
    let mut offset = 0usize;
    loop {
      let page = index.page(&dir, offset, 7).expect("page");
      assert_eq!((page.total, page.dirs, page.files), (first.total, first.dirs, first.files));
      all.extend(names(&page));
      if !page.has_more {
        break;
      }
      offset = page.offset + page.entries.len();
      assert!(offset <= 64, "paging must terminate");
    }
    let mut expected: Vec<String> = (0..25).map(|i| format!("f{i:02}.rs")).collect();
    for i in 0..5 {
      expected.push(format!("d{i}"));
    }
    expected.sort_by(|a, b| {
      let ad = a.starts_with('d') && a.len() == 2;
      let bd = b.starts_with('d') && b.len() == 2;
      bd
        .cmp(&ad)
        .then_with(|| cmp_ci(a, b))
        .then_with(|| a.cmp(b))
    });
    assert_eq!(all, expected, "spilled pages must reassemble in sorted order");

    // No run files may survive a successful build.
    let leftovers: Vec<_> = fs::read_dir(index.root.join("tmp"))
      .expect("tmp")
      .flatten()
      .map(|e| e.file_name().to_string_lossy().to_string())
      .collect();
    assert!(leftovers.is_empty(), "leftover runs: {leftovers:?}");
  }

  #[test]
  fn invalidate_makes_the_next_page_see_the_new_listing() {
    let scratch = Scratch::new("invalidate");
    scratch.put("a.rs", false);
    let index = scratch.index();
    let dir = scratch.data.to_string_lossy().to_string();
    assert_eq!(index.page(&dir, 0, 512).unwrap().total, 1);
    scratch.put("b.rs", false);
    index.invalidate(&dir);
    let page = index.page(&dir, 0, 512).unwrap();
    assert_eq!(names(&page), vec!["a.rs", "b.rs"]);
    assert_eq!(page.total, 2);
  }

  #[test]
  fn resident_memory_stays_under_its_ceiling() {
    let scratch = Scratch::new("mem");
    let mut dirs = Vec::new();
    for i in 0..12 {
      let name = format!("d{i}");
      scratch.put(&name, true);
      dirs.push(name);
    }
    let index = DirIndex::new(scratch.cache.clone());
    let mut mem = index.mem.lock().unwrap();
    mem.max_entries = 40;
    mem.max_dirs = 4;
    for name in &dirs {
      let path = scratch.data.join(name).to_string_lossy().to_string();
      let recs: Vec<Rec> = (0..10)
        .map(|i| Rec {
          name: format!("f{i}.rs"),
          dir: false,
        })
        .collect();
      mem.insert(&path, recs, 10, 0, 0);
    }
    assert!(mem.entries <= 40, "entries: {}", mem.entries);
    assert!(mem.map.len() <= 4, "dirs: {}", mem.map.len());
  }

  #[test]
  fn a_page_serializes_exactly_the_fields_the_frontend_reads() {
    // The IPC boundary, pinned by a test: `hasMore` in camelCase and the rest as
    // written, because the whole frontend half trusts these names.
    let page = DirPage {
      dir: "/a".into(),
      offset: 512,
      entries: vec![
        DirEntry {
          name: "b.rs".into(),
          path: "/a/b.rs".into(),
          kind: "file",
        },
        DirEntry {
          name: "sub".into(),
          path: "/a/sub".into(),
          kind: "dir",
        },
      ],
      total: 900_000,
      files: 899_999,
      dirs: 1,
      has_more: true,
    };
    let json = serde_json::to_value(&page).expect("serialize");
    assert_eq!(json["dir"], "/a");
    assert_eq!(json["offset"], 512);
    assert_eq!(json["entries"][0]["name"], "b.rs");
    assert_eq!(json["entries"][0]["path"], "/a/b.rs");
    assert_eq!(json["entries"][0]["kind"], "file");
    assert_eq!(json["entries"][1]["kind"], "dir");
    assert_eq!(json["total"], 900_000);
    assert_eq!(json["files"], 899_999);
    assert_eq!(json["dirs"], 1);
    assert_eq!(json["hasMore"], true);
  }

  #[test]
  fn a_missing_directory_is_an_error_not_an_empty_page() {
    let scratch = Scratch::new("missing");
    let index = scratch.index();
    let missing = scratch.data.join("nope").to_string_lossy().to_string();
    assert!(index.page(&missing, 0, 512).is_err());
  }
}
