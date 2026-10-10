use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::dirindex::{self, DirPage, DEFAULT_PAGE};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFolder {
  pub path: String,
  pub name: String,
  pub page: DirPage,
}

/// Whether new entries can be created directly inside `dir`.
///
/// `access(W_OK)` is the only reliable test: permission bits lie under ACLs,
/// read-only mounts and group ownership, and guessing wrong means the UI offers
/// an action that then fails with a bare EACCES.
#[cfg(unix)]
pub fn dir_writable(dir: &str) -> bool {
  match std::ffi::CString::new(dir) {
    Ok(c) => unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 },
    Err(_) => false,
  }
}

/// Windows does not expose POSIX `access(W_OK)`. Probe the operation the UI
/// needs to perform instead, using a unique file and removing it immediately.
#[cfg(windows)]
pub fn dir_writable(dir: &str) -> bool {
  use std::sync::atomic::{AtomicU64, Ordering};

  static NEXT_PROBE: AtomicU64 = AtomicU64::new(0);

  let probe = Path::new(dir).join(format!(
    ".researchgo-write-check-{}-{}",
    std::process::id(),
    NEXT_PROBE.fetch_add(1, Ordering::Relaxed)
  ));
  match fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
    Ok(file) => {
      drop(file);
      fs::remove_file(probe).is_ok()
    }
    Err(_) => false,
  }
}

fn kind_of(meta: &fs::Metadata) -> &'static str {
  if meta.is_dir() {
    "dir"
  } else {
    "file"
  }
}

/// One page of one directory. `offset` is an index into the stable sorted order,
/// so pages compose into a complete listing without ever holding it all at once.
///
/// Asynchronous and off-thread on purpose: the first page of a very large
/// directory means sorting it, and that must not run where it freezes the window.
#[tauri::command]
pub async fn list_dir_page(
  app: tauri::AppHandle,
  path: String,
  offset: Option<usize>,
  limit: Option<usize>,
) -> Result<DirPage, String> {
  let index = dirindex::shared(&app);
  tauri::async_runtime::spawn_blocking(move || {
    index.page(&path, offset.unwrap_or(0), limit.unwrap_or(DEFAULT_PAGE))
  })
  .await
  .map_err(|e| format!("list_dir_page task failed: {e}"))?
}

/// Forgets one directory's cached pages. Used when the frontend knows the disk
/// moved in a way the watcher cannot see (a move across directories).
#[tauri::command]
pub fn invalidate_dir(app: tauri::AppHandle, path: String) {
  dirindex::store(&app).invalidate(&path);
}

/// Forgets every cached page. Used when a workspace is closed: the next folder
/// opened may share paths with the old one, and it starts from a cold index.
#[tauri::command]
pub fn clear_dir_index(app: tauri::AppHandle) {
  dirindex::store(&app).invalidate_all();
}

#[tauri::command]
pub async fn open_folder(
  app: tauri::AppHandle,
  path: String,
  limit: Option<usize>,
) -> Result<OpenedFolder, String> {
  let index = dirindex::shared(&app);
  tauri::async_runtime::spawn_blocking(move || {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
      return Err(format!("not a directory: {path}"));
    }
    let name = dir
      .file_name()
      .map(|s| s.to_string_lossy().to_string())
      .unwrap_or_else(|| path.clone());
    let page = index.page(&path, 0, limit.unwrap_or(DEFAULT_PAGE))?;
    Ok(OpenedFolder { path, name, page })
  })
  .await
  .map_err(|e| format!("open_folder task failed: {e}"))?
}

/// Up to 8 MiB off the UI thread: reading it on the main thread is a visible
/// freeze, and the editor has no reason to wait for the window.
#[tauri::command]
pub async fn read_file(path: String, max_bytes: Option<u64>) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let limit = max_bytes.unwrap_or(8 * 1024 * 1024);
    let meta = fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > limit {
      return Err(format!("file too large: {} bytes", meta.len()));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read failed: {e}"))?;
    match String::from_utf8(bytes) {
      Ok(text) => Ok(text),
      Err(err) => Ok(String::from_utf8_lossy(err.as_bytes()).to_string()),
    }
  })
  .await
  .map_err(|e| format!("read_file task failed: {e}"))?
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<u64, String> {
  let bytes = content.into_bytes();
  let len = bytes.len() as u64;
  fs::write(&path, bytes).map_err(|e| format!("write failed: {e}"))?;
  Ok(len)
}

#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
  use tauri_plugin_dialog::DialogExt;
  let (tx, rx) = std::sync::mpsc::channel();
  app.dialog().file().pick_folder(move |picked| {
    let _ = tx.send(picked);
  });
  let picked = rx
    .recv()
    .map_err(|_| "folder picker closed unexpectedly".to_string())?;
  Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
pub fn can_write(path: String) -> bool {
  dir_writable(&path)
}

#[tauri::command]
pub fn path_kind(path: String) -> Result<&'static str, String> {
  let meta = fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
  Ok(kind_of(&meta))
}
/// After a mutation the directory's cached pages are stale. Dropping them here
/// rather than waiting for an mtime comparison matters on filesystems with
/// one-second timestamp granularity: a create followed by a read inside the same
/// second would otherwise be answered from the pre-create index.
#[tauri::command]
pub fn create_entry(
  app: tauri::AppHandle,
  dir: String,
  name: String,
  kind: String,
) -> Result<(), String> {
  if name.trim().is_empty() || name.contains('/') || name == "." || name == ".." {
    return Err(format!("invalid name: {name:?}"));
  }
  let target = Path::new(&dir).join(&name);
  if target.exists() {
    return Err(format!("already exists: {}", target.display()));
  }
  let result = if kind == "dir" {
    fs::create_dir(&target).map_err(|e| e.to_string())
  } else {
    fs::File::create(&target).map(|_| ()).map_err(|e| e.to_string())
  };
  if let Err(err) = &result {
    let msg = format!("{err} (目标: {})", target.display());
    log::warn!("create_entry failed: {msg}");
    return Err(msg);
  }
  dirindex::store(&app).invalidate(&dir);
  Ok(())
}

#[tauri::command]
pub fn rename_entry(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
  // A rename that only changes case ("Readme.md" -> "README.md") targets the
  // same entry, but Windows resolves paths case-insensitively, so a plain
  // `exists()` rejects it. Canonicalized paths agree only for the same file,
  // so that comparison is the "already exists" that still lets case through.
  let same_entry = match (fs::canonicalize(&from), fs::canonicalize(&to)) {
    (Ok(a), Ok(b)) => a == b,
    _ => false,
  };
  if !same_entry && Path::new(&to).exists() {
    return Err(format!("already exists: {to}"));
  }
  fs::rename(&from, &to).map_err(|e| format!("rename failed: {e}"))?;
  let state = dirindex::store(&app);
  // Both parents changed, and the moved directory's own pages are now keyed by a
  // path that no longer exists.
  for parent in [parent_of(&from), parent_of(&to)] {
    if let Some(parent) = parent {
      state.invalidate(&parent);
    }
  }
  state.invalidate(&from);
  state.invalidate(&to);
  Ok(())
}

#[tauri::command]
pub fn remove_entry(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let target = Path::new(&path);
  let meta = fs::symlink_metadata(target).map_err(|e| format!("stat failed: {e}"))?;
  let removed = if meta.is_dir() {
    fs::remove_dir_all(target).map_err(|e| format!("remove_dir failed: {e}"))
  } else {
    fs::remove_file(target).map_err(|e| format!("remove failed: {e}"))
  };
  if removed.is_ok() {
    let state = dirindex::store(&app);
    if let Some(parent) = parent_of(&path) {
      state.invalidate(&parent);
    }
    state.invalidate(&path);
  }
  removed
}

fn parent_of(path: &str) -> Option<String> {
  let trimmed = path.trim_end_matches('/');
  if trimmed.is_empty() {
    return None;
  }
  match trimmed.rfind('/') {
    None => Some("/".to_string()),
    Some(0) => Some("/".to_string()),
    Some(cut) => Some(trimmed[..cut].to_string()),
  }
}

/// Depth cap for `copy_tree`. `fs::metadata` follows symlinks, so a link that
/// points at an ancestor would otherwise recurse until the disk fills.
const COPY_DEPTH_LIMIT: usize = 64;

/// The first free target for `name` inside `dir`, suffixing " (n)" on collision.
///
/// A drop has no confirmation step, so the safe outcome of a collision is a new
/// name — never an overwrite.
fn unique_target(dir: &Path, name: &OsStr) -> Result<PathBuf, String> {
  let first = dir.join(name);
  if !first.exists() {
    return Ok(first);
  }
  let lossy = name.to_string_lossy();
  // A leading dot belongs to the name (".gitignore" has no extension).
  let (stem, ext) = match lossy.rfind('.') {
    Some(at) if at > 0 => (lossy[..at].to_string(), lossy[at..].to_string()),
    _ => (lossy.to_string(), String::new()),
  };
  for n in 1..1000 {
    let candidate = dir.join(format!("{stem} ({n}){ext}"));
    if !candidate.exists() {
      return Ok(candidate);
    }
  }
  Err(format!("too many copies of the same name in {}", dir.display()))
}

fn copy_tree(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
  if depth > COPY_DEPTH_LIMIT {
    return Err(format!("copy too deep (symlink loop?): {}", src.display()));
  }
  let meta = fs::metadata(src).map_err(|e| format!("stat failed: {} ({e})", src.display()))?;
  if meta.is_dir() {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir failed: {} ({e})", dst.display()))?;
    let entries =
      fs::read_dir(src).map_err(|e| format!("read_dir failed: {} ({e})", src.display()))?;
    for entry in entries {
      let entry = entry.map_err(|e| format!("read_dir failed: {} ({e})", src.display()))?;
      copy_tree(&entry.path(), &dst.join(entry.file_name()), depth + 1)?;
    }
  } else {
    fs::copy(src, dst).map_err(|e| format!("copy failed: {} ({e})", src.display()))?;
  }
  Ok(())
}

/// Copies files or whole directories from anywhere on the host into `dest`, as
/// a drop from the host's file manager does. Returns the paths it wrote, after
/// collision renaming.
#[tauri::command]
pub async fn copy_into(
  app: tauri::AppHandle,
  dest: String,
  sources: Vec<String>,
) -> Result<Vec<String>, String> {
  let index_dest = dest.clone();
  let copied = tauri::async_runtime::spawn_blocking(move || {
    let dest_dir = PathBuf::from(&dest);
    if !dest_dir.is_dir() {
      return Err(format!("not a directory: {dest}"));
    }
    let mut copied = Vec::with_capacity(sources.len());
    for src in sources {
      let source = PathBuf::from(&src);
      let name = source.file_name().ok_or_else(|| format!("cannot copy: {src}"))?;
      let target = unique_target(&dest_dir, name)?;
      // A folder dropped into its own subtree would recurse until the depth cap
      // and fill the disk with copies of copies.
      if target.starts_with(&source) {
        return Err(format!("cannot copy a folder into itself: {src}"));
      }
      if let Err(err) = copy_tree(&source, &target, 0) {
        // Leave no half-copied folder behind: the next drop of the same name
        // would silently become "name (1)".
        let _ = fs::remove_dir_all(&target).or_else(|_| fs::remove_file(&target));
        return Err(err);
      }
      copied.push(target.to_string_lossy().to_string());
    }
    Ok(copied)
  })
  .await
  .map_err(|e| format!("copy_into task failed: {e}"))??;
  dirindex::store(&app).invalidate(&index_dest);
  Ok(copied)
}
