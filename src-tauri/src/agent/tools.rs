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
use std::sync::Arc;
use std::sync::OnceLock;
use std::io::Write;

use globset::{GlobBuilder, GlobMatcher};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
use schemars::{JsonSchema, schema_for};
use serde::Deserialize;
use serde_json::{Value, json};
use similar::TextDiff;
use tokio::process::Command;

use super::agent_loop::Turn;

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
  /// Emitted as a `file.patch` frame when set. The diff is captured at write
  /// time so the transcript keeps this operation's exact change even when a
  /// later tool edits the same file again.
  pub patch: Option<FilePatch>,
}

pub struct FilePatch {
  pub path: String,
  pub created: bool,
  pub bytes: usize,
  pub diff: String,
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
const LITERATURE_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const LITERATURE_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// How many papers to fetch at once. Kept modest so we do not look like a
/// flood to Google Scholar / publisher hosts and so the UI progress stays
/// legible. The previous fully serial loop was the dominant latency.
const LITERATURE_CONCURRENCY: usize = 6;
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

/// Model protocol understood by the definition adapter.
#[derive(Debug, Clone, Copy)]
pub enum ToolProtocol {
    OpenAiChatCompletions,
}

/// Every tool definition, in the order the model sees them.
///
/// `read` comes first because it is the one tool that is almost always the
/// right first move, and a schema listed first is the one a model reaches for.
fn openai_chat_tool_defs() -> &'static [Value] {
    static DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| vec![
    json!({
      "type": "function",
      "function": {
        "name": "read",
         "description": "Read a file. Returns its contents with line numbers. Truncated past 2000 lines. Prefer this over shell commands for looking at code.",
        "parameters": schema_for!(ReadArgs)
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "write",
        "description": "Create a file, or replace an existing one entirely. Use only for new files or when a full rewrite is intended; prefer edit for changes to existing code.",
        "parameters": schema_for!(WriteArgs)
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "edit",
        "description": "Replace an exact string in a file. The old_string must appear exactly once and be copied verbatim including indentation. Fails loudly on a mismatch rather than guessing which occurrence you meant.",
        "parameters": schema_for!(EditArgs)
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
        "parameters": schema_for!(BashArgs)
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "glob",
         "description": "Find files with globset patterns: *, ?, **, character classes and {ts,tsx} alternatives. * and ? do not cross directories; ? matches one byte, so use * for Chinese filenames. Case-sensitive by default. Honors .gitignore/.ignore, includes hidden files, skips build/cache directories and directory links. Returns sorted paths and reports truncation.",
        "parameters": schema_for!(GlobArgs)
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "grep",
         "description": "Search file contents using ripgrep's Rust regex engine, one line at a time. Case-sensitive regex by default; literal=true searches exact text. Honors .gitignore/.ignore, includes hidden files, skips binary files, files over 2 MiB, build/cache directories and directory links. Returns path:line and matching text; reports limits and shortened lines. Invalid regex returns a tool error.",
        "parameters": schema_for!(GrepArgs)
      }
    }),
    json!({
      "type": "function",
      "function": {
        "name": "research_literature",
        "description": "Research academic literature for a topic using Google Scholar via SerpApi, then retrieve available paper sources for local reading. Use for literature surveys, representative papers, recent research progress, or evidence-backed paper discovery. Do not use for reading a local PDF.",
        "parameters": schema_for!(ResearchLiteratureArgs)
      }
    }),
  ])
}

/// Converts the internal tool catalogue to the selected model protocol.
///
/// The optional allow-list is the first configuration hook for tool
/// registration. `None` includes every registered tool.
pub fn tool_defs_for(_protocol: ToolProtocol, enabled: Option<&[&str]>) -> Vec<Value> {
    openai_chat_tool_defs()
        .iter()
        .cloned()
        .filter(|definition| {
            enabled.is_none_or(|names| {
                names
                    .iter()
                    .any(|name| *name == definition["function"]["name"])
            })
        })
        .collect()
}

pub fn tool_defs() -> Vec<Value> {
    tool_defs_for(ToolProtocol::OpenAiChatCompletions, None)
}

/// File reads and searches do not mutate the workspace and can safely share a
/// dispatch batch. Keeping this policy in the tool layer prevents the agent
/// loop from accidentally parallelising a future mutating call.
pub fn is_parallel_safe(name: &str) -> bool {
    matches!(name, "read" | "glob" | "grep")
}

fn is_search(name: &str) -> bool {
    matches!(name, "glob" | "grep")
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    path: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    path: String,
    /// The complete file contents.
    content: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EditArgs {
    path: String,
    old_string: String,
    new_string: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BashArgs {
    command: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GlobArgs {
    pattern: String,
    /// Search directory. Defaults to the current directory.
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "caseSensitive", default = "default_true")]
    case_sensitive: bool,
    #[serde(rename = "respectIgnore", default = "default_true")]
    respect_ignore: bool,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct GrepArgs {
    pattern: String,
    /// Search file or directory. Defaults to the current directory.
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    literal: bool,
    #[serde(rename = "caseSensitive", default = "default_true")]
    case_sensitive: bool,
    #[serde(default)]
    include: Option<String>,
    #[serde(rename = "respectIgnore", default = "default_true")]
    respect_ignore: bool,
}

fn default_true() -> bool {
    true
}

/// Deserialize the complete argument object before execution. Business checks
/// remain inside each tool implementation.
fn parse_args<T: for<'de> Deserialize<'de>>(name: &str, args: &Value) -> Result<T, ToolError> {
    serde_json::from_value(args.clone())
        .map_err(|err| ToolError(format!("invalid arguments for `{name}`: {err}")))
}

#[cfg(test)]
fn validate_args(name: &str, args: &Value) -> Result<(), ToolError> {
    match name {
        "read" => parse_args::<ReadArgs>(name, args).map(|_| ()),
        "write" => parse_args::<WriteArgs>(name, args).map(|_| ()),
        "edit" => parse_args::<EditArgs>(name, args).map(|_| ()),
        "bash" => parse_args::<BashArgs>(name, args).map(|_| ()),
        "glob" => parse_args::<GlobArgs>(name, args).map(|_| ()),
        "grep" => parse_args::<GrepArgs>(name, args).map(|_| ()),
        _ => Err(ToolError(format!("unknown tool `{name}`"))),
    }
}

// This wrapper retains the direct async unit-test helper while the dispatch
// path below passes typed arguments through without parsing them twice.
#[cfg(test)]
async fn bash_tool(root: &Path, args: &Value, turn: &Arc<Turn>) -> Result<ToolOutput, ToolError> {
    bash_tool_typed(root, &parse_args("bash", args)?, turn).await
}
#[cfg(test)]
fn glob_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
    parse_args("glob", args).and_then(|a| glob_tool_typed(root, &a))
}
#[cfg(test)]
fn grep_tool(root: &Path, args: &Value) -> Result<ToolOutput, ToolError> {
    parse_args("grep", args).and_then(|a| grep_tool_typed(root, &a))
}

/// What a tool says when the turn stopped before it could finish.
///
/// One string for both readers: the transcript the model sees next turn and the
/// row on screen. It is a *result* rather than a silence on purpose — a tool
/// call the model asked for has to be answered, and an unanswered one is a
/// request the endpoint rejects outright.
pub const STOPPED: &str = "stopped";

/// Runs one tool call.
///
/// `root` is the workspace the conversation is running in. `call_id` is echoed
/// in every frame for the call so a late chunk cannot be attributed to the
/// wrong tool. `turn` is what makes a tool interruptible: a search and a shell
/// command both outlive the click that stopped the turn unless something
/// interrupts them, and a build still running after the panel says it stopped is
/// the one that rewrites a file the next turn has already read.
pub async fn run(
  root: &Path,
  name: &str,
  args: &Value,
  call_id: &str,
  turn: &Arc<Turn>,
) -> Result<ToolOutput, ToolError> {
    if !matches!(name, "read" | "write" | "edit" | "bash" | "glob" | "grep" | "research_literature") {
        return Err(ToolError(format!(
            "unknown tool `{name}`; available: read, write, edit, bash, glob, grep, research_literature"
        )));
    }
    if turn.is_stopped() {
        return Err(ToolError(STOPPED.into()));
    }
    if is_search(name) {
    let root = root.to_path_buf();
    let args = args.clone();
    let name = name.to_string();
    return tokio::select! {
      biased;
      _ = turn.stopped() => Err(ToolError(STOPPED.into())),
      result = tokio::task::spawn_blocking(move || {
            match name.as_str() {
              "glob" => parse_args::<GlobArgs>("glob", &args).and_then(|a| glob_tool_typed(&root, &a)),
              "grep" => parse_args::<GrepArgs>("grep", &args).and_then(|a| grep_tool_typed(&root, &a)),
              _ => unreachable!(),
            }
      }) =>
        result.map_err(|e| ToolError(format!("search task failed: {e}")))?,
    };
  }
  match name {
        "read" => parse_args::<ReadArgs>("read", args).and_then(|a| read_tool_typed(root, &a)),
        "write" => parse_args::<WriteArgs>("write", args).and_then(|a| write_tool_typed(root, &a)),
        "edit" => parse_args::<EditArgs>("edit", args).and_then(|a| edit_tool_typed(root, &a)),
        "bash" => bash_tool_typed(root, &parse_args::<BashArgs>("bash", args)?, turn).await,
        "glob" => parse_args::<GlobArgs>("glob", args).and_then(|a| glob_tool_typed(root, &a)),
        "grep" => parse_args::<GrepArgs>("grep", args).and_then(|a| grep_tool_typed(root, &a)),
        "research_literature" => research_literature_tool(root, &parse_args::<ResearchLiteratureArgs>("research_literature", args)?, turn, call_id).await,
        _ => unreachable!(),
  }
  .map(|mut out| {
    let _ = call_id;
    out.summary = out.summary.trim().to_string();
    out
  })
}

static LITERATURE_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub(super) fn init_literature_progress(app: &tauri::AppHandle) {
  let _ = LITERATURE_APP.set(app.clone());
}

fn literature_progress(call_id: &str, turn: u64, progress: Value) {
  use tauri::Emitter;
  if let Some(app) = LITERATURE_APP.get() {
    let _ = app.emit("literature:progress", json!({ "callId": call_id, "turn": turn, "progress": progress }));
  }
}

async fn research_literature_tool(root: &Path, args: &ResearchLiteratureArgs, turn: &Arc<Turn>, call_id: &str) -> Result<ToolOutput, ToolError> {
  let key = super::config::serpapi_secret().map_err(ToolError)?;
  research_literature_with_progress(root, args, turn, &key, &|progress| literature_progress(call_id, turn.serial(), progress)).await
}

#[cfg(test)]
async fn research_literature_with_key(root: &Path, args: &ResearchLiteratureArgs, turn: &Arc<Turn>, serpapi_key: &str) -> Result<ToolOutput, ToolError> {
  research_literature_with_progress(root, args, turn, serpapi_key, &|_| {}).await
}

async fn research_literature_with_progress(root: &Path, args: &ResearchLiteratureArgs, turn: &Arc<Turn>, serpapi_key: &str, progress: &(dyn Fn(Value) + Sync)) -> Result<ToolOutput, ToolError> {
  let query = args.query.trim();
  if query.is_empty() { return Err(ToolError("query is empty".into())); }
  if args.max_papers == 0 || args.max_papers > 20 { return Err(ToolError("max_papers must be between 1 and 20".into())); }
  if let (Some(from), Some(to)) = (args.year_from, args.year_to) {
    if from > to { return Err(ToolError("year_from must not be after year_to".into())); }
  }
  if serpapi_key.trim().is_empty() { return Err(ToolError("SerpApi API key is not configured. Open Settings and add it before researching literature.".into())); }
  let url = "https://serpapi.com/search?engine=google_scholar";
  let per_page = args.max_papers.to_string();

  let client = reqwest::Client::builder()
    .connect_timeout(LITERATURE_CONNECT_TIMEOUT)
    .read_timeout(LITERATURE_READ_TIMEOUT)
    .build()
    .map_err(|e| ToolError(format!("cannot build literature HTTP client: {e}")))?;
  let response = tokio::select! {
    biased;
    _ = turn.stopped() => return Err(ToolError(STOPPED.into())),
    result = {
      let mut params = vec![("q", query), ("api_key", serpapi_key), ("num", per_page.as_str())];
      let from = args.year_from.map(|v| v.to_string());
      let to = args.year_to.map(|v| v.to_string());
      if let Some(ref value) = from { params.push(("as_ylo", value.as_str())); }
      if let Some(ref value) = to { params.push(("as_yhi", value.as_str())); }
      client.get(url).query(&params)
    }
      .header("User-Agent", "ResearchGO/0.1")
      .send() => result.map_err(|e| literature_network_error("search_papers", &url, e))?,
  };
  if !response.status().is_success() { return Err(ToolError(format!("search_papers returned HTTP {}", response.status()))); }
  let body: Value = response.json().await.map_err(|e| ToolError(format!("invalid search_papers response: {}", e.without_url())))?;
  if let Some(error) = body["error"].as_str() { return Err(ToolError(format!("SerpApi search failed: {error}"))); }
  let results = body["organic_results"].as_array().ok_or_else(|| ToolError("SerpApi returned no organic results".into()))?;
  progress(json!({ "stage": "retrieving", "total": results.len().min(args.max_papers) }));
  let reference_dir = root.join("reference");
  fs::create_dir_all(&reference_dir).map_err(|e| ToolError(format!("cannot create reference directory: {e}")))?;

  // Process papers concurrently. The previous serial loop meant waiting for
  // each PDF download + text extraction to finish before starting the next,
  // which dominated wall-clock time when max_papers was 10-20.
  use futures_util::stream::{self, StreamExt};
  let work: Vec<(usize, Value)> = results.iter().take(args.max_papers).cloned().enumerate().collect();
  let tasks = stream::iter(work.into_iter().map(|(index, detail)| {
    let client = &client;
    let reference_dir = &reference_dir;
    let turn = turn.clone();
    async move {
      if turn.is_stopped() { return Err(ToolError(STOPPED.into())); }
      let paper = process_one_paper(client, reference_dir, &turn, index, &detail, progress).await?;
      let is_failure = paper["source"]["status"] == "unavailable";
      Ok::<(usize, Value, bool), ToolError>((index, paper, is_failure))
    }
  })).buffer_unordered(LITERATURE_CONCURRENCY);

  let collected: Vec<Result<(usize, Value, bool), ToolError>> = tasks.collect().await;
  let mut done: Vec<(usize, Value, bool)> = collected.into_iter().collect::<Result<Vec<_>, _>>()?;
  done.sort_by_key(|(i, _, _)| *i);
  let paper_failures = done.iter().filter(|(_, _, f)| *f).count();
  let papers: Vec<Value> = done.into_iter().map(|(_, p, _)| p).collect();
  let count = papers.len();
  Ok(ToolOutput {
    content: serde_json::to_string_pretty(&json!({ "query": query, "papers": papers })).map_err(|e| ToolError(format!("cannot encode research result: {e}")))?,
    summary: format!("{count} papers found; {paper_failures} source files unavailable"),
    ok: count == 0 || paper_failures < count,
    patch: None,
  })
}

async fn process_one_paper(
  client: &reqwest::Client,
  reference_dir: &Path,
  turn: &Arc<Turn>,
  index: usize,
  detail: &Value,
  progress: &(dyn Fn(Value) + Sync),
) -> Result<Value, ToolError> {
  let title = detail["title"].as_str().unwrap_or("untitled paper");
  progress(json!({ "stage": "paper", "index": index, "title": title }));
  let authors = detail["publication_info"]["authors"].as_array()
    .map(|items| items.iter().filter_map(|a| a["name"].as_str()).collect::<Vec<_>>())
    .unwrap_or_default();
  let pdf_url = scholar_pdf_url(detail);
  let landing_url = detail["link"].as_str();
  let slug = reference_slug(title);
  let base = reference_dir.join(format!("{:02}-{slug}", index + 1));
  let mut source = json!({ "status": "unavailable", "path": Value::Null, "url": landing_url.or(pdf_url) });
  let mut extraction_note = String::new();

  // Try PDF first.
  if let Some(url) = pdf_url {
    match fetch_url(client, url, turn).await {
      Ok(response) if response.status().is_success() => {
        if let Ok(bytes) = response.bytes().await {
          let path = base.with_extension("pdf");
          if fs::File::create(&path).and_then(|mut f| f.write_all(&bytes)).is_ok() {
            source = json!({ "status": "pdf", "path": path.display().to_string(), "url": url });
            // PDF text extraction is synchronous and CPU-heavy; move it off
            // the async runtime so concurrent fetches are not blocked.
            let extracted = tokio::task::spawn_blocking(move || -> (String, String) {
              match pdf_extract::extract_text_from_mem(&bytes) {
                Ok(text) if !text.trim().is_empty() => (text, String::new()),
                Ok(_) => (String::new(), "PDF was saved, but no text could be extracted".into()),
                Err(err) => (String::new(), format!("PDF was saved, but text extraction failed: {err}")),
              }
            }).await.map_err(|e| ToolError(format!("pdf extract task panicked: {e}")))?;
            extraction_note = extracted.1;
            let extracted_text = extracted.0;
            if !extracted_text.is_empty() {
              let chapters = extract_chapters(&extracted_text);
              let evidence = extract_evidence(&extracted_text, &chapters);
              let paper = build_paper_json(detail, authors, source, chapters, evidence, extraction_note);
              emit_result_progress(progress, index, &paper);
              return Ok(paper);
            }
          } else { extraction_note = "PDF was fetched, but could not be saved".into(); }
        } else { extraction_note = "PDF response could not be read".into(); }
      }
      Ok(response) => extraction_note = format!("PDF returned HTTP {}", response.status()),
      Err(_) => extraction_note = "PDF could not be fetched".into(),
    }
  }

  // Fallback: landing page HTML.
  if source["status"] == "unavailable" {
    if let Some(url) = landing_url {
      match fetch_url(client, url, turn).await {
        Ok(response) if response.status().is_success() => {
          if let Ok(bytes) = response.bytes().await {
            let html = String::from_utf8_lossy(&bytes).into_owned();
            let path = base.with_extension("html");
            if fs::File::create(&path).and_then(|mut f| f.write_all(html.as_bytes())).is_ok() {
              source = json!({ "status": "html", "path": path.display().to_string(), "url": url });
              let extracted = html_to_text(&html);
              if extracted.trim().is_empty() {
                extraction_note = "HTML was saved, but no readable text could be extracted".into();
              }
              let chapters = extract_chapters(&extracted);
              let evidence = extract_evidence(&extracted, &chapters);
              let paper = build_paper_json(detail, authors, source, chapters, evidence, extraction_note);
              emit_result_progress(progress, index, &paper);
              return Ok(paper);
            } else { extraction_note = "HTML was fetched, but could not be saved".into(); }
          } else { extraction_note = "HTML response could not be read".into(); }
        }
        Ok(response) => extraction_note = format!("HTML returned HTTP {}", response.status()),
        Err(_) => extraction_note = "HTML could not be fetched".into(),
      }
    } else {
      extraction_note = "No PDF or HTML URL was available".into();
    }
  }

  let paper = build_paper_json(detail, authors, source, Vec::new(), Vec::new(), extraction_note);
  emit_result_progress(progress, index, &paper);
  Ok(paper)
}

fn build_paper_json(
  detail: &Value,
  authors: Vec<&str>,
  source: Value,
  chapters: Vec<Value>,
  evidence: Vec<Value>,
  extraction_note: String,
) -> Value {
  json!({
    "title": detail["title"],
    "authors": authors,
    "year": scholar_year(detail),
    "publication_summary": detail["publication_info"]["summary"],
    "abstract": detail["snippet"],
    "doi": Value::Null,
    "url": detail["link"],
    "pdf_url": scholar_pdf_url(detail),
    "scholar_result_id": detail["result_id"],
    "cluster_id": detail["inline_links"]["versions"]["cluster_id"],
    "source": source,
    "chapters": chapters,
    "evidence": evidence,
    "extraction_note": if extraction_note.is_empty() { Value::Null } else { json!(extraction_note) },
  })
}

fn emit_result_progress(progress: &(dyn Fn(Value) + Sync), index: usize, paper: &Value) {
  progress(json!({ "stage": "result", "index": index, "paper": {
    "title": paper["title"],
    "url": paper["url"],
    "source": paper["source"],
    "extraction_note": paper["extraction_note"],
  }}));
}

async fn fetch_url(client: &reqwest::Client, url: &str, turn: &Arc<Turn>) -> Result<reqwest::Response, ToolError> {
  tokio::select! {
    biased;
    _ = turn.stopped() => Err(ToolError(STOPPED.into())),
    result = client.get(url).header("User-Agent", "ResearchGO/0.1").send() => result.map_err(|e| ToolError(e.to_string())),
  }
}

fn literature_network_error(operation: &str, url: &str, error: reqwest::Error) -> ToolError {
  let error = error.without_url();
  ToolError(format!("{operation} failed for {url}: {error} (debug: {error:?})"))
}

fn scholar_pdf_url(result: &Value) -> Option<&str> {
  result["resources"].as_array()?.iter()
    .filter(|resource| resource["file_format"].as_str().is_some_and(|format| format.eq_ignore_ascii_case("PDF")))
    .find_map(|resource| resource["link"].as_str())
}

fn scholar_year(result: &Value) -> Option<u16> {
  result["publication_info"]["summary"].as_str()?
    .split(|c: char| !c.is_ascii_digit())
    .filter(|part| part.len() == 4)
    .filter_map(|part| part.parse::<u16>().ok())
    .find(|year| (1500..=2100).contains(year))
}

fn reference_slug(title: &str) -> String {
  let slug: String = title.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
  let slug = slug.split('-').filter(|part| !part.is_empty()).take(8).collect::<Vec<_>>().join("-");
  if slug.is_empty() { "paper".into() } else { slug }
}

fn html_to_text(html: &str) -> String {
  let mut text = String::with_capacity(html.len());
  let mut in_tag = false;
  for c in html.chars() {
    match c { '<' => in_tag = true, '>' => { in_tag = false; text.push('\n'); }, _ if !in_tag => text.push(c), _ => {} }
  }
  text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    .lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
}

fn extract_chapters(text: &str) -> Vec<Value> {
  text.lines().enumerate().filter_map(|(line, value)| {
    let value = value.trim();
    let is_heading = value.len() <= 120 && !value.ends_with('.') && (value.chars().all(|c| !c.is_lowercase()) || value.starts_with(|c: char| c.is_ascii_digit()));
    is_heading.then(|| json!({ "title": value, "line": line + 1 }))
  }).take(100).collect()
}

fn extract_evidence(text: &str, chapters: &[Value]) -> Vec<Value> {
  let mut evidence = Vec::new();
  for (line, value) in text.lines().enumerate() {
    let lower = value.to_ascii_lowercase();
    if lower.contains("we find") || lower.contains("our results") || lower.contains("outperform") || lower.contains("significant") || lower.contains("conclude") {
      let chapter = chapters.iter().rev().find(|item| item["line"].as_u64().unwrap_or(0) <= (line + 1) as u64).and_then(|item| item["title"].as_str()).unwrap_or("");
      evidence.push(json!({ "line": line + 1, "chapter": chapter, "text": value.trim() }));
    }
  }
  evidence.into_iter().take(100).collect()
}

/// Absolute paths can address any directory. Relative paths stay within `root`.
fn resolve(root: &Path, raw: &str) -> Result<PathBuf, ToolError> {
  let raw = raw.trim();
  if raw.is_empty() {
    return Err(ToolError("path is empty".into()));
  }

  let path = Path::new(raw);
  if path.is_absolute() {
    return Ok(normalize(path));
  }
  // Windows drive-relative and rooted paths are not relative to `root`.
  if path.has_root() || matches!(path.components().next(), Some(Component::Prefix(_))) {
    return Err(ToolError("use a fully qualified absolute path or a relative path within the current directory".into()));
  }
  let candidate = root.join(path);

  let resolved = normalize(&candidate);
  let base = normalize(root);
  if !resolved.starts_with(&base) {
    return Err(ToolError(format!(
      "relative path `{raw}` is outside the current directory; use an absolute path"
    )));
  }
  Ok(resolved)
}

/// Collapses `.` and `..` lexically.
///
/// Normalize lexically so paths for files that do not exist yet also work.
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

fn looks_binary(bytes: &[u8]) -> bool {
  bytes[..bytes.len().min(8192)].contains(&0)
}

fn read_tool_typed(root: &Path, args: &ReadArgs) -> Result<ToolOutput, ToolError> {
  let raw = &args.path;
  let path = resolve(root, raw)?;

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

fn write_tool_typed(root: &Path, args: &WriteArgs) -> Result<ToolOutput, ToolError> {
  let raw = &args.path;
  let content = &args.content;
  let path = resolve(root, raw)?;

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .map_err(|e| ToolError(format!("cannot create {}: {e}", parent.display())))?;
  }

  let existed = path.exists();
  let before = if existed {
        let bytes = fs::read(&path)
            .map_err(|e| ToolError(format!("cannot read `{raw}` before writing: {e}")))?;
    String::from_utf8_lossy(&bytes).into_owned()
  } else {
    String::new()
  };
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
    patch: Some(FilePatch {
      path: path.display().to_string(),
      created: !existed,
      bytes: content.len(),
      diff: unified_diff(&raw, &before, &content),
    }),
  })
}

fn edit_tool_typed(root: &Path, args: &EditArgs) -> Result<ToolOutput, ToolError> {
  let raw = &args.path;
  let old = &args.old_string;
  let new = &args.new_string;
  let path = resolve(root, raw)?;

  let bytes = fs::read(&path).map_err(|e| ToolError(format!("cannot read `{raw}`: {e}")))?;
  if looks_binary(&bytes) {
    return Err(ToolError(format!("`{raw}` looks like a binary file")));
  }
  let text = String::from_utf8_lossy(&bytes).to_string();

  let count = text.matches(old.as_str()).count();
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

  let updated = text.replacen(old.as_str(), new.as_str(), 1);
  fs::write(&path, &updated).map_err(|e| ToolError(format!("cannot write `{raw}`: {e}")))?;

  Ok(ToolOutput {
    content: format!("Edited {raw}"),
    ok: true,
    summary: format!("edited {}", short_path(root, &path)),
    patch: Some(FilePatch {
      path: path.display().to_string(),
      created: false,
      bytes: updated.len(),
      diff: unified_diff(&raw, &text, &updated),
    }),
  })
}

/// A stable, familiar unified diff for the transcript. Three context lines
/// match Git's default while every changed line remains present in its hunk.
fn unified_diff(path: &str, before: &str, after: &str) -> String {
  TextDiff::from_lines(before, after)
    .unified_diff()
    .context_radius(3)
    .header(path, path)
    .to_string()
}

fn shell() -> &'static str {
    if cfg!(windows) { "cmd" } else { "sh" }
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

async fn bash_tool_typed(
    root: &Path,
    args: &BashArgs,
    turn: &Arc<Turn>,
) -> Result<ToolOutput, ToolError> {
    let command = &args.command;
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
  // `kill_on_drop` so a stop takes the process with it: a build left running
  // after the turn was stopped keeps a file handle, burns a core, and can
  // rewrite a source file the next turn has already read. Dropping the future
  // is what kills it, which is why the stop is raced here rather than polled.
  let output = tokio::select! {
    biased;
    _ = turn.stopped() => return Err(ToolError(STOPPED.into())),
    result = tokio::time::timeout(
      std::time::Duration::from_secs(BASH_TIMEOUT_SECS),
      child.kill_on_drop(true).current_dir(root).output(),
    ) => result,
  };
  let output = match output {
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

fn glob_tool_typed(root: &Path, args: &GlobArgs) -> Result<ToolOutput, ToolError> {
    let pattern = &args.pattern;
    let matcher = compile_glob(pattern, args.case_sensitive)?;
  let base = match args.path.as_deref() {
    Some(path) => resolve(root, path)?,
    None => normalize(root),
  };
  let mut hits = Vec::new();
  let mut files = 0usize;
  let mut truncated = false;
    for entry in workspace_walk(&base, args.respect_ignore) {
    let entry = entry.map_err(|e| ToolError(format!("cannot walk workspace: {e}")))?;
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
    files += 1;
    let rel = relative(&base, entry.path());
        if matcher.is_match(&rel) {
            hits.push(relative(root, entry.path()));
        }
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
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|t| t.is_dir())
                || !SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
        })
    .build()
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn grep_tool_typed(root: &Path, args: &GrepArgs) -> Result<ToolOutput, ToolError> {
    let needle = &args.pattern;
  if needle.is_empty() {
    return Err(ToolError("pattern is empty".into()));
  }

    let base = match args.path.as_deref() {
    Some(sub) if !sub.trim().is_empty() => resolve(root, sub)?,
    _ => normalize(root),
  };
  if !base.exists() {
    let where_ = sub_or_root(args);
    return Err(ToolError(format!("`{where_}` does not exist")));
  }

  let matcher = RegexMatcherBuilder::new()
    .case_insensitive(!args.case_sensitive)
    .fixed_strings(args.literal)
    .line_terminator(Some(b'\n'))
    .crlf(true)
    .multi_line(true)
    .build(&needle)
    .map_err(|e| ToolError(format!("invalid regular expression `{needle}`: {e}")))?;
  let include = match args.include.as_deref() {
    None => None,
    Some(value) => Some(compile_glob(value, args.case_sensitive)?),
  };
  let mut hits = Vec::new();
  let mut files = 0usize;
  let mut truncated = false;
  let mut skipped_large = 0;
  let mut shortened = false;
  let mut searcher = SearcherBuilder::new()
    .line_terminator(grep_matcher::LineTerminator::crlf())
    .binary_detection(grep_searcher::BinaryDetection::quit(b'\0')).line_number(true).build();
  for entry in workspace_walk(&base, args.respect_ignore) {
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

fn sub_or_root(args: &GrepArgs) -> String {
  args.path.clone().unwrap_or_else(|| "workspace root".to_string())
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ResearchLiteratureArgs {
  query: String,
  #[serde(default)]
  year_from: Option<u16>,
  #[serde(default)]
  year_to: Option<u16>,
  #[serde(default = "default_paper_limit")]
  max_papers: usize,
}

fn default_paper_limit() -> usize { 5 }

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

  #[test]
  fn scholar_resources_select_pdf_and_publication_year() {
    let result = json!({
      "resources": [
        { "file_format": "HTML", "link": "https://example.org/article" },
        { "file_format": "PDF", "link": "https://example.org/paper.pdf" }
      ],
      "publication_info": { "summary": "A Author - Journal of Science, 2024 - example.org" }
    });
    assert_eq!(scholar_pdf_url(&result), Some("https://example.org/paper.pdf"));
    assert_eq!(scholar_year(&result), Some(2024));
    assert_eq!(scholar_pdf_url(&json!({})), None);
    assert_eq!(scholar_year(&json!({"publication_info": {"summary": "Unknown year"}})), None);
  }

  #[tokio::test]
  async fn literature_requires_key_before_creating_files() {
    let fixture = Fixture::new();
    let args = parse_args::<ResearchLiteratureArgs>("research_literature", &json!({"query": "machine learning"})).unwrap();
    let error = research_literature_with_key(&fixture.0, &args, &Turn::detached(), "").await.err().expect("missing key must fail");
    assert!(error.to_string().contains("SerpApi API key is not configured"));
    assert!(!fixture.0.join("reference").exists());
  }

  #[test]
  fn unified_diff_keeps_created_and_replaced_text() {
    let created = unified_diff("new.txt", "", "first\nsecond\n");
    assert!(created.contains("--- new.txt\n+++ new.txt"));
    assert!(created.contains("+first\n+second"));

    let edited = unified_diff("note.txt", "before\nkeep\n", "after\nkeep\n");
    assert!(edited.contains("-before\n+after"));
    assert!(edited.contains(" keep"));
  }

  struct Fixture(PathBuf);
  impl Fixture {
    fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "researchgo-search-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
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
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
  }

  #[test]
  fn file_tools_accept_external_absolute_paths_and_reject_relative_escape() {
    let workspace = Fixture::new();
    let external = Fixture::new();
    external.write("note.txt", "before\n");
    let path = external.0.join("note.txt");
    assert!(read_tool_typed(&workspace.0, &ReadArgs { path: path.to_string_lossy().into_owned() }).unwrap().content.contains("before"));
    edit_tool_typed(&workspace.0, &EditArgs { path: path.to_string_lossy().into_owned(), old_string: "before".into(), new_string: "after".into() }).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "after\n");
    write_tool_typed(&workspace.0, &WriteArgs { path: path.to_string_lossy().into_owned(), content: "written\n".into() }).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "written\n");
    let glob = glob_tool(&workspace.0, &json!({"pattern": "*.txt", "path": external.0})).unwrap();
    assert_eq!(glob.content, relative(&workspace.0, &path));
    let grep = grep_tool(&workspace.0, &json!({"pattern": "written", "path": external.0})).unwrap();
    assert!(grep.content.contains(&format!("{}:1: written", relative(&workspace.0, &path))));
    assert!(read_tool_typed(&workspace.0, &ReadArgs { path: "../note.txt".into() }).is_err());
    assert!(write_tool_typed(&workspace.0, &WriteArgs { path: "../note.txt".into(), content: "x".into() }).is_err());
    assert!(edit_tool_typed(&workspace.0, &EditArgs { path: "../note.txt".into(), old_string: "x".into(), new_string: "y".into() }).is_err());
    assert!(glob_tool(&workspace.0, &json!({"pattern": "*", "path": ".."})).is_err());
    assert!(grep_tool(&workspace.0, &json!({"pattern": "x", "path": ".."})).is_err());
    workspace.write("sub/local.txt", "local");
    assert_eq!(glob_tool(&workspace.0, &json!({"pattern": "*.txt", "path": "sub"})).unwrap().content, "sub/local.txt");
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
        assert_eq!(
            glob_tool(&fixture.0, &args).unwrap().content,
            ".hidden/a.txt"
        );
        let out = glob_tool(
            &fixture.0,
            &json!({"pattern":"**/*.txt","respectIgnore":false}),
        )
        .unwrap();
    assert!(out.content.contains("ignored/a.txt"));
    assert!(out.content.contains("private/a.txt"));
    assert!(!out.content.contains("node_modules"));
    let out = grep_tool(&fixture.0, &json!({"pattern":"needle"})).unwrap();
    assert_eq!(out.content, ".hidden/a.txt:1: needle");
        let out = grep_tool(
            &fixture.0,
            &json!({"pattern":"needle","path":"ignored/a.txt"}),
        )
        .unwrap();
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
    if cfg!(windows) { PathBuf::from("C:\\work") } else { PathBuf::from("/work") }
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
    assert!(resolve(&root(), "../etc/passwd").is_err());
    assert!(resolve(&root(), "../../.ssh/authorized_keys").is_err());
    assert!(resolve(&root(), "a/../../../etc/passwd").is_err());
  }

  #[test]
  fn absolute_paths_outside_workspace_resolve() {
    let outside = root().parent().unwrap().join("other-project").join("file.txt");
    assert_eq!(resolve(&root(), outside.to_str().unwrap()).unwrap(), outside);
  }

  #[test]
  fn in_workspace_paths_resolve() {
        assert_eq!(
            resolve(&root(), "src/main.rs").unwrap(),
            root().join("src/main.rs")
        );
    // `..` that stays inside is allowed: it is how a model addresses a sibling.
        assert_eq!(
            resolve(&root(), "src/../lib/a.ts").unwrap(),
            root().join("lib/a.ts")
        );
        assert_eq!(
            resolve(&root(), "./x.txt").unwrap(),
            root().join("x.txt")
        );
    // An absolute path already inside the root is fine.
        assert_eq!(
            resolve(&root(), root().join("y.txt").to_str().unwrap()).unwrap(),
            root().join("y.txt")
        );
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
        assert!(
            matches_glob("src/main.rs", "src/**/*.rs"),
            "`**/` also matches zero directories"
        );
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
        let out = bash_tool(
            &fixture.0,
            &json!({ "command": failing_command() }),
            &Turn::detached(),
        )
        .await
        .unwrap();

    assert!(!out.ok, "a command that exits non-zero is not a success");
    // The output is the whole point of the call. Turning the failure into a
    // `ToolError` would have kept the tick honest but thrown away everything the
    // model needs in order to fix its own command.
        assert!(
            out.content.contains("failed"),
            "the exit status must reach the model: {}",
            out.content
        );
  }

  #[tokio::test]
  async fn a_successful_command_reports_success_and_no_summary() {
    let fixture = Fixture::new();
        let out = bash_tool(
            &fixture.0,
            &json!({ "command": succeeding_command() }),
            &Turn::detached(),
        )
        .await
        .unwrap();

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
        assert!(
            description.contains(expected),
            "description omits the host dialect: {description}"
        );
        assert!(
            description.contains(shell()),
            "the description names a different shell than the one spawned"
        );
    }

    #[test]
    fn generated_schemas_match_the_wire_contract() {
        let defs = tool_defs();
        assert_eq!(defs.len(), 7);
        let read = defs
            .iter()
            .find(|d| d["function"]["name"] == "read")
            .unwrap();
        assert_eq!(read["function"]["parameters"]["type"], "object");
        assert_eq!(read["function"]["parameters"]["required"], json!(["path"]));

        let grep = defs
            .iter()
            .find(|d| d["function"]["name"] == "grep")
            .unwrap();
        assert!(
            grep["function"]["parameters"]["properties"]
                .get("caseSensitive")
                .is_some()
        );
        let required = grep["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert_eq!(required, &[json!("pattern")]);
        assert!(!required.iter().any(|field| field == "literal"));
        assert!(!required.iter().any(|field| field == "caseSensitive"));
        assert!(!required.iter().any(|field| field == "respectIgnore"));

        let glob = defs
            .iter()
            .find(|d| d["function"]["name"] == "glob")
            .unwrap();
        let required = glob["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert_eq!(required, &[json!("pattern")]);
    }

    #[test]
    fn tool_allow_list_is_applied_by_the_protocol_adapter() {
        let defs = tool_defs_for(ToolProtocol::OpenAiChatCompletions, Some(&["read", "grep"]));
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0]["function"]["name"], "read");
        assert_eq!(defs[1]["function"]["name"], "grep");
    }

    #[test]
    fn arguments_are_strictly_typed_and_reject_unknown_fields() {
        assert!(validate_args("grep", &json!({"pattern": "x", "path": 42})).is_err());
        assert!(validate_args("read", &json!({"path": "a", "extra": true})).is_err());
        assert!(validate_args("read", &json!({"path": "a"})).is_ok());
  }

  #[tokio::test]
  async fn unknown_tool_names_itself() {
    let err = match run(&root(), "deploy", &json!({}), "c1", &Turn::detached()).await {
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
        let err = match run(
            &root(),
            "read",
            &json!({ "path": "src" }),
            "c1",
            &Turn::detached(),
        )
        .await
        {
      Ok(out) => panic!("expected an error, got: {}", out.summary),
      Err(err) => err.0,
    };
    assert!(err.contains("directory") || err.contains("cannot read"));
  }
}
