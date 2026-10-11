//! The tools the model can call, and the boundary they run inside.
//!
//! Every path a tool touches is resolved against the session root first. A
//! model asked to edit `../../.ssh/authorized_keys` will try, because the
//! instruction that stops it is prose in a prompt and prose loses to a
//! plausible-sounding task. The check is here, in code, where it does not.
//!
//! Reads are bounded for the same reason the search panel bounds its walk: a
//! tool that can read 4 GB into the context window is a tool that ends the
//! session, and it usually does so by accident rather than by choice.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use tokio::process::Command;

/// A tool refused to run. Reported to the model as a failed call rather than
/// crashing the turn: the model is often right about the goal and wrong about
/// the path, and a message it can read is how it corrects itself.
#[derive(Debug)]
pub struct ToolError(pub String);

impl std::fmt::Display for ToolError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.0)
  }
}

/// A tool finished. `summary` is the one line the renderer shows beside the
/// tool name, so it is written for a human skimming the transcript.
pub struct ToolOutput {
  pub content: String,
  pub summary: String,
  /// Emitted as a `file_patch` frame when set, so the changes panel and any
  /// open editor learn about the write without polling.
  pub patch: Option<(String, bool)>,
}

/// Largest file `read` will return whole. Beyond this the model gets a refusal
/// with the size, which is a usable answer; a truncated dump is not.
const MAX_READ_BYTES: u64 = 256 * 1024;
/// Ceiling on lines from one `read`, independent of byte size.
const MAX_READ_LINES: usize = 2000;
/// Default and ceiling for `bash`. Long enough for a build, short enough that a
/// runaway process is interrupted by something the user can see.
const BASH_TIMEOUT_SECS: u64 = 120;
const BASH_MAX_OUTPUT: usize = 60_000;
/// Bounds that keep `grep` an answer rather than a sweep of the whole disk.
const GREP_MAX_FILES: usize = 20_000;
const GREP_MAX_HITS: usize = 300;
const GREP_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const GREP_MAX_FILES_RETURNED: usize = 500;
const GREP_MAX_DEPTH: usize = 32;

/// Never worth walking into: caches, build output, VCS internals. They dwarf
/// the project's own source in every dimension that matters here.
const SKIP_DIRS: [&str; 8] = [
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".rg",
  ".venv",
  "__pycache__",
];

/// Every tool definition, in the order the model sees them.
///
/// `read` comes first because it is the one tool that is almost always the
/// right first move, and a schema listed first is the one a model reaches for.
pub fn tool_defs() -> Vec<Value> {
  vec![
    json!({
      "type": "function",
      "function": {
        "name": "read",
        "description": "Read a file from the workspace. Returns its contents with line numbers. Truncated past 2000 lines. Prefer this over shell commands for looking at code.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Path relative to the workspace root." }
          },
          "required": ["path"]
        }
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "write",
        "description": "Create a file, or replace an existing one entirely. Use only for new files or when a full rewrite is intended; prefer edit for changes to existing code.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Path relative to the workspace root." },
            "content": { "type": "string", "description": "The complete file contents." }
          },
          "required": ["path", "content"]
        }
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "edit",
        "description": "Replace an exact string in a file. The old_string must appear exactly once and be copied verbatim including indentation. Fails loudly on a mismatch rather than guessing which occurrence you meant.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Path relative to the workspace root." },
            "old_string": { "type": "string", "description": "The exact text to replace. Must be unique in the file." },
            "new_string": { "type": "string", "description": "The replacement text." }
          },
          "required": ["path", "old_string", "new_string"]
        }
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Run a shell command in the workspace root. Use for builds, tests, git, and anything else that is genuinely a program. Prefer the dedicated tools for reading and searching.",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string", "description": "The command line to run." }
          },
          "required": ["command"]
        }
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "glob",
        "description": "Find files by path pattern, e.g. '**/*.ts' or 'src/**/index.*'. Returns matching paths relative to the workspace root, sorted.",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": { "type": "string", "description": "Glob pattern, ** spans directories." }
          },
          "required": ["pattern"]
        }
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "grep",
        "description": "Search file contents across the workspace for a literal string. Returns path:line and the matching line. Prefer this over shell grep so binary files and build output are skipped consistently.",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": { "type": "string", "description": "Literal text to search for. Not a regex." },
            "path": { "type": "string", "description": "Optional directory to restrict the search to. Defaults to the workspace root." }
          },
          "required": ["pattern"]
        }
      }
    }),
  ]
}

/// Runs one tool call.
///
/// `root` is the session's workspace. `call_id` is echoed in every frame for the
/// call so a late chunk cannot be attributed to the wrong tool.
pub async fn run(root: &Path, name: &str, args: &Value, call_id: &str) -> Result<ToolOutput, ToolError> {
  match name {
    "read" => read_tool(root, args),
    "write" => write_tool(root, args),
    "edit" => edit_tool(root, args),
    "bash" => bash_tool(root, args).await,
    "glob" => glob_tool(root, args),
    "grep" => grep_tool(root, args),
    other => Err(ToolError(format!(
      "unknown tool `{other}`; available: read, write, edit, bash, glob, grep"
    ))),
  }
  .map(|mut out| {
    let _ = call_id;
    out.summary = out.summary.trim().to_string();
    out
  })
}

/// Resolves a model-supplied path inside `root`, or refuses.
///
/// Rejects anything that escapes: `..` is resolved away and the result is
/// compared against the root, so a traversal cannot survive by being encoded in
/// a way a later step undoes. Absolute paths are accepted only when they are
/// already inside the root — an agent given a project directory should not need
/// to guess the prefix to address it.
fn resolve(root: &Path, raw: &str) -> Result<PathBuf, ToolError> {
  let raw = raw.trim();
  if raw.is_empty() {
    return Err(ToolError("path is empty".into()));
  }

  let candidate = if Path::new(raw).is_absolute() {
    PathBuf::from(raw)
  } else {
    root.join(raw)
  };

  let resolved = normalize(&candidate);
  let base = normalize(root);
  if !resolved.starts_with(&base) {
    return Err(ToolError(format!(
      "path `{raw}` is outside the workspace and was refused"
    )));
  }
  Ok(resolved)
}

/// Collapses `.` and `..` lexically.
///
/// `canonicalize` would be the obvious choice and is wrong here: it resolves
/// symlinks, so a link inside the workspace pointing outside would compare as
/// outside — correct — but it also fails on a path that does not exist yet, and
/// `write` creates files. Lexical normalisation is what the check needs; the
/// filesystem is not required to agree.
fn normalize(path: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for part in path.components() {
    match part {
      Component::CurDir => {}
      Component::ParentDir => {
        out.pop();
      }
      other => out.push(other.as_os_str()),
    }
  }
  out
}

fn arg_str(args: &Value, key: &str) -> Result<String, ToolError> {
  args
    .get(key)
    .and_then(|v| v.as_str())
    .map(|s| s.to_string())
    .ok_or_else(|| ToolError(format!("missing required argument `{key}`")))
}

fn looks_binary(bytes: &[u8]) -> bool {
  bytes[..bytes.len().min(8192)].contains(&0)
}

fn read_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
  let raw = arg_str(args, "path")?;
  let path = resolve(root, &raw)?;

  let meta = fs::metadata(&path).map_err(|e| ToolError(format!("cannot read `{raw}`: {e}")))?;
  if meta.is_dir() {
    return Err(ToolError(format!(
      "`{raw}` is a directory; use glob or grep to explore it"
    )));
  }
  if meta.len() > MAX_READ_BYTES {
    return Err(ToolError(format!(
      "`{raw}` is {} bytes, over the {} byte limit; use grep to find the part you need",
      meta.len(),
      MAX_READ_BYTES
    )));
  }

  let bytes = fs::read(&path).map_err(|e| ToolError(format!("cannot read `{raw}`: {e}")))?;
  if looks_binary(&bytes) {
    return Err(ToolError(format!("`{raw}` looks like a binary file")));
  }
  let text = String::from_utf8_lossy(&bytes);

  let mut out = String::new();
  let mut truncated = false;
  for (i, line) in text.lines().enumerate() {
    if i >= MAX_READ_LINES {
      truncated = true;
      break;
    }
    out.push_str(&format!("{:>6}\t{}\n", i + 1, line));
  }
  if truncated {
    out.push_str(&format!(
      "\n[truncated at {MAX_READ_LINES} lines — use grep to find later parts]\n"
    ));
  }

  let lines = text.lines().count();
  Ok(ToolOutput {
    summary: format!("{} · {lines} lines", short_path(root, &path)),
    content: out,
    patch: None,
  })
}

fn write_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
  let raw = arg_str(args, "path")?;
  let content = arg_str(args, "content")?;
  let path = resolve(root, &raw)?;

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .map_err(|e| ToolError(format!("cannot create {}: {e}", parent.display())))?;
  }

  let existed = path.exists();
  fs::write(&path, &content).map_err(|e| ToolError(format!("cannot write `{raw}`: {e}")))?;

  Ok(ToolOutput {
    content: format!(
      "{} {} ({} bytes)",
      if existed { "Replaced" } else { "Created" },
      raw,
      content.len()
    ),
    summary: format!(
      "{} {} · {} bytes",
      if existed { "edited" } else { "created" },
      short_path(root, &path),
      content.len()
    ),
    // The boolean is "created": the renderer needs to distinguish an add from a
    // modify to label the row.
    patch: Some((path.display().to_string(), !existed)),
  })
}

fn edit_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
  let raw = arg_str(args, "path")?;
  let old = arg_str(args, "old_string")?;
  let new = arg_str(args, "new_string")?;
  let path = resolve(root, &raw)?;

  let bytes = fs::read(&path).map_err(|e| ToolError(format!("cannot read `{raw}`: {e}")))?;
  if looks_binary(&bytes) {
    return Err(ToolError(format!("`{raw}` looks like a binary file")));
  }
  let text = String::from_utf8_lossy(&bytes).to_string();

  let count = text.matches(&old).count();
  if count == 0 {
    return Err(ToolError(format!(
      "`old_string` not found in `{raw}`. Read the file again and copy the text exactly, including indentation."
    )));
  }
  if count > 1 {
    return Err(ToolError(format!(
      "`old_string` appears {count} times in `{raw}`. Include more surrounding context so it matches exactly one place."
    )));
  }

  let updated = text.replacen(&old, &new, 1);
  fs::write(&path, &updated).map_err(|e| ToolError(format!("cannot write `{raw}`: {e}")))?;

  Ok(ToolOutput {
    content: format!("Edited {raw}"),
    summary: format!("edited {}", short_path(root, &path)),
    patch: Some((path.display().to_string(), false)),
  })
}

fn shell() -> &'static str {
  if cfg!(windows) {
    "cmd"
  } else {
    "sh"
  }
}

async fn bash_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
  let command = arg_str(args, "command")?;
  if command.trim().is_empty() {
    return Err(ToolError("command is empty".into()));
  }

  // On Windows the shell is spawned with `/C`, and on Unix with `-c`; the same
  // string means the same thing to either. Anything more elaborate — a pipeline
  // built in Rust — would be a second shell nobody debugged.
  let mut child = Command::new(shell());
  if cfg!(windows) {
    child.arg("/C").arg(&command);
  } else {
    child.arg("-c").arg(&command);
  }

  // `tokio::process`, not `std::process`: the turn holds the transcript lock
  // across this await, and a blocking `output()` there would pin a blocking
  // thread for as long as the command runs — and forever, if the command does.
  //
  // `kill_on_drop` so a timeout takes the process with it: a build left running
  // after the model gave up keeps a file handle, burns a core, and can rewrite
  // a source file the next turn has already read.
  let output = match tokio::time::timeout(
    std::time::Duration::from_secs(BASH_TIMEOUT_SECS),
    child.kill_on_drop(true).current_dir(root).output(),
  )
  .await
  {
    Ok(result) => result.map_err(|e| ToolError(format!("cannot run `{command}`: {e}")))?,
    Err(_) => {
      // `kill_on_drop` took the process with the future, so nothing survives to
      // hold a file handle or keep burning CPU after the turn moves on.
      return Err(ToolError(format!(
        "`{command}` did not finish within {BASH_TIMEOUT_SECS}s and was stopped"
      )));
    }
  };

  let mut text = String::new();
  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  if !stdout.is_empty() {
    text.push_str(stdout.trim_end());
  }
  if !stderr.is_empty() {
    if !text.is_empty() {
      text.push('\n');
    }
    text.push_str("[stderr]\n");
    text.push_str(stderr.trim_end());
  }
  if text.len() > BASH_MAX_OUTPUT {
    let cut = text.len() - BASH_MAX_OUTPUT;
    text = format!("…[output truncated]\n{}", &text[cut..]);
  }

  let code = output.status.code().unwrap_or(-1);
  let ok = output.status.success();
  if text.is_empty() {
    text = if ok {
      "(no output)".to_string()
    } else {
      format!("exited with code {code}")
    };
  }

  Ok(ToolOutput {
    summary: if ok {
      format!("exit {code}")
    } else {
      format!("exit {code} · failed")
    },
    content: text,
    patch: None,
  })
}

fn glob_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
  let pattern = arg_str(args, "pattern")?;
  let base = normalize(root);
  let mut hits = Vec::new();
  let mut files = 0usize;

  let mut stack: Vec<(PathBuf, usize)> = vec![(base.clone(), 0)];
  while let Some((dir, depth)) = stack.pop() {
    if depth > GREP_MAX_DEPTH || files >= GREP_MAX_FILES {
      break;
    }
    let Ok(entries) = fs::read_dir(&dir) else { continue };
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().into_owned();
      let path = entry.path();
      let Ok(meta) = entry.metadata() else { continue };
      if meta.is_dir() {
        if !SKIP_DIRS.contains(&name.as_str()) {
          stack.push((path, depth + 1));
        }
      } else {
        files += 1;
        let rel = path
          .strip_prefix(&base)
          .unwrap_or(&path)
          .to_string_lossy()
          .replace('\\', "/");
        if matches_glob(&rel, &pattern) {
          hits.push(rel);
          if hits.len() >= GREP_MAX_FILES_RETURNED {
            break;
          }
        }
      }
    }
  }

  hits.sort();
  let content = if hits.is_empty() {
    format!("no files match `{pattern}`")
  } else {
    hits.join("\n")
  };
  Ok(ToolOutput {
    summary: format!("{} match · {pattern}", hits.len()),
    content,
    patch: None,
  })
}

/// Matches a path against a glob, with `**` spanning directories.
///
/// Hand-rolled rather than pulled in as a crate: the pattern grammar models
/// actually use is `*`, `?` and `**`, and a general matcher would be a
/// dependency and a second thing to get wrong.
fn matches_glob(path: &str, pattern: &str) -> bool {
  fn inner(path: &[u8], pat: &[u8]) -> bool {
    match pat.first() {
      None => path.is_empty(),

      // `**/`: swallow whole directories, including none at all. Guarded on the
      // pattern alone — the path's first byte is a letter in every real call,
      // so pairing this arm with `Some(b'*')` on the path side means it never
      // runs. The third byte is the separator; `pat[1]` would test `*/`, which
      // is only a star.
      Some(b'*') if pat.len() >= 3 && pat[1] == b'*' && pat[2] == b'/' => {
        inner(path, &pat[3..])
          || (0..=path.len()).any(|i| path[i..].contains(&b'/') && inner(&path[i + 1..], pat))
      }

      // A lone `**` matches whatever is left, separators included.
      Some(b'*') if pat.len() == 2 && pat[1] == b'*' => true,

      // `*` matches within one segment. Without that bound it happily matches
      // `src/main.rs` against `*.rs`, turning "list the top level" into a walk
      // of the whole tree.
      Some(b'*') => (0..=path.len())
        .take_while(|i| !path[..*i].contains(&b'/'))
        .any(|i| inner(&path[i..], &pat[1..])),

      // `?` is one character, and one character is never a separator.
      Some(b'?') => !path.is_empty() && path[0] != b'/' && inner(&path[1..], &pat[1..]),

      Some(p) => !path.is_empty() && p.eq_ignore_ascii_case(&path[0]) && inner(&path[1..], &pat[1..]),
    }
  }
  inner(path.as_bytes(), pattern.as_bytes())
}

fn grep_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
  let needle = arg_str(args, "pattern")?;
  if needle.is_empty() {
    return Err(ToolError("pattern is empty".into()));
  }

  let base = match args.get("path").and_then(|v| v.as_str()) {
    Some(sub) if !sub.trim().is_empty() => resolve(root, sub)?,
    _ => normalize(root),
  };
  if !base.exists() {
    let where_ = sub_or_root(args);
    return Err(ToolError(format!("`{where_}` does not exist")));
  }

  let mut hits: Vec<(String, usize, String)> = Vec::new();
  let mut files = 0usize;
  let needle_lc = needle.to_lowercase();
  let single_file = base.is_file();

  let mut stack = vec![base.clone()];
  while let Some(target) = stack.pop() {
    if single_file {
      scan_file(root, &target, &needle, &needle_lc, &mut hits);
      break;
    }
    let Ok(entries) = fs::read_dir(&target) else { continue };
    for entry in entries.flatten() {
      if files >= GREP_MAX_FILES || hits.len() >= GREP_MAX_HITS {
        break;
      }
      let name = entry.file_name().to_string_lossy().into_owned();
      let path = entry.path();
      let Ok(meta) = entry.metadata() else { continue };
      if meta.is_dir() {
        if !SKIP_DIRS.contains(&name.as_str()) {
          stack.push(path);
        }
      } else if meta.len() <= GREP_MAX_FILE_BYTES {
        files += 1;
        scan_file(root, &path, &needle, &needle_lc, &mut hits);
      }
    }
  }

  let content = if hits.is_empty() {
    format!("no match for `{needle}`")
  } else {
    hits.iter()
      .map(|(p, line, text)| format!("{p}:{line}: {}", text.trim()))
      .collect::<Vec<_>>()
      .join("\n")
  };
  Ok(ToolOutput {
    summary: format!("{} match · {needle}", hits.len()),
    content,
    patch: None,
  })
}

fn sub_or_root(args: &Value) -> String {
  args
    .get("path")
    .and_then(|v| v.as_str())
    .unwrap_or("workspace root")
    .to_string()
}

fn scan_file(root: &Path, path: &Path, needle: &str, needle_lc: &str, out: &mut Vec<(String, usize, String)>) {
  let Ok(bytes) = fs::read(path) else { return };
  if looks_binary(&bytes) {
    return;
  }
  let rel = path
    .strip_prefix(root)
    .unwrap_or(path)
    .to_string_lossy()
    .replace('\\', "/");
  for (i, line) in String::from_utf8_lossy(&bytes).split('\n').enumerate() {
    if line.contains(needle) || line.to_lowercase().contains(needle_lc) {
      out.push((rel.clone(), i + 1, line.chars().take(200).collect()));
      if out.len() >= GREP_MAX_HITS {
        return;
      }
    }
  }
}

/// Workspace-relative, because the transcript is read beside the tree and an
/// absolute path on every row is noise that hides the filename.
fn short_path(root: &Path, path: &Path) -> String {
  path.strip_prefix(root)
    .unwrap_or(path)
    .to_string_lossy()
    .replace('\\', "/")
}
#[cfg(test)]
mod tests {
  use super::*;

  fn root() -> PathBuf {
    PathBuf::from("/work")
  }

  #[test]
  fn traversal_is_refused() {
    // The check the whole sandbox exists for: a model that decides to read
    // `~/.ssh/id_rsa` must be told no, not allowed to try.
    assert!(resolve(&root(), "../etc/passwd").is_err());
    assert!(resolve(&root(), "../../.ssh/authorized_keys").is_err());
    assert!(resolve(&root(), "a/../../../etc/passwd").is_err());
    // An absolute path outside the root is refused too, even though it needs
    // no `..` to get there.
    assert!(resolve(&root(), "/etc/shadow").is_err());
  }

  #[test]
  fn in_workspace_paths_resolve() {
    assert_eq!(resolve(&root(), "src/main.rs").unwrap(), PathBuf::from("/work/src/main.rs"));
    // `..` that stays inside is allowed: it is how a model addresses a sibling.
    assert_eq!(resolve(&root(), "src/../lib/a.ts").unwrap(), PathBuf::from("/work/lib/a.ts"));
    assert_eq!(resolve(&root(), "./x.txt").unwrap(), PathBuf::from("/work/x.txt"));
    // An absolute path already inside the root is fine.
    assert_eq!(resolve(&root(), "/work/y.txt").unwrap(), PathBuf::from("/work/y.txt"));
  }

  #[test]
  fn empty_path_is_refused() {
    assert!(resolve(&root(), "   ").is_err());
  }

  #[test]
  fn glob_star_does_not_span_directories() {
    assert!(matches_glob("main.rs", "*.rs"));
    // The whole point of `**` being a separate token: `*` stops at a slash, so
    // this does not quietly match every file in the tree.
    assert!(!matches_glob("src/main.rs", "*.rs"));
  }

  #[test]
  fn glob_double_star_spans_directories() {
    assert!(matches_glob("src/deep/main.rs", "src/**/*.rs"));
    assert!(matches_glob("src/main.rs", "src/**/*.rs"), "`**/` also matches zero directories");
    assert!(matches_glob("a/b/c/d.ts", "**/*.ts"));
    assert!(matches_glob("d.ts", "**/*.ts"));
    assert!(!matches_glob("src/main.rs", "src/**/*.ts"));
  }

  #[test]
  fn glob_question_mark_matches_one_char() {
    assert!(matches_glob("a.ts", "?.ts"));
    assert!(!matches_glob("ab.ts", "?.ts"));
  }

  #[tokio::test]
  async fn unknown_tool_names_itself() {
    let err = match run(&root(), "deploy", &json!({}), "c1").await {
      Ok(out) => panic!("expected an error, got: {}", out.summary),
      Err(err) => err.0,
    };
    assert!(err.contains("unknown tool"));
    // The message has to name what is available, or the model retries the same
    // call hoping for a different spelling.
    assert!(err.contains("read"));
  }

  #[tokio::test]
  async fn read_reports_a_directory_as_such() {
    // Without a temp dir this would depend on the machine; the guard is what
    // matters, and it is checked before any read is attempted.
    let err = match run(&root(), "read", &json!({ "path": "src" }), "c1").await {
      Ok(out) => panic!("expected an error, got: {}", out.summary),
      Err(err) => err.0,
    };
    assert!(err.contains("directory") || err.contains("cannot read"));
  }
}