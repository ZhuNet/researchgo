//! The tools the model can call, and the boundary they run inside.
//!
//! Every path a tool touches is resolved against the conversation's root
//! first. A model asked to edit `../../.ssh/authorized_keys` will try, because
//! the instruction that stops it is prose in a prompt and prose loses to a
//! plausible-sounding task. The check is here, in code, where it does not.
//!
//! Reads are bounded for the same reason the search panel bounds its walk: a
//! tool that can read 4 GB into the context window is a tool that ends the
//! turn, and it usually does so by accident rather than by choice.

use std::fs;
use std::path::{Component, Path, PathBuf};

use globset::{GlobBuilder, GlobMatcher};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
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
  /// Whether the tool's *work* succeeded, which is not the same as whether the
  /// call did.
  ///
  /// A command that ran and exited non-zero is the case this exists for:
  /// collapsing it into a `ToolError` would throw away the stdout and stderr
  /// the model needs in order to fix its own command, and reporting it as a
  /// plain success is worse — the transcript claims a test suite passed that
  /// failed, and the model has no reason to look again. So the call succeeds,
  /// the content comes back whole, and the row is drawn as a failure.
  pub ok: bool,
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
        "description": format!(
          "Run a shell command in the workspace root. {} \
           Prefer the read, grep and glob tools over shelling out to cat, grep \
           and find: they are not a shell, so they are unaffected by all of the \
           above. A command that exits non-zero comes back as a failed call with \
           its output attached rather than as an error — read that output before \
           retrying.",
          dialect()
        ),
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string", "description": format!("The command line to run. {}", dialect()) }
          },
          "required": ["command"]
        }
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "glob",
        "description": "Find files with globset patterns: *, ?, **, character classes and {ts,tsx} alternatives. * and ? do not cross directories; ? matches one byte, so use * for Chinese filenames. Case-sensitive by default. Honors .gitignore/.ignore, includes hidden files, skips build/cache directories and directory links. Returns sorted workspace-relative paths and reports truncation.",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": { "type": "string", "description": "Glob pattern relative to the workspace root; ** spans directories." },
            "caseSensitive": { "type": "boolean", "description": "Defaults to true." },
            "respectIgnore": { "type": "boolean", "description": "Honor ignore files; defaults to true. False still skips build/cache directories." }
          },
          "required": ["pattern"]
        }
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "grep",
        "description": "Search file contents using ripgrep's Rust regex engine, one line at a time. Case-sensitive regex by default; literal=true searches exact text. Honors .gitignore/.ignore, includes hidden files, skips binary files, files over 2 MiB, build/cache directories and directory links. Returns workspace-relative path:line and matching text; reports limits and shortened lines. Invalid regex returns a tool error.",
        "parameters": {
          "type": "object",
          "properties": {
            "pattern": { "type": "string", "description": "Rust regular expression, or literal text when literal=true. No lookaround or backreferences." },
            "path": { "type": "string", "description": "Optional file or directory to search. Defaults to the workspace root." },
            "literal": { "type": "boolean", "description": "Treat pattern as literal text; defaults to false." },
            "caseSensitive": { "type": "boolean", "description": "Defaults to true." },
            "include": { "type": "string", "description": "Optional glob matching workspace-relative paths, e.g. **/*.{ts,tsx}." },
            "respectIgnore": { "type": "boolean", "description": "Honor ignore files; defaults to true. False still skips build/cache directories. Explicit files are searched regardless of ignore rules." }
          },
          "required": ["pattern"]
        }
      }
    }),
  ]
}

/// Runs one tool call.
///
/// `root` is the workspace the conversation is running in. `call_id` is echoed
/// in every frame for the call so a late chunk cannot be attributed to the
/// wrong tool.
pub async fn run(root: &Path, name: &str, args: &Value, call_id: &str) -> Result<ToolOutput, ToolError> {
  if matches!(name, "glob" | "grep") {
    let root = root.to_path_buf();
    let args = args.clone();
    let name = name.to_string();
    return tokio::task::spawn_blocking(move || {
      if name == "glob" { glob_tool(&root, &args) } else { grep_tool(&root, &args) }
    }).await.map_err(|e| ToolError(format!("search task failed: {e}")))?;
  }
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
    ok: true,
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
    ok: true,
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
    ok: true,
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

/// The command dialect the model must write for the machine it is running on.
///
/// This is the single most valuable fact in the tool list and it was the one
/// thing missing. A model asked to run a command has exactly one strong prior:
/// `bash` on Linux, learned from a training set that is overwhelmingly
/// POSIX. Nothing in the prompt contradicts it, so `ls -la`, `cat`, `rm -rf`,
/// `$HOME` and `&&` go out unchanged — and on `cmd.exe` every one of them fails,
/// with an error that names the command rather than the shell, so the model has
/// no way to work out that the whole batch was written for the wrong machine and
/// retries the same syntax until the turn is over.
///
/// So the dialect is stated where the model is already looking when it decides
/// what to type, in the one tool it is about to call. The substitutions are
/// named as pairs (`ls` → `dir`) rather than described, because a model copying
/// a table acts on it and a model reading prose has to infer it.
fn dialect() -> &'static str {
  if cfg!(windows) {
    "The command runs in cmd.exe on Windows, not PowerShell and not bash. \
     Use dir instead of ls, type instead of cat, del and rmdir instead of rm, \
     copy and move instead of cp and mv, findstr instead of grep, and \
     xcopy or robocopy for a recursive copy. Variables expand as %VAR%, not \
     $VAR. Quote paths containing spaces with double quotes. Chain with && or \
     &, redirect stdout and stderr with > and 2>, and branch on failure with \
     `if errorlevel 1`. There is no touch, no which, no heredoc, and no shell \
     glob — dir /s and dir /b are the closest. Commands that ship their own \
     executable (npm, cargo, git, python, node) are called by name and behave \
     as they do elsewhere."
  } else {
    "The command runs in sh on a POSIX system. Use POSIX syntax only: && and | \
     and > and 2> all work, but [[ ]], arrays, local, source, process \
     substitution <(...) and $(< file) do not — use [ ], plain variables, \
     `. file` and $(cat file). Commands that ship their own executable (npm, \
     cargo, git, python) are called by name and behave as they do elsewhere."
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
    let mut cut = text.len() - BASH_MAX_OUTPUT;
    while !text.is_char_boundary(cut) {
      cut += 1;
    }
    text = format!("…[output truncated]\n{}", &text[cut..]);
  }

  let code = output.status.code().unwrap_or(-1);
  let ok = output.status.success();

  // A non-zero exit is reported to the model as output, because that is the
  // only channel it reads. Without the line a command that printed a
  // reassuring log and then died — `npm test` with two failing cases, a
  // `git diff --quiet` finding changes — looks byte-identical to one that
  // worked, and the model moves on believing a failing build passed.
  if !ok {
    text = if text.is_empty() {
      format!("command failed with status {code}")
    } else {
      format!("command failed with status {code}\n{text}")
    };
  } else if text.is_empty() {
    text = "(no output)".to_string();
  }

  Ok(ToolOutput {
    ok,
    // No exit code in the row: the tick or the cross beside the tool name
    // already says whether the command worked, and restating it as `exit 0`
    // on every successful row is noise between the reader and the output.
    // The code is still in the content, where the model needs it.
    summary: String::new(),
    content: text,
    patch: None,
  })
}

fn glob_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
  let pattern = arg_str(args, "pattern")?;
  let matcher = compile_glob(&pattern, arg_bool(args, "caseSensitive", true)?)?;
  let base = normalize(root);
  let mut hits = Vec::new();
  let mut files = 0usize;
  let mut truncated = false;
  for entry in workspace_walk(&base, arg_bool(args, "respectIgnore", true)?) {
    let entry = entry.map_err(|e| ToolError(format!("cannot walk workspace: {e}")))?;
    if !entry.file_type().is_some_and(|t| t.is_file()) { continue; }
    files += 1;
    let rel = relative(&base, entry.path());
    if matcher.is_match(&rel) { hits.push(rel); }
    if files >= GREP_MAX_FILES || hits.len() >= GREP_MAX_FILES_RETURNED {
      truncated = true;
      break;
    }
  }

  hits.sort();
  let content = if hits.is_empty() {
    format!("no files match `{pattern}`")
  } else {
    hits.join("\n")
  };
  let content = if truncated { format!("{content}\n[results truncated by workspace limits]") } else { content };
  Ok(ToolOutput {
    ok: true,
    summary: format!("{} match{} · {pattern}", hits.len(), if truncated { " · truncated" } else { "" }),
    content,
    patch: None,
  })
}

fn compile_glob(pattern: &str, case_sensitive: bool) -> Result<GlobMatcher, ToolError> {
  GlobBuilder::new(pattern).literal_separator(true).backslash_escape(true)
    .case_insensitive(!case_sensitive).build()
    .map(|glob| glob.compile_matcher())
    .map_err(|e| ToolError(format!("invalid glob `{pattern}`: {e}")))
}

fn arg_bool(args: &Value, key: &str, default: bool) -> Result<bool, ToolError> {
  match args.get(key) {
    None => Ok(default),
    Some(value) => value.as_bool().ok_or_else(|| ToolError(format!("`{key}` must be a boolean"))),
  }
}

fn workspace_walk(root: &Path, respect_ignore: bool) -> ignore::Walk {
  WalkBuilder::new(root)
    .hidden(false)
    .ignore(respect_ignore)
    .git_ignore(respect_ignore)
    .git_global(respect_ignore)
    .git_exclude(respect_ignore)
    .require_git(false)
    .follow_links(false)
    .sort_by_file_path(|a, b| a.cmp(b))
    .filter_entry(|entry| entry.depth() == 0 || !entry.file_type().is_some_and(|t| t.is_dir())
      || !SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()))
    .build()
}

fn relative(root: &Path, path: &Path) -> String {
  path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
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

  let matcher = RegexMatcherBuilder::new()
    .case_insensitive(!arg_bool(args, "caseSensitive", true)?)
    .fixed_strings(arg_bool(args, "literal", false)?)
    .line_terminator(Some(b'\n'))
    .crlf(true)
    .multi_line(true)
    .build(&needle)
    .map_err(|e| ToolError(format!("invalid regular expression `{needle}`: {e}")))?;
  let include = match args.get("include") {
    None => None,
    Some(value) => Some(compile_glob(value.as_str().ok_or_else(|| ToolError("`include` must be a string".into()))?, arg_bool(args, "caseSensitive", true)?)?),
  };
  let mut hits = Vec::new();
  let mut files = 0usize;
  let mut truncated = false;
  let mut skipped_large = 0;
  let mut shortened = false;
  let mut searcher = SearcherBuilder::new()
    .line_terminator(grep_matcher::LineTerminator::crlf())
    .binary_detection(grep_searcher::BinaryDetection::quit(b'\0')).line_number(true).build();
  for entry in workspace_walk(&base, arg_bool(args, "respectIgnore", true)?) {
    let entry = entry.map_err(|e| ToolError(format!("cannot walk workspace: {e}")))?;
    let path = entry.path();
    if !entry.file_type().is_some_and(|t| t.is_file()) { continue; }
    files += 1;
    let rel = relative(root, path);
    if include.as_ref().is_none_or(|glob| glob.is_match(&rel)) {
      // Read at most the limit plus one byte even if a file grows after stat.
      use std::io::Read;
      let file = fs::File::open(path).map_err(|e| ToolError(format!("cannot read `{rel}`: {e}")))?;
      let mut bytes = Vec::new();
      file.take(GREP_MAX_FILE_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|e| ToolError(format!("cannot read `{rel}`: {e}")))?;
      if bytes.len() as u64 > GREP_MAX_FILE_BYTES {
        skipped_large += 1;
      } else if !bytes.contains(&0) {
        let mut sink = CollectSink { path: &rel, hits: &mut hits, shortened: &mut shortened };
        searcher.search_slice(&matcher, &bytes, &mut sink).map_err(|e| ToolError(format!("cannot search `{rel}`: {e}")))?;
      }
    }
    if files >= GREP_MAX_FILES || hits.len() >= GREP_MAX_HITS { truncated = true; break; }
  }

  let content = if hits.is_empty() {
    format!("no match for `{needle}`")
  } else {
    hits.iter().map(|(p, line, text)| format!("{p}:{line}: {}", text.trim()))
      .collect::<Vec<_>>()
      .join("\n")
  };
  let content = if truncated { format!("{content}\n[results truncated by workspace limits]") } else { content };
  let content = if skipped_large > 0 { format!("{content}\n[skipped {skipped_large} files over 2 MiB]") } else { content };
  let content = if shortened { format!("{content}\n[matching lines shortened to 200 characters]") } else { content };
  Ok(ToolOutput {
    ok: true,
    summary: format!("{} match{} · {needle}", hits.len(), if truncated { " · truncated" } else { "" }),
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

struct CollectSink<'a> { path: &'a str, hits: &'a mut Vec<(String, u64, String)>, shortened: &'a mut bool }
impl Sink for CollectSink<'_> {
  type Error = std::io::Error;
  fn matched(&mut self, _searcher: &grep_searcher::Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
    let text = String::from_utf8_lossy(mat.bytes());
    let text = text.trim_end_matches(['\r', '\n']);
    let mut line: String = text.chars().take(200).collect();
    if text.chars().count() > 200 { *self.shortened = true; line.push('…'); }
    self.hits.push((self.path.to_string(), mat.line_number().unwrap_or(0), line));
    Ok(self.hits.len() < GREP_MAX_HITS)
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

  fn matches_glob(path: &str, pattern: &str) -> bool {
    compile_glob(pattern, true).unwrap().is_match(path)
  }

  struct Fixture(PathBuf);
  impl Fixture {
    fn new() -> Self {
      let root = std::env::temp_dir().join(format!("researchgo-search-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
      fs::create_dir_all(&root).unwrap();
      Self(root)
    }
    fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
      let path = self.0.join(path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::write(path, bytes).unwrap();
    }
  }
  impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
  }

  #[test]
  fn glob_supports_alternatives_classes_case_and_chinese_paths() {
    let fixture = Fixture::new();
    fixture.write("src/论文.ts", "x");
    fixture.write("src/a.tsx", "x");
    fixture.write("src/b.TS", "x");
    let out = glob_tool(&fixture.0, &json!({"pattern":"**/*.{ts,tsx}"})).unwrap();
    assert_eq!(out.content, "src/a.tsx\nsrc/论文.ts");
    let out = glob_tool(&fixture.0, &json!({"pattern":"**/[ab].{ts,tsx}", "caseSensitive":false})).unwrap();
    assert_eq!(out.content, "src/a.tsx\nsrc/b.TS");
    assert!(glob_tool(&fixture.0, &json!({"pattern":"["})).is_err());
  }

  #[test]
  fn search_honors_ignore_files_in_non_git_workspaces_and_can_override_them() {
    let fixture = Fixture::new();
    fixture.write(".gitignore", "ignored/\n");
    fixture.write(".ignore", "private/\n");
    fixture.write("ignored/a.txt", "needle");
    fixture.write("private/a.txt", "needle");
    fixture.write(".hidden/a.txt", "needle");
    fixture.write("node_modules/a.txt", "needle");
    let args = json!({"pattern":"**/*.txt"});
    assert_eq!(glob_tool(&fixture.0, &args).unwrap().content, ".hidden/a.txt");
    let out = glob_tool(&fixture.0, &json!({"pattern":"**/*.txt","respectIgnore":false})).unwrap();
    assert!(out.content.contains("ignored/a.txt"));
    assert!(out.content.contains("private/a.txt"));
    assert!(!out.content.contains("node_modules"));
    let out = grep_tool(&fixture.0, &json!({"pattern":"needle"})).unwrap();
    assert_eq!(out.content, ".hidden/a.txt:1: needle");
    let out = grep_tool(&fixture.0, &json!({"pattern":"needle","path":"ignored/a.txt"})).unwrap();
    assert_eq!(out.content, "ignored/a.txt:1: needle");
  }

  #[test]
  fn grep_supports_regex_literal_case_filter_and_correct_line_numbers() {
    let fixture = Fixture::new();
    fixture.write("src/论文.txt", "first\r\nFoo.中文\r\nfooX中文\r\n");
    fixture.write("other.rs", "Foo.中文\n");
    let out = grep_tool(&fixture.0, &json!({"pattern":"^Foo\\.中文$", "include":"**/*.txt"})).unwrap();
    assert_eq!(out.content, "src/论文.txt:2: Foo.中文");
    let out = grep_tool(&fixture.0, &json!({"pattern":"foo.中文", "literal":true, "caseSensitive":false,"path":"src"})).unwrap();
    assert_eq!(out.content, "src/论文.txt:2: Foo.中文");
    assert!(grep_tool(&fixture.0, &json!({"pattern":"["})).is_err());
    assert!(grep_tool(&fixture.0, &json!({"pattern":"Foo", "include":"["})).is_err());
  }

  #[test]
  fn grep_reports_limits_and_skips_binary_and_large_explicit_files() {
    let fixture = Fixture::new();
    fixture.write("binary.txt", b"needle\n\0needle");
    fixture.write("large.txt", vec![b'x'; GREP_MAX_FILE_BYTES as usize + 1]);
    let binary = grep_tool(&fixture.0, &json!({"pattern":"needle","path":"binary.txt"})).unwrap();
    assert!(binary.content.starts_with("no match"));
    let large = grep_tool(&fixture.0, &json!({"pattern":"x","path":"large.txt"})).unwrap();
    assert!(large.content.contains("skipped 1 files over 2 MiB"));
    fixture.write("many.txt", "needle\n".repeat(GREP_MAX_HITS + 10));
    let out = grep_tool(&fixture.0, &json!({"pattern":"needle","path":"many.txt"})).unwrap();
    assert_eq!(out.content.lines().filter(|l| l.starts_with("many.txt:")).count(), GREP_MAX_HITS);
    assert!(out.content.contains("truncated"));
    fixture.write("long.txt", format!("needle{}", "文".repeat(250)));
    let out = grep_tool(&fixture.0, &json!({"pattern":"needle","path":"long.txt"})).unwrap();
    assert!(out.content.contains("shortened to 200 characters"));
  }

  fn root() -> PathBuf {
    PathBuf::from("/work")
  }

  /// Exits non-zero. No shell is named here: `bash_tool` spawns the right one,
  /// and nesting a second `cmd` inside the `cmd` it already started is how the
  /// quotes go wrong.
  fn failing_command() -> &'static str {
    "exit 1"
  }

  fn succeeding_command() -> &'static str {
    "echo ok"
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

  #[test]
  fn glob_double_star_only_skips_whole_directories() {
    assert!(!matches_glob("prefix/src/main.rs", "**/rc/*.rs"));
    assert!(matches_glob("prefix/src/main.rs", "**/src/*.rs"));
    assert!(!matches_glob("src/deep/main.rs", "src/*.rs"));
    assert!(!matches_glob("src/deep/main.ts", "src/**.rs"));
  }

  #[test]
  fn glob_nonmatching_nested_paths_finish_without_backtracking() {
    let path = format!("{}notes.txt", "long-directory/".repeat(32));
    assert!(!matches_glob(&path, "**/*.tex"));
    assert!(!matches_glob(&path, "**/**/**/missing.*"));
    assert!(matches_glob(&path, "**/*.txt"));
  }

  #[tokio::test]
  async fn a_failed_command_is_a_failure_and_keeps_its_output() {
    // The regression this guards: a non-zero exit was returned as a successful
    // tool call, so the transcript drew a tick beside a failed command and the
    // model read a failing test run as a passing one.
    let fixture = Fixture::new();
    let out = bash_tool(&fixture.0, &json!({ "command": failing_command() })).await.unwrap();

    assert!(!out.ok, "a command that exits non-zero is not a success");
    // The output is the whole point of the call. Turning the failure into a
    // `ToolError` would have kept the tick honest but thrown away everything the
    // model needs in order to fix its own command.
    assert!(out.content.contains("failed"), "the exit status must reach the model: {}", out.content);
  }

  #[tokio::test]
  async fn a_successful_command_reports_success_and_no_summary() {
    let fixture = Fixture::new();
    let out = bash_tool(&fixture.0, &json!({ "command": succeeding_command() })).await.unwrap();

    assert!(out.ok);
    // `cmd` writes CRLF, so the content is compared on the line, not the byte.
    assert_eq!(out.content.trim(), "ok");
    // `exit 0` beside a tick says the same thing twice; the timing the row
    // already carries is the only summary a shell call should contribute.
    assert_eq!(out.summary, "");
  }

  #[test]
  fn the_bash_description_states_the_dialect_of_the_host() {
    // A model with no idea it is on cmd.exe writes `ls -la` and fails. The
    // description is the only place it looks before typing, so the host's own
    // dialect has to be in it.
    let defs = tool_defs();
    let bash = defs
      .iter()
      .find(|d| d["function"]["name"] == "bash")
      .expect("the bash tool is in the list the model sees");
    let description = bash["function"]["description"].as_str().unwrap_or_default();

    let expected = if cfg!(windows) { "cmd.exe" } else { "POSIX" };
    assert!(description.contains(expected), "description omits the host dialect: {description}");
    assert!(description.contains(shell()), "the description names a different shell than the one spawned");
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
