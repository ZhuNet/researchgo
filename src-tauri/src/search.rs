use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
  pub path: String,
  pub line: usize,
  pub text: String,
}

/// Never worth searching: dependency caches, build output, VCS internals.
/// They dwarf the project's own source in every dimension that matters here.
const SKIP_DIRS: [&str; 6] = [".git", "node_modules", "target", "dist", "build", ".rg"];
/// Bounds that keep the answer a heartbeat, not a grind through a monorepo.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_HITS: usize = 500;
/// A NUL byte this early is the same "not text" verdict the editor's sniff gives.
const SNIFF: usize = 8192;

fn looks_binary(bytes: &[u8]) -> bool {
  bytes[..bytes.len().min(SNIFF)].contains(&0)
}

fn search_file(
  path: &Path,
  needle: &str,
  needle_lc: &str,
  case_sensitive: bool,
  out: &mut Vec<SearchHit>,
) {
  let Ok(bytes) = fs::read(path) else { return };
  if looks_binary(&bytes) {
    return;
  }
  let text = String::from_utf8_lossy(&bytes);
  for (i, line) in text.split('\n').enumerate() {
    let matched = if case_sensitive {
      line.contains(needle)
    } else {
      line.to_lowercase().contains(needle_lc)
    };
    if matched {
      out.push(SearchHit {
        path: path.display().to_string(),
        line: i + 1,
        text: line.trim().chars().take(200).collect(),
      });
      if out.len() >= MAX_HITS {
        return;
      }
    }
  }
}

fn walk(root: &Path, needle: &str, needle_lc: &str, case_sensitive: bool) -> Vec<SearchHit> {
  let mut out = Vec::new();
  let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
  let mut files = 0usize;
  let mut total = 0u64;
  while let Some(dir) = stack.pop() {
    let Ok(entries) = fs::read_dir(&dir) else { continue };
    for entry in entries.flatten() {
      if files >= MAX_FILES || total >= MAX_TOTAL_BYTES || out.len() >= MAX_HITS {
        return out;
      }
      let Ok(meta) = entry.metadata() else { continue };
      let path = entry.path();
      if meta.is_dir() {
        let name = entry.file_name();
        if !SKIP_DIRS.contains(&name.to_string_lossy().as_ref()) {
          stack.push(path);
        }
      } else {
        if meta.len() > MAX_FILE_BYTES {
          continue;
        }
        files += 1;
        total += meta.len();
        search_file(&path, needle, needle_lc, case_sensitive, &mut out);
      }
    }
  }
  out
}

/// Full-text search over the whole workspace, off the UI thread. The frontend
/// used to search only files it had open as tabs, which answered "no results"
/// for anything the reader had not happened to open.
#[tauri::command]
pub async fn search_workspace(
  root: String,
  query: String,
  case_sensitive: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
  let needle = query.trim().to_string();
  if needle.is_empty() {
    return Ok(Vec::new());
  }
  tauri::async_runtime::spawn_blocking(move || {
    let case_sensitive = case_sensitive.unwrap_or(false);
    let needle_lc = needle.to_lowercase();
    walk(Path::new(&root), &needle, &needle_lc, case_sensitive)
  })
  .await
  .map_err(|e| format!("search_workspace task failed: {e}"))
}
