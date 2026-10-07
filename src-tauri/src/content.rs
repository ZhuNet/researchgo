//! What a file is, and what building a project would run.
//!
//! The editor holds a whole file in memory when it opens one, so a probe has only
//! two questions to answer: is this text at all, and is it small enough to hold?
//! The first is a bounded sniff, the second a `stat`.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// I/O buffer for line decoding and build-output pumping.
const READ_CHUNK: usize = 64 * 1024;

/// The sniff window. A NUL byte in here means binary by the same rule git uses,
/// and it is enough to catch every real binary while staying cheap on text.
const SNIFF_BYTES: u64 = 8 * 1024;

/// Nine minutes: long enough for a release build of a real project, short enough
/// that a hung build does not leave the preview spinning forever.
const BUILD_TIMEOUT: Duration = Duration::from_secs(540);

/// Only the tail of build output is kept. A failing compiler prints far more than
/// anyone reads, and the errors are at the end.
const OUTPUT_TAIL_BYTES: usize = 64 * 1024;

/// The largest file that will be opened in the editor, in bytes.
///
/// Not a policy so much as a wall: the editor keeps a document as a single string,
/// so a file has to fit in memory to be editable at all. Past this the honest
/// answer is to say so rather than page the machine to death. It is far above any
/// source file and far below what a machine can survive.
pub const EDIT_LIMIT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
  pub path: String,
  pub size: u64,
  pub mtime_ms: u64,
  pub binary: bool,
  /// Whether the file is small enough to load whole and edit.
  pub whole_readable: bool,
}

/// Everything needed to decide how to show a file, without reading its content.
#[tauri::command]
pub async fn file_info(path: String) -> Result<FileInfo, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_file() {
      return Err(format!("not a file: {path}"));
    }
    let mtime_ms = meta
      .modified()
      .ok()
      .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0);
    let size = meta.len();
    Ok(FileInfo {
      binary: sniff_binary(Path::new(&path))?,
      whole_readable: size <= EDIT_LIMIT_BYTES,
      path,
      size,
      mtime_ms,
    })
  })
  .await
  .map_err(|e| format!("file_info task failed: {e}"))?
}

/// NUL byte in the first few KiB: binary by the same rule git uses, and the same
/// one that keeps a UTF-8 decode from being attempted at all.
fn sniff_binary(path: &Path) -> Result<bool, String> {
  let mut file = File::open(path).map_err(|e| format!("open failed: {e}"))?;
  let mut buf = vec![0u8; SNIFF_BYTES as usize];
  let n = file.read(&mut buf).map_err(|e| format!("read failed: {e}"))?;
  Ok(buf[..n].contains(&0))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
  /// Project-relative, so it reads the same as a path in the tree.
  pub path: String,
  pub abs_path: String,
  pub size: u64,
  pub built_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOutcome {
  pub ok: bool,
  pub command: String,
  pub code: Option<i32>,
  /// Tail of stdout and stderr interleaved, which is where a compiler explains
  /// itself.
  pub output: String,
  pub duration_ms: u64,
  pub artifact: Option<ArtifactInfo>,
}

/// One build invocation, with the reason it was chosen kept for the UI.
#[derive(Clone, Debug, PartialEq)]
pub struct BuildPlan {
  pub command: String,
  pub args: Vec<String>,
  pub reason: &'static str,
  /// How many times to run it. LaTeX needs a second pass for the table of
  /// contents and cross-references; one pass renders a document with "??" where
  /// every reference should be.
  pub passes: u32,
  /// Where the artifact is expected to appear, when that is knowable.
  ///
  /// Knowing it matters: scanning for "the newest PDF" after a build picks up a
  /// stale one often enough to be a habit, and the preview then shows a document
  /// that predates the source that was just compiled.
  pub artifact: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct BuildOverride {
  command: String,
  #[serde(default)]
  args: Vec<String>,
  /// Multi-pass builds, for LaTeX-style toolchains driven by hand.
  #[serde(default = "one")]
  passes: u32,
  /// Project-relative path of what the command produces.
  #[serde(default)]
  artifact: Option<String>,
}

fn one() -> u32 {
  1
}

/// What to run for this project: XeLaTeX over the project's main document.
///
/// The preview exists to show what the sources compile to, so the build is the
/// project's LaTeX toolchain and nothing else — no guessing a build script out of
/// whichever marker happens to be present. An explicit `.rg/build.json` still
/// wins when the document needs a command this cannot know.
pub fn detect_build(root: &Path) -> Option<BuildPlan> {
  if let Some(plan) = override_from_file(root) {
    return Some(plan);
  }
  tex_plan(root)
}

/// Where XeLaTeX output goes, so it does not litter the sources with PDFs and
/// aux files next to the `.tex` that produced them.
fn tex_out_dir(root: &Path) -> PathBuf {
  root.join(".rg").join("build")
}

/// The document to compile: `main.tex` first, then the shallowest source.
///
/// A project with several documents is ambiguous, and picking the alphabetically
/// first would compile an appendix half the time. `main` is the convention, and
/// the chosen file is reported so a wrong guess is visible rather than silent.
fn tex_main(root: &Path) -> Option<PathBuf> {
  let mut candidates: Vec<(usize, String, PathBuf)> = Vec::new();
  let mut stack = vec![(root.to_path_buf(), 0usize)];
  while let Some((dir, depth)) = stack.pop() {
    if depth > 3 {
      continue;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
      continue;
    };
    for entry in entries.flatten() {
      let path = entry.path();
      let name = entry.file_name().to_string_lossy().into_owned();
      if path.is_dir() {
        // Source directories only; a vendor tree is somebody else's document.
        if name.starts_with('.') || NOISE.contains(&name.as_str()) {
          continue;
        }
        stack.push((path, depth + 1));
        continue;
      }
      if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("tex")) {
        candidates.push((depth, name, path));
      }
    }
  }
  if candidates.is_empty() {
    return None;
  }
  let main = candidates
    .iter()
    .find(|(_, name, _)| name.eq_ignore_ascii_case("main.tex"))
    .or_else(|| {
      candidates
        .iter()
        .filter(|(depth, _, _)| *depth == 0)
        .min_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    })
    .or_else(|| candidates.iter().min_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase())))?;
  Some(main.2.clone())
}

/// XeLaTeX, because the preview is for documents that need it: XeLaTeX handles
/// the system fonts and Unicode a paper actually contains, where pdflatex stops at
/// the first character it cannot map.
fn tex_plan(root: &Path) -> Option<BuildPlan> {
  let main = tex_main(root)?;
  let out = tex_out_dir(root);
  let stem = main.file_stem()?.to_string_lossy().into_owned();
  let rel = main.strip_prefix(root).unwrap_or(&main);
  Some(BuildPlan {
    command: "xelatex".into(),
    args: vec![
      "-interaction=nonstopmode".into(),
      "-halt-on-error".into(),
      "-file-line-error".into(),
      format!("-output-directory={}", out.display()),
      rel.to_string_lossy().replace('\\', "/"),
    ],
    reason: "XeLaTeX",
    passes: 2,
    artifact: Some(out.join(format!("{stem}.pdf"))),
  })
}

fn override_from_file(root: &Path) -> Option<BuildPlan> {
  let raw = std::fs::read_to_string(root.join(".rg").join("build.json")).ok()?;
  let parsed = serde_json::from_str::<BuildOverride>(&raw).ok()?;
  Some(BuildPlan {
    command: parsed.command,
    args: parsed.args,
    reason: ".rg/build.json",
    passes: parsed.passes.max(1),
    artifact: parsed
      .artifact
      .map(|rel| root.join(rel.trim_start_matches('/'))),
  })
}

/// Drains one output stream into the shared tail buffer, keeping only the end.
fn pump<R: Read + Send + 'static>(stream: R, sink: Arc<Mutex<String>>) -> std::thread::JoinHandle<()> {
  std::thread::spawn(move || {
    for line in BufReader::with_capacity(READ_CHUNK, stream)
      .lines()
      .map_while(Result::ok)
    {
      if let Ok(mut out) = sink.lock() {
        out.push_str(&line);
        out.push('\n');
        if out.len() > OUTPUT_TAIL_BYTES {
          // Keep the end: that is where the error is.
          let cut = out.len() - OUTPUT_TAIL_BYTES;
          *out = out[cut..].to_string();
        }
      }
    }
  })
}

/// Builds the project, or explains why it could not.
///
/// Everything runs off the UI thread, the output pipe is drained on its own
/// thread (a chatty compiler fills a 64 KiB pipe and would deadlock against a
/// reader that waits for exit), and a hung build is killed rather than left to
/// spin.
pub fn run_build(root: &str) -> Result<BuildOutcome, String> {
  let dir = PathBuf::from(root);
  if !dir.is_dir() {
    return Err(format!("not a directory: {root}"));
  }
  let plan = detect_build(&dir).ok_or_else(missing_build_message)?;
  let started = Instant::now();
  let mut output = String::new();
  let mut code: Option<i32> = None;
  let mut ok = false;

  // More than one pass for a LaTeX toolchain: the first resolves the document
  // structure, the second fills in the references and the table of contents that
  // depended on it. Stopping at the first failure keeps the error the reader
  // needs rather than the success of a later pass over a broken document.
  for pass in 1..=plan.passes.max(1) {
    let run = run_pass(&dir, &plan)?;
    output = run.output;
    code = run.code;
    ok = run.ok;
    if !ok {
      output = format!("{output}
(pass {pass} of {})", plan.passes.max(1));
      break;
    }
  }

  let artifact = if ok {
    plan.artifact
      .as_ref()
      .filter(|p| p.is_file())
      .and_then(|p| artifact_info(&dir, p))
  } else {
    None
  };

  // A command that exits zero without leaving a PDF is not a successful build for
  // this pane: there is nothing to show, and saying "succeeded" would be a lie the
  // reader only discovers by looking at an empty pane.
  let mut ok = ok;
  if ok && artifact.is_none() {
    ok = false;
    output.push_str(
      "\nbuild reported success but no PDF was produced, so there is nothing to preview",
    );
  }

  Ok(BuildOutcome {
    ok,
    command: describe(&plan),
    code,
    output,
    duration_ms: started.elapsed().as_millis() as u64,
    artifact,
  })
}

/// A single execution of the plan's command, with its output tail.
struct PassOutcome {
  ok: bool,
  code: Option<i32>,
  output: String,
}

fn run_pass(dir: &Path, plan: &BuildPlan) -> Result<PassOutcome, String> {
  // The output directory has to exist before the tool runs. XeLaTeX does not
  // create `-output-directory`, and it fails with "I can't write on file" rather
  // than making the directory — which reads as a broken document instead of a
  // missing folder, and it fails on every project the first time it is built.
  if let Some(artifact) = plan.artifact.as_deref() {
    if let Some(parent) = artifact.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
  }

  let mut child = Command::new(&plan.command)
    .args(&plan.args)
    .current_dir(dir)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| {
      if e.kind() == std::io::ErrorKind::NotFound {
        format!(
          "`{}` was not found — this app may have a smaller PATH than a shell; \
           set an absolute path in .rg/build.json",
          plan.command
        )
      } else {
        format!("failed to start `{}`: {e}", plan.command)
      }
    })?;

  let tail = Arc::new(Mutex::new(String::new()));
  let mut pumps = Vec::new();
  if let Some(out) = child.stdout.take() {
    pumps.push(pump(out, Arc::clone(&tail)));
  }
  if let Some(err) = child.stderr.take() {
    pumps.push(pump(err, Arc::clone(&tail)));
  }

  let deadline = Instant::now() + BUILD_TIMEOUT;
  let mut timed_out = false;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break Some(status),
      Ok(None) => {
        if Instant::now() >= deadline {
          timed_out = true;
          let _ = child.kill();
          let _ = child.wait();
          break None;
        }
        std::thread::sleep(Duration::from_millis(40));
      }
      Err(e) => return Err(format!("wait failed: {e}")),
    }
  };
  for pump in pumps {
    let _ = pump.join();
  }

  let mut output = tail.lock().map(|t| t.clone()).unwrap_or_default();
  if timed_out {
    output.push_str(&format!(
      "\nbuild killed after {}s without finishing",
      BUILD_TIMEOUT.as_secs()
    ));
  }
  Ok(PassOutcome {
    ok: matches!(status, Some(s) if s.success()),
    code: status.and_then(|s| s.code()),
    output,
  })
}

/// The command as the reader would type it, which is what belongs in the UI.
fn describe(plan: &BuildPlan) -> String {
  let mut out = format!("{} {}", plan.command, plan.args.join(" "));
  if plan.passes > 1 {
    out.push_str(&format!("  ({} passes)", plan.passes));
  }
  out.trim().to_string()
}

fn missing_build_message() -> String {
  "no LaTeX document found — add a main.tex to the project".to_string()
}

/// Why this plan cannot run here, if it cannot.
fn toolchain_problem(root: &Path, plan: &BuildPlan) -> Option<String> {
  if plan.command.contains('/') {
    let direct = Path::new(&plan.command);
    if !direct.is_absolute() {
      let relative = root.join(&plan.command);
      if !relative.is_file() {
        return Some(format!("`{}` is not there", plan.command));
      }
      return None;
    }
    if !direct.is_file() {
      return Some(format!("`{}` does not exist", plan.command));
    }
    return None;
  }
  if which(&plan.command, root).is_some() {
    return None;
  }
  let install = if plan.command == "xelatex" {
    "install TeX Live (or MiKTeX) so xelatex is on PATH".to_string()
  } else {
    format!("`{}` must be on PATH", plan.command)
  };
  Some(format!(
    "{} was not found on PATH — {install}, or point .rg/build.json at it with an absolute path",
    plan.command
  ))
}

/// Minimal `which`: PATH lookup, plus a relative command resolved against the
/// project, because a build command in `.rg/build.json` is often `./build.sh`.
fn which(command: &str, cwd: &Path) -> Option<PathBuf> {
  if command.contains('/') {
    let direct = PathBuf::from(command);
    if direct.is_absolute() {
      return direct.is_file().then_some(direct);
    }
    let relative = cwd.join(command);
    return relative.is_file().then_some(relative);
  }
  let path = std::env::var_os("PATH")?;
  std::env::split_paths(&path)
    .map(|dir| dir.join(command))
    .find(|candidate| candidate.is_file())
}

fn artifact_info(root: &Path, path: &Path) -> Option<ArtifactInfo> {
  let meta = std::fs::metadata(path).ok()?;
  if !meta.is_file() {
    return None;
  }
  Some(ArtifactInfo {
    path: relative(root, path),
    abs_path: path.to_string_lossy().into_owned(),
    size: meta.len(),
    built_ms: meta
      .modified()
      .ok()
      .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0),
  })
}

/// Directories that hold scratch, never source worth compiling.
const NOISE: &[&str] = &["node_modules", "target", ".git", ".rg", "dist"];

fn relative(root: &Path, path: &Path) -> String {
  match path.strip_prefix(root) {
    Ok(rest) => format!("/{}", rest.to_string_lossy().replace('\\', "/")),
    Err(_) => path.to_string_lossy().into_owned(),
  }
}

/// Builds the open project with XeLaTeX and reports the PDF it produced.
#[tauri::command]
pub async fn build_project(root: String) -> Result<BuildOutcome, String> {
  tauri::async_runtime::spawn_blocking(move || run_build(&root))
    .await
    .map_err(|e| format!("build task failed: {e}"))?
}

/// Largest PDF the preview will pull into the renderer.
///
/// A webview cannot fetch a filesystem path, and the preview is the one surface
/// that needs whole-document bytes. Refusing a huge one with a sentence beats
/// handing the renderer half a gigabyte: the reader is told, and the file is still
/// openable elsewhere.
pub const PREVIEW_MAX_BYTES: u64 = 48 * 1024 * 1024;

/// Reads a PDF for the preview pane, or explains why it cannot.
#[tauri::command]
pub async fn read_artifact(path: String) -> Result<Vec<u8>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > PREVIEW_MAX_BYTES {
      return Err(format!(
        "PDF is {} MB, over the {} MB preview limit — open it in another application",
        meta.len() / (1024 * 1024),
        PREVIEW_MAX_BYTES / (1024 * 1024)
      ));
    }
    std::fs::read(&path).map_err(|e| format!("read failed: {e}"))
  })
  .await
  .map_err(|e| format!("read_artifact task failed: {e}"))?
}

/// What building this project would run, and where the result is expected.
///
/// The preview starts empty on purpose: nothing is shown until the reader builds,
/// because a PDF already sitting in the tree predates every compile and presenting
/// it as the build output is a lie. What the empty state can honestly say is what
/// pressing Build will do, which is what this returns.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildPlanInfo {
  pub buildable: bool,
  pub command: Option<String>,
  pub reason: Option<String>,
  /// Project-relative path the artifact is expected at, when knowable.
  pub artifact: Option<String>,
  pub passes: u32,
  pub detail: Option<String>,
}

#[tauri::command]
pub async fn build_plan(root: String) -> Result<BuildPlanInfo, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let dir = PathBuf::from(&root);
    if !dir.is_dir() {
      return Err(format!("not a directory: {root}"));
    }
    // Checked before the reader presses Build, because a desktop launcher hands a
    // desktop app a much smaller PATH than a shell does — `xelatex` is usually
    // somewhere the shell has and the launcher does not, and finding that out by
    // pressing the button is a waste of the reader's time.
    let Some(plan) = detect_build(&dir) else {
      return Ok(BuildPlanInfo {
        buildable: false,
        command: None,
        reason: None,
        artifact: None,
        passes: 1,
        detail: Some(missing_build_message()),
      });
    };
    if let Some(problem) = toolchain_problem(&dir, &plan) {
      return Ok(BuildPlanInfo {
        buildable: false,
        command: Some(describe(&plan)),
        reason: Some(plan.reason.to_string()),
        artifact: plan.artifact.as_deref().map(|p| relative(&dir, p)),
        passes: plan.passes.max(1),
        detail: Some(problem),
      });
    }
    Ok(BuildPlanInfo {
      buildable: true,
      command: Some(describe(&plan)),
      reason: Some(plan.reason.to_string()),
      artifact: plan.artifact.as_deref().map(|p| relative(&dir, p)),
      passes: plan.passes.max(1),
      detail: None,
    })
  })
  .await
  .map_err(|e| format!("build_plan task failed: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Scratch(PathBuf);

  impl Scratch {
    fn new(name: &str) -> Scratch {
      let dir = std::env::temp_dir().join(format!("rg-content-{name}"));
      let _ = std::fs::remove_dir_all(&dir);
      std::fs::create_dir_all(&dir).unwrap();
      Scratch(dir)
    }
    fn write(&self, rel: &str, body: &[u8]) -> PathBuf {
      let path = self.0.join(rel);
      if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
      }
      std::fs::write(&path, body).unwrap();
      path
    }
    fn path(&self) -> &Path {
      &self.0
    }
  }

  #[test]
  fn sniffs_binary_by_the_nul_rule() {
    let s = Scratch::new("sniff");
    let text = s.write("t.txt", b"plain text\n");
    assert!(!sniff_binary(&text).unwrap());
    let bin = s.write("t.png", &[0x89, b'P', b'N', b'G', 0x00, 0x1a]);
    assert!(sniff_binary(&bin).unwrap());
  }

  #[test]
  fn a_non_tex_project_has_nothing_to_build() {
    // Markers for other toolchains are deliberately ignored: the preview is for
    // compiled documents, and running an unrelated build script is how a mock PDF
    // used to end up on screen.
    let s = Scratch::new("detect-non-tex");
    s.write("Cargo.toml", b"[package]");
    s.write("Makefile", b"all:\n\ttrue");
    s.write(
      "package.json",
      br#"{"scripts":{"build":"vite build","pdf":"node gen.mjs"}}"#,
    );
    assert!(detect_build(s.path()).is_none());
  }

  #[test]
  fn an_explicit_override_beats_the_tex_document() {
    let s = Scratch::new("detect-override");
    s.write("main.tex", b"documentclass");
    s.write(
      ".rg/build.json",
      br#"{"command":"./run.sh","args":["--fast","-v"]}"#,
    );
    let plan = detect_build(s.path()).unwrap();
    assert_eq!(
      plan,
      BuildPlan {
        command: "./run.sh".into(),
        args: vec!["--fast".into(), "-v".into()],
        reason: ".rg/build.json",
        passes: 1,
        artifact: None,
      }
    );
  }

  #[test]
  fn the_preview_compiles_with_xelatex_and_knows_where_the_pdf_lands() {
    let s = Scratch::new("tex-plan");
    s.write("main.tex", "\\documentclass{article}\n".as_bytes());

    let plan = detect_build(s.path()).expect("a plan");
    assert_eq!(plan.command, "xelatex");
    // A second pass, or every reference renders as "??".
    assert_eq!(plan.passes, 2);
    assert_eq!(plan.reason, "XeLaTeX");
    // Deterministic artifact: this is what the preview will look for.
    assert_eq!(
      plan.artifact.as_deref(),
      Some(s.path().join(".rg").join("build").join("main.pdf").as_path())
    );
    assert!(plan.args.iter().any(|a| a.contains("-halt-on-error")));
    assert!(plan.args.iter().any(|a| a.contains(".rg/build")));
    assert_eq!(plan.args.last().unwrap(), "main.tex");
  }

  #[test]
  fn the_main_document_wins_over_an_alphabetically_earlier_appendix() {
    let s = Scratch::new("tex-main");
    s.write("appendix.tex", b"appendix");
    s.write("main.tex", b"documentclass");
    let plan = detect_build(s.path()).unwrap();
    assert_eq!(plan.args.last().unwrap(), "main.tex");
  }

  #[test]
  fn a_tex_document_is_built_even_when_other_markers_are_present() {
    let s = Scratch::new("tex-first");
    s.write("Cargo.toml", b"[package]");
    s.write("package.json", br#"{"scripts":{"pdf":"node gen.mjs","build":"tsc"}}"#);
    s.write("main.tex", b"documentclass");
    assert_eq!(detect_build(s.path()).unwrap().command, "xelatex");
  }

  #[test]
  fn an_override_can_declare_its_artifact_and_passes() {
    let s = Scratch::new("override-artifact");
    s.write(
      ".rg/build.json",
      br#"{"command":"latexmk","args":["-xelatex"],"passes":1,"artifact":"/out/paper.pdf"}"#,
    );
    let plan = detect_build(s.path()).unwrap();
    assert_eq!(plan.passes, 1);
    assert_eq!(
      plan.artifact.as_deref(),
      Some(s.path().join("out").join("paper.pdf").as_path())
    );
  }

  #[test]
  fn the_empty_preview_states_what_build_would_run() {
    let s = Scratch::new("tex-unbuilt");
    s.write("main.tex", b"documentclass");
    let plan = detect_build(s.path()).unwrap();
    let described = describe(&plan);
    assert!(described.contains("xelatex"), "was: {described}");
    assert!(described.contains("2 passes"), "was: {described}");
    assert!(!plan.artifact.unwrap().is_file(), "nothing was built yet");
  }

  #[test]
  fn a_project_with_nothing_to_build_says_so_instead_of_guessing() {
    let s = Scratch::new("plan-none");
    assert!(detect_build(s.path()).is_none());
    let msg = missing_build_message();
    assert!(msg.contains("main.tex"), "unhelpful: {msg}");
  }

  #[test]
  fn a_failing_build_reports_the_tail_of_its_output() {
    let s = Scratch::new("failing-build");
    s.write(
      ".rg/build.json",
      br#"{"command":"sh","args":["-c","echo boom >&2; exit 3"]}"#,
    );
    let out = run_build(s.path().to_str().unwrap()).unwrap();
    assert!(!out.ok);
    // "non-zero and reported" is the contract the preview relies on; the exact
    // code belongs to the command, not to us.
    assert_eq!(out.code.filter(|c| *c != 0), Some(out.code.expect("a code")));
    assert!(out.output.contains("boom"), "output was: {}", out.output);
    assert!(out.artifact.is_none(), "a failed build has no artifact");
  }

  #[test]
  fn a_successful_build_reports_the_pdf_it_produced() {
    let s = Scratch::new("good-build");
    s.write(
      ".rg/build.json",
      br#"{"command":"sh","args":["-c","mkdir -p out; printf '%s' '%PDF-1.4 hi' > out/main.pdf"],"artifact":"/out/main.pdf"}"#,
    );
    let out = run_build(s.path().to_str().unwrap()).unwrap();
    assert!(out.ok, "output: {}", out.output);
    let artifact = out.artifact.expect("artifact");
    assert_eq!(artifact.path, "/out/main.pdf");
    assert_eq!(artifact.size, 11);
    // Freshly written, so the preview can tell it apart from a stale file.
    assert!(artifact.built_ms > 0);
  }

  #[test]
  fn the_output_directory_exists_before_the_tool_runs() {
    // XeLaTeX will not create `-output-directory` itself, so the runner has to.
    // A fake command stands in for it: the marker can only be written if the
    // directory was already there when the process started.
    let s = Scratch::new("outdir");
    s.write(
      ".rg/build.json",
      br#"{"command":"sh","args":["-c","test -d .rg/build && printf ok > .rg/build/probe && printf '%s' '%PDF-1.4' > .rg/build/main.pdf"],"artifact":"/.rg/build/main.pdf"}"#,
    );
    let out = run_build(s.path().to_str().unwrap()).unwrap();
    assert!(out.ok, "output: {}", out.output);
    assert!(
      s.path().join(".rg").join("build").join("probe").is_file(),
      "the directory did not exist when the command started"
    );
    assert_eq!(out.artifact.map(|a| a.path), Some("/.rg/build/main.pdf".into()));
  }

  #[test]
  fn a_toolchain_that_is_not_installed_is_reported_before_the_reader_presses_build() {
    let s = Scratch::new("toolchain-missing");
    s.write(
      ".rg/build.json",
      br#"{"command":"xelatex-does-not-exist","args":["main.tex"]}"#,
    );
    let plan = detect_build(s.path()).unwrap();
    let problem = toolchain_problem(s.path(), &plan).expect("a problem");
    assert!(problem.contains("not found on PATH"), "was: {problem}");
  }

  #[test]
  fn a_relative_command_is_resolved_against_the_project() {
    let s = Scratch::new("toolchain-relative");
    s.write("build.sh", b"#!/bin/sh\n");
    s.write(
      ".rg/build.json",
      br#"{"command":"./build.sh","args":[],"artifact":"/out/main.pdf"}"#,
    );
    let plan = detect_build(s.path()).unwrap();
    // The file is there, so nothing is wrong with the plan.
    assert!(toolchain_problem(s.path(), &plan).is_none());
  }

  #[test]
  fn a_missing_root_is_an_error_rather_than_a_panic() {
    let missing = std::env::temp_dir().join("rg-content-does-not-exist-xyz");
    let _ = std::fs::remove_dir_all(&missing);
    assert!(run_build(missing.to_str().unwrap()).is_err());
  }
}