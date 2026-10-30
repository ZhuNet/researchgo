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
  /// plain success is worse --the transcript claims a test suite passed that
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
/// Bounds paper processing; the shared browser serializes page navigation and
/// downloads so manual interaction cannot be interrupted by another paper.
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
           its output attached rather than as an error --read that output before \
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
        "description": "Search and download papers into reference/. After downloading, you can read reference/index.md and use it as the local literature library for a paper writing.",
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
/// row on screen. It is a *result* rather than a silence on purpose --a tool
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
  let openalex_key = super::config::openalex_secret().map_err(ToolError)?;
  research_literature_with_progress(root, args, turn, &openalex_key, &|progress| literature_progress(call_id, turn.serial(), progress)).await
}

async fn research_literature_with_progress(root: &Path, args: &ResearchLiteratureArgs, turn: &Arc<Turn>, openalex_key: &str, progress: &(dyn Fn(Value) + Sync)) -> Result<ToolOutput, ToolError> {
  let query = args.query.trim();
  if query.is_empty() { return Err(ToolError("query is empty".into())); }
  if args.max_papers == 0 || args.max_papers > 20 { return Err(ToolError("max_papers must be between 1 and 20".into())); }
  if let (Some(from), Some(to)) = (args.year_from, args.year_to) {
    if from > to { return Err(ToolError("year_from must not be after year_to".into())); }
  }
  let client = reqwest::Client::builder()
    .connect_timeout(LITERATURE_CONNECT_TIMEOUT)
    .read_timeout(LITERATURE_READ_TIMEOUT)
    .timeout(std::time::Duration::from_secs(90))
    .build()
    .map_err(|e| ToolError(format!("cannot build literature HTTP client: {e}")))?;
  let reference_dir = root.join("reference");
  let existing = local_literature_dois(&reference_dir)?;
  let results = search_openalex(&client, args, openalex_key, turn).await?;
  let results = select_new_papers(results, existing, args.max_papers);
  progress(json!({ "stage": "retrieving", "total": results.len() }));
  if !results.is_empty() { fs::create_dir_all(&reference_dir).map_err(|e| ToolError(format!("cannot create reference directory: {e}")))?; }

  // Queue paper processing with a bound; the browser lock protects navigation
  // and downloads while the surrounding result processing remains unchanged.
  use futures_util::stream::{self, StreamExt};
  let work: Vec<(usize, LiteratureRecord)> = results.into_iter().enumerate().collect();
  let tasks = stream::iter(work.into_iter().map(|(index, detail)| {
    let reference_dir = &reference_dir;
    let turn = turn.clone();
    async move {
      if turn.is_stopped() { return Err(ToolError(STOPPED.into())); }
      let paper = process_one_paper(reference_dir, &turn, index, &detail, progress).await?;
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

#[derive(Clone, Debug, serde::Serialize, Deserialize)]
struct LiteratureRecord {
  doi: String,
  bib: Value,
  abstract_text: String,
  cited_by_count: u64,
  pdf_url: Option<String>,
}

fn normalize_doi(raw: &str) -> Option<String> {
  let raw = raw.trim().to_ascii_lowercase();
  let raw = raw.strip_prefix("https://doi.org/").or_else(|| raw.strip_prefix("http://doi.org/"))
    .or_else(|| raw.strip_prefix("https://dx.doi.org/")).or_else(|| raw.strip_prefix("doi:")).unwrap_or(&raw).trim();
  let decoded = reqwest::Url::parse(&format!("https://doi.org/{raw}")).ok()?;
  if decoded.query().is_some() || decoded.fragment().is_some() { return None; }
  let raw = raw.to_string();
  let (prefix, suffix) = raw.split_once('/')?;
  (prefix.starts_with("10.") && (4..=9).contains(&prefix[3..].len()) && prefix[3..].chars().all(|c| c.is_ascii_digit())
    && !suffix.is_empty() && !raw.chars().any(char::is_whitespace)).then_some(raw)
}

fn openalex_record(work: &Value) -> Option<LiteratureRecord> {
  let doi = normalize_doi(work["doi"].as_str()?)?;
  let abstract_text = work["abstract_inverted_index"].as_object().map(|index| {
    let mut words: Vec<(usize, &str)> = index.iter().flat_map(|(word, positions)| positions.as_array().into_iter().flatten()
      .filter_map(|position| position.as_u64().map(|position| (position as usize, word.as_str())))).collect();
    words.sort_by_key(|(position, _)| *position);
    words.into_iter().map(|(_, word)| word).collect::<Vec<_>>().join(" ")
  }).unwrap_or_default();
  let pdf_url = std::iter::once(work["best_oa_location"]["pdf_url"].as_str())
    .chain(work["locations"].as_array().into_iter().flatten().map(|location| location["pdf_url"].as_str()))
    .flatten().find(|url| !url.trim().is_empty()).map(str::to_string);
  Some(LiteratureRecord {
    doi,
    bib: work["biblio"].clone(),
    abstract_text,
    cited_by_count: work["cited_by_count"].as_u64().unwrap_or(0),
    pdf_url,
  })
}

async fn literature_json(client: &reqwest::Client, url: &str, params: &[(String, String)], turn: &Arc<Turn>) -> Result<Value, ToolError> {
  tokio::select! {
    biased;
    _ = turn.stopped() => Err(ToolError(STOPPED.into())),
    result = async {
      let response = client.get(url).query(params).header("User-Agent", "ResearchGO/0.1").send().await
        .map_err(|_| ToolError("Literature metadata service request failed".into()))?;
      if !response.status().is_success() { return Err(ToolError(format!("Literature metadata service returned HTTP {}", response.status()))); }
      response.json::<Value>().await.map_err(|_| ToolError("Invalid literature metadata response".into()))
    } => result,
  }
}

async fn search_openalex(client: &reqwest::Client, args: &ResearchLiteratureArgs, api_key: &str, turn: &Arc<Turn>) -> Result<Vec<LiteratureRecord>, ToolError> {
  let mut filters = vec!["type:article|proceedings-article".to_string()];
  if let Some(year) = args.year_from { filters.push(format!("from_publication_date:{year}-01-01")); }
  if let Some(year) = args.year_to { filters.push(format!("to_publication_date:{year}-12-31")); }
  let mut params = vec![("search".into(), args.query.trim().into()), ("per-page".into(), "100".into()), ("filter".into(), filters.join(","))];
  if !api_key.is_empty() { params.push(("api_key".into(), api_key.to_string())); }
  let body = literature_json(client, "https://api.openalex.org/works", &params, turn).await?;
  let results = body["results"].as_array().ok_or_else(|| ToolError("Invalid OpenAlex results".into()))?;
  Ok(results.iter().filter_map(openalex_record).collect())
}

fn local_literature_dois(reference_dir: &Path) -> Result<std::collections::HashSet<String>, ToolError> {
  let mut found = std::collections::HashSet::new();
  if !reference_dir.exists() { return Ok(found); }
    for entry in WalkBuilder::new(reference_dir).hidden(false).ignore(false).git_ignore(false).build() {
      let entry = entry.map_err(|_| ToolError("Cannot inspect local literature library".into()))?;
      if entry.path().file_name().is_some_and(|name| name == "index.md") {
        let text = fs::read_to_string(entry.path()).map_err(|_| ToolError("Cannot read local literature index".into()))?;
        for line in text.lines() {
          if let Some(doi) = line.strip_prefix("- DOI:") {
            let doi = doi.trim().trim_matches('`').trim();
            if let Some(doi) = normalize_doi(doi) { found.insert(doi); }
          }
        }
      }
  }
  Ok(found)
}

fn select_new_papers(records: Vec<LiteratureRecord>, mut existing: std::collections::HashSet<String>, max_papers: usize) -> Vec<LiteratureRecord> {
  records.into_iter().filter(|paper| existing.insert(paper.doi.clone())).take(max_papers).collect()
}

async fn process_one_paper(
  reference_dir: &Path,
  turn: &Arc<Turn>,
  index: usize,
  detail: &LiteratureRecord,
  progress: &(dyn Fn(Value) + Sync),
) -> Result<Value, ToolError> {
  progress(json!({ "stage": "paper", "index": index, "doi": detail.doi }));
  // A DOI-derived name is stable across queries and cannot overwrite a different
  // paper merely because its title/index happens to match.
  use std::hash::{Hash, Hasher};
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  detail.doi.hash(&mut hasher);
  let identity = format!("{:016x}", hasher.finish());
  let base = reference_dir.join(identity);
  let doi_url = format!("https://doi.org/{}", detail.doi);
  let mut source = json!({ "status": "unavailable", "path": Value::Null, "url": doi_url });
  let mut note = "Official PDF could not be downloaded".to_string();
  let downloaded = match official_pdf(detail, turn).await {
    Ok((bytes, page_url, metadata)) => Some((bytes, page_url, metadata)),
    Err(_) if turn.is_stopped() => return Err(ToolError(STOPPED.into())),
    Err(error) => { note = error.0; None },
  };
   if let Some((bytes, page_url, _metadata)) = downloaded {
    let path = base.with_extension("pdf");
    let temp = base.with_extension("pdf.part");
    fs::write(&temp, &bytes).and_then(|_| fs::rename(&temp, &path)).map_err(|_| ToolError("Cannot save official PDF".into()))?;
    source = json!({ "status": "pdf", "path": path, "url": page_url });
    note.clear();
     let markdown_path = update_reference_index(reference_dir, detail, &page_url, &path)?;
     let result = json!({ "doi": detail.doi, "url": page_url, "pdf_path": path, "markdown_path": markdown_path, "source": source, "extraction_note": Value::Null });
    emit_result_progress(progress, index, &result);
    return Ok(result);
  }
  if turn.is_stopped() { return Err(ToolError(STOPPED.into())); }
   let result = json!({ "doi": detail.doi, "url": doi_url, "source": source, "markdown_path": Value::Null, "extraction_note": note });
  emit_result_progress(progress, index, &result);
  Ok(result)
}

static LOGIN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LOGIN_CLOSED: tokio::sync::Notify = tokio::sync::Notify::const_new();
static BROWSER_DOWNLOAD: std::sync::Mutex<Option<BrowserDownload>> = std::sync::Mutex::new(None);
static PAPER_PAGE_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct BrowserDownload {
  path: PathBuf,
  result: Option<Result<Vec<u8>, String>>,
  in_progress: bool,
}

async fn paper_browser() -> Result<tauri::WebviewWindow, ToolError> {
  use tauri::Manager;
  let app = LITERATURE_APP.get().ok_or_else(|| ToolError("Paper browser is unavailable".into()))?;
  if let Some(window) = app.get_webview_window("literature-login") {
    return Ok(window);
  }
  let profile = app.path().app_local_data_dir().map_err(|e| ToolError(e.to_string()))?.join("paper-browser");
  fs::create_dir_all(&profile).map_err(|e| ToolError(e.to_string()))?;
  let window = tauri::WebviewWindowBuilder::new(app, "literature-login", tauri::WebviewUrl::External(reqwest::Url::parse("about:blank").unwrap()))
    .title("文献下载 --完成登录、验证或下载后关闭窗口以继续")
    .inner_size(1100.0, 800.0).visible(false).data_directory(profile)
    .on_page_load(|_, payload| {
      PAPER_PAGE_READY.store(matches!(payload.event(), tauri::webview::PageLoadEvent::Finished), std::sync::atomic::Ordering::SeqCst);
    })
    .on_new_window(|url, _| {
      // Publisher PDF buttons often target a new tab. Keep their navigation
      // inside the same controlled browser session and download handler.
      if let Some(window) = LITERATURE_APP.get().and_then(|app| app.get_webview_window("literature-login")) {
        let _ = window.navigate(url);
      }
      tauri::webview::NewWindowResponse::Deny
    })
    .on_download(|_, event| {
      let Ok(mut active) = BROWSER_DOWNLOAD.lock() else { return false; };
      let Some(active) = active.as_mut() else { return false; };
      match event {
        tauri::webview::DownloadEvent::Requested { destination, .. } => {
          *destination = active.path.clone();
          active.in_progress = true;
          true
        }
        tauri::webview::DownloadEvent::Finished { success, path, .. } => {
          if path.as_ref().is_some_and(|path| path != &active.path) { return true; }
          active.in_progress = false;
          active.result = Some(if success {
            fs::read(&active.path).map_err(|e| e.to_string()).and_then(|bytes| {
              if bytes.len() <= 50 * 1024 * 1024 && bytes.starts_with(b"%PDF-") { Ok(bytes) }
              else { Err("Browser download is not a valid PDF or exceeds 50 MiB".into()) }
            })
          } else { Err("Browser download failed".into()) });
          let _ = fs::remove_file(&active.path);
          true
        }
        _ => true,
      }
    }).build().map_err(|e| ToolError(e.to_string()))?;
  let handle = window.clone();
  window.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      let _ = handle.hide();
      LOGIN_CLOSED.notify_one();
    }
  });
  Ok(window)
}

/// Shows the paper page so the user can log in. Closing the window hides it
/// and lets the caller retry the download with the browser's new session.
async fn institution_login(turn: &Arc<Turn>) -> Result<(), ToolError> {
  let window = paper_browser().await?;
  // Discard a close permit left over from a previously interrupted task.
  use futures_util::FutureExt;
  while LOGIN_CLOSED.notified().now_or_never().is_some() {}
  let notified = LOGIN_CLOSED.notified();
  tokio::pin!(notified);
  notified.as_mut().enable();
  window.show().map_err(|e| ToolError(e.to_string()))?;
  let _ = window.set_focus();
  let hidden = window.clone();
  tokio::select! {
    biased;
    _ = turn.stopped() => { let _ = hidden.hide(); Err(ToolError(STOPPED.into())) },
    _ = notified => Ok(()),
  }
}

async fn official_pdf(detail: &LiteratureRecord, turn: &Arc<Turn>) -> Result<(Vec<u8>, String, Value), ToolError> {
  if let Some(pdf_url) = &detail.pdf_url {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(90)).build()
      .map_err(|e| ToolError(e.to_string()))?;
    let response = tokio::select! {
      biased;
      _ = turn.stopped() => return Err(ToolError(STOPPED.into())),
      response = client.get(pdf_url).header("User-Agent", "ResearchGO/0.1").send() =>
        response.map_err(|e| ToolError(format!("PDF request failed: {e}")))?,
    };
    if response.status().is_success() {
      let bytes = response.bytes().await.map_err(|e| ToolError(format!("PDF response failed: {e}")))?.to_vec();
      if bytes.len() <= 50 * 1024 * 1024 && bytes.starts_with(b"%PDF-") {
        return Ok((bytes, pdf_url.clone(), json!({"doi": detail.doi})));
      }
    }
    return Err(ToolError("OpenAlex PDF URL did not return a valid PDF".into()));
  }

  let _guard = tokio::select! {
    biased;
    _ = turn.stopped() => return Err(ToolError(STOPPED.into())),
    guard = LOGIN_LOCK.lock() => guard,
  };
  let window = paper_browser().await?;
  use tauri::Manager;
  let path = window.app_handle().path().app_cache_dir().map_err(|e| ToolError(e.to_string()))?
    .join(format!("paper-{}.part", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
  fs::create_dir_all(path.parent().unwrap()).map_err(|e| ToolError(e.to_string()))?;
  *BROWSER_DOWNLOAD.lock().unwrap() = Some(BrowserDownload { path: path.clone(), result: None, in_progress: false });
  window.navigate(reqwest::Url::parse(&format!("https://doi.org/{}", detail.doi)).map_err(|e| ToolError(e.to_string()))?)
    .map_err(|e| ToolError(e.to_string()))?;
  institution_login(turn).await?;

  // Closing the dialog is the user's final signal. A completed download is
  // consumed immediately; an active one is allowed to finish. If neither
  // exists, there is nothing left to wait for and this paper fails now.
  let has_download = BROWSER_DOWNLOAD.lock().unwrap().as_ref()
    .is_some_and(|state| state.in_progress || state.result.is_some());
  if !has_download {
    let _ = window.hide();
    let _ = window.eval("window.stop()");
    *BROWSER_DOWNLOAD.lock().unwrap() = None;
    let _ = fs::remove_file(path);
    return Err(ToolError("No browser download was started".into()));
  }

  let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
  let result = loop {
    if let Some(result) = BROWSER_DOWNLOAD.lock().unwrap().as_mut().and_then(|state| state.result.take()) {
      break result.map(|bytes| (bytes, format!("https://doi.org/{}", detail.doi), json!({"doi": detail.doi})));
    }
    if tokio::time::Instant::now() >= deadline { break Err("Browser download did not finish".into()); }
    tokio::select! {
      biased;
      _ = turn.stopped() => break Err(STOPPED.into()),
      _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
    }
  };
  let _ = window.hide();
  let _ = window.eval("window.stop()");
  *BROWSER_DOWNLOAD.lock().unwrap() = None;
  let _ = fs::remove_file(path);
  result.map_err(ToolError)
}
/// The reference library is one Markdown index and the PDFs themselves.
static REFERENCE_INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn update_reference_index(reference_dir: &Path, detail: &LiteratureRecord, page_url: &str, pdf_path: &Path) -> Result<PathBuf, ToolError> {
  let _guard = REFERENCE_INDEX_LOCK.lock().unwrap();
  let markdown_path = reference_dir.join("index.md");
  let mut markdown = if markdown_path.exists() { fs::read_to_string(&markdown_path).map_err(|_| ToolError("Cannot read reference index".into()))? } else { "# References\n\n".into() };
  let marker = format!("<!-- DOI:{} -->", detail.doi);
  let entry = reference_entry(detail, page_url, pdf_path);
  if let Some(start) = markdown.find(&marker) {
    let end = markdown[start..].find("\n<!-- DOI:").map(|offset| start + offset).unwrap_or(markdown.len());
    markdown.replace_range(start..end, &entry);
  } else { markdown.push_str(&entry); }
  let temp = markdown_path.with_extension("md.part");
  fs::write(&temp, markdown)
    .and_then(|_| fs::rename(&temp, &markdown_path)).map_err(|_| ToolError("Cannot save reference Markdown index".into()))?;
  Ok(markdown_path)
}

fn reference_entry(detail: &LiteratureRecord, _page_url: &str, pdf_path: &Path) -> String {
  format!("<!-- DOI:{} -->\n## {}\n\n- DOI: `{}`\n- Bib: `{}`\n- 摘要: {}\n- 引用数: {}\n- PDF: `{}`\n\n",
    detail.doi, detail.doi, detail.doi, detail.bib, detail.abstract_text,
    detail.cited_by_count, pdf_path.display())
}

fn emit_result_progress(progress: &(dyn Fn(Value) + Sync), index: usize, paper: &Value) {
  progress(json!({ "stage": "result", "index": index, "paper": {
    "title": paper["title"],
    "url": paper["url"],
      "pdf_path": paper["pdf_path"],
      "markdown_path": paper["markdown_path"],
    "source": paper["source"],
    "extraction_note": paper["extraction_note"],
  }}));
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
      "\n[truncated at {MAX_READ_LINES} lines --use grep to find later parts]\n"
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
/// `$HOME` and `&&` go out unchanged --and on `cmd.exe` every one of them fails,
/// with an error that names the command rather than the shell, so the model has
/// no way to work out that the whole batch was written for the wrong machine and
/// retries the same syntax until the turn is over.
///
/// So the dialect is stated where the model is already looking when it decides
/// what to type, in the one tool it is about to call. The substitutions are
/// named as pairs (`ls` �?`dir`) rather than described, because a model copying
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
     glob --dir /s and dir /b are the closest. Commands that ship their own \
     executable (npm, cargo, git, python, node) are called by name and behave \
     as they do elsewhere."
  } else {
    "The command runs in sh on a POSIX system. Use POSIX syntax only: && and | \
     and > and 2> all work, but [[ ]], arrays, local, source, process \
     substitution <(...) and $(< file) do not --use [ ], plain variables, \
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
  // string means the same thing to either. Anything more elaborate --a pipeline
  // built in Rust --would be a second shell nobody debugged.
  let mut child = Command::new(shell());
  if cfg!(windows) {
    child.arg("/C").arg(&command);
  } else {
    child.arg("-c").arg(&command);
  }

  // `tokio::process`, not `std::process`: the turn holds the transcript lock
  // across this await, and a blocking `output()` there would pin a blocking
  // thread for as long as the command runs --and forever, if the command does.
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
  // reassuring log and then died --`npm test` with two failing cases, a
  // `git diff --quiet` finding changes --looks byte-identical to one that
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
    if text.chars().count() > 200 { *self.shortened = true; line.push_str("--"); }
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
  fn openalex_work_uses_doi_for_dedup_and_keeps_download_metadata() {
    let work = json!({
      "type": "article", "doi": "https://doi.org/10.1234/TEST", "title": "Paper", "publication_year": 2024,
      "abstract_inverted_index": {"result": [1], "Our": [0]},
      "primary_location": {"source": {"display_name": "Journal"}, "landing_page_url": "https://publisher.example/paper", "pdf_url": "https://files.example/paper.pdf"}
    });
    let paper = openalex_record(&work).unwrap();
    assert_eq!(paper.doi, "10.1234/test");
    assert!(openalex_record(&json!({"doi": null})).is_none());
    // Local conversion does not reject a record based on version, venue, or host.
    assert!(openalex_record(&json!({"doi": "10.1234/test", "type": "preprint"})).is_some());
  }

  #[test]
  fn reference_library_is_one_markdown_plus_pdfs() {
    let fixture = Fixture::new();
    let reference = fixture.0.join("reference");
    fs::create_dir_all(&reference).unwrap();
    let detail = LiteratureRecord { doi: "10.1234/example".into(), bib: json!({"title":"Test title","author":"Ada Example"}), abstract_text: "Detailed abstract".into(), cited_by_count: 3, pdf_url: None };
    let pdf_path = reference.join("0000000000000001.pdf");
    fs::write(&pdf_path, b"%PDF-test").unwrap();
    let markdown_path = update_reference_index(&reference, &detail, "https://publisher.example/article", &pdf_path).unwrap();
    assert_eq!(markdown_path, reference.join("index.md"));
    let markdown = fs::read_to_string(&markdown_path).unwrap();
    assert!(markdown.contains("Test title") && markdown.contains("Detailed abstract") && markdown.contains("0000000000000001.pdf"));
    assert!(!reference.join("papers.json").exists());
  }

  #[test]
  fn literature_deduplicates_local_and_batch_dois_before_limiting() {
    let fixture = Fixture::new();
    fixture.write("reference/index.md", "# References\n\n- DOI: `10.1234/EXISTING`\n");
    let existing = local_literature_dois(&fixture.0.join("reference")).unwrap();
  let record = |doi: &str| LiteratureRecord { doi: doi.into(), bib: Value::Null, abstract_text: String::new(), cited_by_count: 0, pdf_url: None };
    let selected = select_new_papers(vec![record("10.1234/existing"), record("10.1234/new"), record("10.1234/new"), record("10.1234/other")], existing, 2);
    assert_eq!(selected.len(), 2);
    assert_eq!(selected[1].doi, "10.1234/other");
    assert!(normalize_doi("10.1234/a b").is_none());
    assert!(normalize_doi("not a doi").is_none());
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
    fixture.write("long.txt", format!("needle{}", "x".repeat(250)));
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
