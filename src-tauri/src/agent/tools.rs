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
/// The single longest wait for any network step (a Google Scholar search, the
/// PDF itself). It is a safety net against a very slow network, not a
/// substitute for handling errors: HTTP 4xx/5xx, parse failures and invalid
/// PDFs are real errors and are reported as such, never swallowed by a timeout.
const LITERATURE_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(60);
/// Bounds paper downloads across the batch. One paper's pipeline (write index,
/// download PDF) stays serial and atomic, while different papers run in
/// parallel so a slow PDF host never stalls the batch.
const LITERATURE_CONCURRENCY: usize = 4;
/// How many Google Scholar results one search asks for. SerpAPI caps this at
/// 20, which is also the ceiling the tool enforces on `max_papers`, so one
/// page always covers the whole batch before deduplication.
const SERPAPI_RESULTS: usize = 20;
/// A realistic desktop Chrome User-Agent for direct PDF downloads: some hosts
/// refuse requests without a browser-like UA.
const DOWNLOAD_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/// PDFs larger than this are rejected: a bigger body is almost certainly an
/// HTML error page or a redirected landing page.
const DOWNLOAD_MAX_PDF: usize = 50 * 1024 * 1024;
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
  let serpapi_key = super::config::serpapi_secret().map_err(ToolError)?;
  research_literature_with_progress(root, args, turn, &serpapi_key, &|progress| literature_progress(call_id, turn.serial(), progress)).await
}

async fn research_literature_with_progress(root: &Path, args: &ResearchLiteratureArgs, turn: &Arc<Turn>, serpapi_key: &str, progress: &(dyn Fn(Value) + Sync)) -> Result<ToolOutput, ToolError> {
  let query = args.query.trim();
  if query.is_empty() { return Err(ToolError("query is empty".into())); }
  if args.max_papers == 0 || args.max_papers > 20 { return Err(ToolError("max_papers must be between 1 and 20".into())); }
  if let (Some(from), Some(to)) = (args.year_from, args.year_to) {
    if from > to { return Err(ToolError("year_from must not be after year_to".into())); }
  }
  // One client, one timeout. The single longest wait is a safety net against a
  // very slow network; errors (HTTP status, parse failure, bad PDF) are errors.
  let client = reqwest::Client::builder()
    .timeout(LITERATURE_MAX_WAIT)
    .build()
    .map_err(|e| ToolError(format!("cannot build literature HTTP client: {e}")))?;
  let reference_dir = root.join("reference");
  let existing = local_literature_dois(&reference_dir)?;
  // A search failure or a stop surfaces here as an error: the search step shows
  // a red cross and the reason, and nothing is downloaded.
  let results = search_serpapi(&client, args, serpapi_key, turn).await?;
  let results = select_new_papers(results, existing, args.max_papers);
  progress(json!({ "stage": "retrieving", "total": results.len() }));
  if !results.is_empty() { fs::create_dir_all(&reference_dir).map_err(|e| ToolError(format!("cannot create reference directory: {e}")))?; }

  // Papers download in parallel (bounded); each paper's own pipeline stays
  // serial and atomic. A stop aborts the batch; a per-paper failure only marks
  // that paper and the others continue.
  use futures_util::stream::{self, StreamExt};
  let work: Vec<(usize, LiteratureRecord)> = results.into_iter().enumerate().collect();
  let tasks = stream::iter(work.into_iter().map(|(index, detail)| {
    let reference_dir = &reference_dir;
    let client = client.clone();
    let turn = turn.clone();
    async move {
      if turn.is_stopped() { return Err(ToolError(STOPPED.into())); }
      let paper = process_one_paper(reference_dir, &client, &turn, index, &detail, progress).await?;
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
  // Only papers whose PDF actually landed on disk count as downloaded; a paper
  // recorded in the index without a PDF resource is not one.
  let downloaded = papers.iter().filter(|p| p["source"]["status"] == "pdf").count();
  Ok(ToolOutput {
    content: serde_json::to_string_pretty(&json!({ "query": query, "papers": papers })).map_err(|e| ToolError(format!("cannot encode research result: {e}")))?,
    summary: format!("{downloaded} of {count} papers downloaded"),
    ok: count == 0 || paper_failures < count,
    patch: None,
  })
}

#[derive(Clone, Debug, serde::Serialize, Deserialize)]
struct LiteratureRecord {
  /// The paper's DOI, which is also its deduplication identity. A result
  /// without a resolvable DOI is rejected outright: the reference library is
  /// keyed by DOI, so a paper without one has no stable identity.
  doi: String,
  title: String,
  /// The citation text as Google Scholar provides it (its `publication_info`
  /// summary), used verbatim instead of building a BibTeX string ourselves.
  bib: String,
  /// Authors, comma-separated, as Google Scholar lists them.
  authors: String,
  abstract_text: String,
  cited_by_count: u64,
  /// The paper's landing page from the search result.
  url: String,
  /// The first resource link that ends in `.pdf`, if any; this is what gets
  /// downloaded, and it is empty when Google Scholar exposes no PDF.
  pdf_link: Option<String>,
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

/// One parsed Google Scholar organic result, possibly without a DOI yet.
///
/// Google Scholar's search response carries no DOI field, so a hit whose
/// landing page or citation summary does not embed one keeps the cite link and
/// resolves its DOI through the `google_scholar_cite` engine's BibTeX export
/// before it is accepted into the library.
struct SerpapiHit {
  record: LiteratureRecord,
  /// The `serpapi_cite_link` from the result, used to fetch the BibTeX export
  /// (and thus the DOI) when the result does not already expose one.
  cite_link: Option<String>,
}

fn serpapi_hit(result: &Value) -> Option<SerpapiHit> {
  let title = result["title"].as_str()?.trim().to_string();
  if title.is_empty() { return None; }
  let url = result["link"].as_str().unwrap_or("").trim().to_string();
  let bib = result["publication_info"]["summary"].as_str().unwrap_or("").trim().to_string();
  // A result that already carries a DOI on its landing page or in its summary
  // needs no extra request; the cite link is kept for the ones that do not.
  let doi = doi_from_url(&url).or_else(|| doi_from_text(&bib)).unwrap_or_default();
  let cite_link = result["inline_links"]["serpapi_cite_link"].as_str().map(str::to_string);
  let authors = result["publication_info"]["authors"]
    .as_array()
    .map(|arr| arr.iter().filter_map(|a| a["name"].as_str()).collect::<Vec<_>>().join(", "))
    .unwrap_or_default();
  let abstract_text = result["snippet"].as_str().unwrap_or("").trim().to_string();
  let cited_by_count = result["inline_links"]["cited_by"]["total"].as_u64().unwrap_or(0);
  let pdf_link = result["resources"]
    .as_array()
    .and_then(|arr| arr.iter().filter_map(|r| {
      let link = r["link"].as_str()?.trim();
      if link.to_lowercase().ends_with(".pdf") { Some(link.to_string()) } else { None }
    }).next());
  Some(SerpapiHit {
    record: LiteratureRecord { doi, title, bib, authors, abstract_text, cited_by_count, url, pdf_link },
    cite_link,
  })
}

/// Extracts a DOI from a result's landing-page URL when it is a DOI resolver
/// link.
fn doi_from_url(url: &str) -> Option<String> {
  let url = url.trim();
  if url.is_empty() { return None; }
  let raw = url.strip_prefix("https://doi.org/").or_else(|| url.strip_prefix("http://doi.org/"))
    .or_else(|| url.strip_prefix("https://dx.doi.org/")).or_else(|| url.strip_prefix("http://dx.doi.org/"))?;
  normalize_doi(raw)
}

/// Scans a text blob (the citation summary, which some Google Scholar results
/// embed a DOI in) for a `10.xxxx/...` DOI and returns the first valid one.
fn doi_from_text(text: &str) -> Option<String> {
  let bytes = text.as_bytes();
  let mut i = 0;
  while i + 3 < bytes.len() {
    if bytes[i] == b'1' && bytes[i + 1] == b'0' && bytes[i + 2] == b'.' {
      let mut digits = 0;
      let mut j = i + 3;
      while j < bytes.len() && bytes[j].is_ascii_digit() && digits < 9 {
        digits += 1;
        j += 1;
      }
      if (4..=9).contains(&digits) && j < bytes.len() && bytes[j] == b'/' {
        let mut end = j + 1;
        while end < bytes.len() && !bytes[end].is_ascii_whitespace()
          && bytes[end] != b',' && bytes[end] != b';' && bytes[end] != b')' && bytes[end] != b']' {
          end += 1;
        }
        if let Some(doi) = normalize_doi(&text[i..end]) { return Some(doi); }
      }
    }
    i += 1;
  }
  None
}

async fn literature_json(client: &reqwest::Client, url: &str, params: &[(String, String)], turn: &Arc<Turn>) -> Result<Value, ToolError> {
  tokio::select! {
    biased;
    _ = turn.stopped() => Err(ToolError(STOPPED.into())),
    result = async {
      let response = client.get(url).query(params).header("User-Agent", "ResearchGO/0.1").send().await
        .map_err(|_| ToolError("SerpAPI search request failed".into()))?;
      if !response.status().is_success() { return Err(ToolError(format!("SerpAPI returned HTTP {}", response.status()))); }
      response.json::<Value>().await.map_err(|_| ToolError("Invalid SerpAPI response".into()))
    } => result,
  }
}

async fn search_serpapi(client: &reqwest::Client, args: &ResearchLiteratureArgs, api_key: &str, turn: &Arc<Turn>) -> Result<Vec<LiteratureRecord>, ToolError> {
  // One query, relevance-ordered as Google Scholar returns it. No article /
  // conference split: Google Scholar's own ranking already mixes venues, and
  // the model asks for whatever mix best answers the query.
  let mut params = vec![
    ("engine".into(), "google_scholar".into()),
    ("q".into(), args.query.trim().into()),
    ("num".into(), SERPAPI_RESULTS.to_string()),
  ];
  if !api_key.is_empty() { params.push(("api_key".into(), api_key.to_string())); }
  if let Some(year) = args.year_from { params.push(("as_ylo".into(), year.to_string())); }
  if let Some(year) = args.year_to { params.push(("as_yhi".into(), year.to_string())); }
  let body = literature_json(client, "https://serpapi.com/search", &params, turn).await?;
  let results = body["organic_results"].as_array().ok_or_else(|| ToolError("Invalid SerpAPI results".into()))?;
  let hits: Vec<SerpapiHit> = results.iter().filter_map(serpapi_hit).collect();

  // Results that did not expose a DOI already resolve it through the cite
  // engine, in parallel. A stop aborts; a per-result failure (cite API error,
  // expired BibTeX link, no DOI in the export) drops that result and the
  // others continue.
  use futures_util::stream::{self, StreamExt};
  let work = hits.into_iter().map(|hit| {
    let client = client.clone();
    let turn = turn.clone();
    let api_key = api_key.to_string();
    async move {
      if !hit.record.doi.is_empty() { return Ok::<SerpapiHit, ToolError>(hit); }
      let Some(cite_link) = &hit.cite_link else { return Ok(hit); };
      match fetch_citation_doi(&client, cite_link, &api_key, &turn).await {
        Ok(Some(doi)) => {
          let mut record = hit.record;
          record.doi = doi;
          Ok(SerpapiHit { record, cite_link: None })
        }
        Ok(None) => Ok(hit),
        Err(error) => Err(error),
      }
    }
  });
  let hits: Vec<Result<SerpapiHit, ToolError>> = stream::iter(work).buffer_unordered(LITERATURE_CONCURRENCY).collect().await;
  let hits: Vec<SerpapiHit> = hits.into_iter().collect::<Result<Vec<_>, _>>()?;

  // Only results with a resolved DOI enter the library: the reference index is
  // keyed by DOI, so a paper without one has no stable identity to deduplicate
  // on and no way to be cited.
  Ok(hits.into_iter().filter(|hit| !hit.record.doi.is_empty()).map(|hit| hit.record).collect())
}

/// Resolves a result's DOI through the Google Scholar Cite engine.
///
/// The cite engine returns citation strings in several styles and a set of
/// export links. BibTeX is the only one that carries the DOI, so the BibTeX
/// link is downloaded and parsed. A failure here — cite API error, expired
/// link, no BibTeX export, no DOI in the export — returns `Ok(None)` so the
/// result is simply dropped, unless the turn was stopped, which propagates.
async fn fetch_citation_doi(client: &reqwest::Client, cite_link: &str, api_key: &str, turn: &Arc<Turn>) -> Result<Option<String>, ToolError> {
  let mut url = reqwest::Url::parse(cite_link).map_err(|_| ToolError("Invalid SerpAPI cite link".into()))?;
  if !api_key.is_empty() { url.query_pairs_mut().append_pair("api_key", api_key); }
  let body = match literature_json(client, url.as_str(), &[], turn).await {
    Ok(body) => body,
    Err(error) if error.0 == STOPPED => return Err(error),
    Err(_) => return Ok(None),
  };
  let bibtex_url = body["links"].as_array()
    .and_then(|links| links.iter().find(|l| l["name"].as_str() == Some("BibTeX")))
    .and_then(|l| l["link"].as_str());
  let Some(bibtex_url) = bibtex_url else { return Ok(None); };
  let bytes = match http_bytes(client, bibtex_url, turn).await {
    Ok(bytes) => bytes,
    Err(error) if error.0 == STOPPED => return Err(error),
    Err(_) => return Ok(None),
  };
  let bibtex = String::from_utf8_lossy(&bytes);
  Ok(extract_doi_from_bibtex(&bibtex))
}

/// Extracts the `doi = {...}` field from a BibTeX entry.
fn extract_doi_from_bibtex(bibtex: &str) -> Option<String> {
  let key = "doi = {";
  let start = bibtex.find(key)?;
  let rest = &bibtex[start + key.len()..];
  let end = rest.find('}')?;
  normalize_doi(&rest[..end])
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
  client: &reqwest::Client,
  turn: &Arc<Turn>,
  index: usize,
  detail: &LiteratureRecord,
  progress: &(dyn Fn(Value) + Sync),
) -> Result<Value, ToolError> {
  progress(json!({ "stage": "paper", "index": index, "title": detail.title, "doi": detail.doi }));
  // A DOI-derived name is stable across queries and cannot overwrite a different
  // paper merely because its title/index happens to match.
  let identity = paper_identity(detail);
  let pdf_path = reference_dir.join(format!("{identity}.pdf"));

  // Step 1: record the metadata entry in the reference index, atomically. The
  // markdown is written before the PDF so a failed download still leaves the
  // paper's bibliographic record in the library.
  let entry = reference_entry(detail, &pdf_path);
  let markdown_path = match persist_reference_entry(reference_dir, detail, &entry) {
    Ok(path) => path,
    Err(error) => {
      let result = json!({ "doi": detail.doi, "title": detail.title, "url": detail.url, "pdf_path": Value::Null, "markdown_path": Value::Null, "source": { "status": "unavailable", "url": detail.url, "path": Value::Null }, "extraction_note": error.0 });
      emit_result_progress(progress, index, &result);
      return Ok(result);
    }
  };

  // Step 2: if Google Scholar exposed a PDF resource link, download it. No link
  // means the paper is recorded in the index but has no local PDF.
  let Some(pdf_url) = detail.pdf_link.clone() else {
    let result = json!({ "doi": detail.doi, "title": detail.title, "url": detail.url, "pdf_path": Value::Null, "markdown_path": markdown_path, "source": { "status": "html", "url": Value::Null, "path": Value::Null }, "extraction_note": Value::Null });
    emit_result_progress(progress, index, &result);
    return Ok(result);
  };
  let bytes = match download_pdf(client, &pdf_url, turn).await {
    Ok(bytes) => bytes,
    Err(error) => {
      if turn.is_stopped() { return Err(ToolError(STOPPED.into())); }
      let result = json!({ "doi": detail.doi, "title": detail.title, "url": detail.url, "pdf_path": Value::Null, "markdown_path": markdown_path, "source": { "status": "unavailable", "url": pdf_url, "path": Value::Null }, "extraction_note": error.0 });
      emit_result_progress(progress, index, &result);
      return Ok(result);
    }
  };
  if let Err(error) = fs::write(&pdf_path, &bytes) {
    let result = json!({ "doi": detail.doi, "title": detail.title, "url": detail.url, "pdf_path": Value::Null, "markdown_path": markdown_path, "source": { "status": "unavailable", "url": pdf_url, "path": Value::Null }, "extraction_note": format!("cannot save PDF: {error}") });
    emit_result_progress(progress, index, &result);
    return Ok(result);
  }
  let result = json!({ "doi": detail.doi, "title": detail.title, "url": detail.url, "pdf_path": pdf_path, "markdown_path": markdown_path, "source": { "status": "pdf", "url": pdf_url, "path": pdf_path }, "extraction_note": Value::Null });
  emit_result_progress(progress, index, &result);
  Ok(result)
}

/// A stable filename stem derived from the paper's DOI.
fn paper_identity(detail: &LiteratureRecord) -> String {
  use std::hash::{Hash, Hasher};
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  detail.doi.hash(&mut hasher);
  format!("{:016x}", hasher.finish())
}

/// Downloads a PDF from its resource link, held in memory.
///
/// The bytes stay in memory until the caller writes them to disk, so a failure
/// here cannot leave a partial file behind.
async fn download_pdf(client: &reqwest::Client, url: &str, turn: &Arc<Turn>) -> Result<Vec<u8>, ToolError> {
  let bytes = http_bytes(client, url, turn).await?;
  if !bytes.starts_with(b"%PDF-") || bytes.len() > DOWNLOAD_MAX_PDF {
    return Err(ToolError("downloaded file is not a valid PDF".into()));
  }
  Ok(bytes)
}

/// GETs `url` and returns the body bytes, aborting the moment the turn stops.
/// The client's single timeout is the whole "longest wait" safety net; a
/// non-success HTTP status is a real error and is reported, never timed out.
async fn http_bytes(client: &reqwest::Client, url: &str, turn: &Arc<Turn>) -> Result<Vec<u8>, ToolError> {
  tokio::select! {
    biased;
    _ = turn.stopped() => Err(ToolError(STOPPED.into())),
    result = async {
      let response = client.get(url)
        .header("User-Agent", DOWNLOAD_UA)
        // This client is built without a decompression feature, and some PDF
        // hosts gzip-encode the file when a client advertises gzip. Force
        // identity so we receive the raw `%PDF-` bytes instead of a gzip
        // wrapper we could not read.
        .header("Accept-Encoding", "identity")
        .send().await
        .map_err(|e| ToolError(format!("request failed: {e}")))?;
      if !response.status().is_success() { return Err(ToolError(format!("HTTP {}", response.status()))); }
      response.bytes().await.map(|b| b.to_vec()).map_err(|_| ToolError("response read failed".into()))
    } => result,
  }
}

/// The reference library is one Markdown index and the PDFs themselves.
static REFERENCE_INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Commits one paper's metadata entry atomically.
///
/// The whole reference index is first staged to a `.part` file and only then
/// renamed into place, under one lock. A paper's markdown record lands on disk
/// before its PDF is downloaded, so a failed download still leaves the
/// bibliographic record in the library.
fn persist_reference_entry(reference_dir: &Path, detail: &LiteratureRecord, entry: &str) -> Result<PathBuf, ToolError> {
  let _guard = REFERENCE_INDEX_LOCK.lock().unwrap();
  let markdown_path = reference_dir.join("index.md");
  let markdown = if markdown_path.exists() {
    fs::read_to_string(&markdown_path).map_err(|_| ToolError("Cannot read reference index".into()))?
  } else {
    "# References\n\n".into()
  };
  let markdown = upsert_reference_entry(&markdown, detail, entry);
  let md_temp = markdown_path.with_extension("md.part");
  if let Err(error) = fs::write(&md_temp, markdown).and_then(|_| fs::rename(&md_temp, &markdown_path)) {
    let _ = fs::remove_file(&md_temp);
    return Err(ToolError(format!("Cannot save reference index: {error}")));
  }
  Ok(markdown_path)
}

/// Returns `markdown` with this paper's entry added, or replaced when the paper
/// (by DOI) is already present. Pure, so it is testable without touching disk.
fn upsert_reference_entry(markdown: &str, detail: &LiteratureRecord, entry: &str) -> String {
  let marker = format!("<!-- DOI:{} -->", detail.doi);
  if let Some(start) = markdown.find(&marker) {
    let end = markdown[start..].find("\n<!-- DOI:").map(|offset| start + offset).unwrap_or(markdown.len());
    let mut out = markdown.to_string();
    out.replace_range(start..end, entry);
    out
  } else {
    format!("{markdown}{entry}")
  }
}

fn reference_entry(detail: &LiteratureRecord, pdf_path: &Path) -> String {
  let mut out = format!("<!-- DOI:{} -->\n## {}\n\n", detail.doi, detail.title);
  out.push_str(&format!("- DOI: `{}`\n", detail.doi));
  if !detail.authors.is_empty() {
    out.push_str(&format!("- 作者: {}\n", detail.authors));
  }
  if !detail.bib.is_empty() {
    // Google Scholar's own citation line, used verbatim.
    out.push_str(&format!("- 引用: {}\n", detail.bib));
  }
  if !detail.abstract_text.is_empty() {
    out.push_str(&format!("- 摘要: {}\n", detail.abstract_text));
  }
  out.push_str(&format!("- 引用数: {}\n", detail.cited_by_count));
  out.push_str(&format!("- PDF: `{}`\n\n", pdf_path.display()));
  out
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
  fn serpapi_result_builds_record_from_google_scholar_fields() {
    // A result with a DOI resolver link and a PDF resource.
    let result = json!({
      "title": "A Test Paper", "result_id": "rid-1",
      "link": "https://doi.org/10.1234/TEST",
      "publication_info": {
        "summary": "Ada Lovelace - Journal of Tests, 2024 - example.org",
        "authors": [{"name": "Ada Lovelace"}, {"name": "Grace Hopper"}]
      },
      "snippet": "A detailed abstract snippet.",
      "inline_links": {"cited_by": {"total": 42}},
      "resources": [{"title": "example.org", "file_format": "PDF", "link": "https://example.org/paper.pdf"}]
    });
    let paper = serpapi_hit(&result).unwrap().record;
    assert_eq!(paper.doi, "10.1234/test");
    assert_eq!(paper.title, "A Test Paper");
    // The citation is Google Scholar's own summary, used verbatim.
    assert_eq!(paper.bib, "Ada Lovelace - Journal of Tests, 2024 - example.org");
    assert_eq!(paper.authors, "Ada Lovelace, Grace Hopper");
    assert_eq!(paper.abstract_text, "A detailed abstract snippet.");
    assert_eq!(paper.cited_by_count, 42);
    assert_eq!(paper.pdf_link.as_deref(), Some("https://example.org/paper.pdf"));
    assert_eq!(paper.url, "https://doi.org/10.1234/TEST");

    // A DOI embedded in the citation summary is picked up when the landing
    // page is not a DOI resolver link.
    let from_summary = serpapi_hit(&json!({
      "title": "Summary DOI", "result_id": "rid-2",
      "link": "https://example.org/article",
      "publication_info": {"summary": "B Author - Journal, 2020 - doi.org/10.5678/abc", "authors": [{"name": "B Author"}]},
      "resources": [{"title": "host", "file_format": "PDF", "link": "https://host.example/book.pdf"}]
    })).unwrap().record;
    assert_eq!(from_summary.doi, "10.5678/abc");

    // A resource that is not a PDF is ignored; only a `.pdf` link is taken.
    let no_pdf = serpapi_hit(&json!({
      "title": "No PDF", "result_id": "rid-3",
      "link": "https://doi.org/10.1234/abc",
      "publication_info": {"summary": "C Author - 2021 - example.org", "authors": [{"name": "C Author"}]},
      "resources": [{"title": "HTML", "file_format": "HTML", "link": "https://example.org/page"}]
    })).unwrap().record;
    assert!(no_pdf.pdf_link.is_none());

    // No DOI in the result itself: the hit keeps the cite link so the search
    // can resolve the DOI through the cite engine before deciding to keep it.
    let no_doi = serpapi_hit(&json!({
      "title": "No DOI", "result_id": "rid-4",
      "link": "https://scholar.google.com/scholar?cluster=123",
      "publication_info": {"summary": "D Author - 2022 - books.google.com", "authors": [{"name": "D Author"}]},
      "inline_links": {"serpapi_cite_link": "https://serpapi.com/search.json?engine=google_scholar_cite&q=rid-4"}
    })).unwrap();
    assert!(no_doi.record.doi.is_empty());
    assert_eq!(no_doi.cite_link.as_deref(), Some("https://serpapi.com/search.json?engine=google_scholar_cite&q=rid-4"));

    // Missing title is rejected.
    assert!(serpapi_hit(&json!({"title": "", "result_id": "x", "link": "https://doi.org/10.1234/x"})).is_none());
  }

  #[test]
  fn doi_from_url_and_text_extract_doi_resolver_links() {
    assert_eq!(doi_from_url("https://doi.org/10.1234/TEST").as_deref(), Some("10.1234/test"));
    assert_eq!(doi_from_url("https://dx.doi.org/10.1234/abc").as_deref(), Some("10.1234/abc"));
    assert_eq!(doi_from_url("http://doi.org/10.1234/abc").as_deref(), Some("10.1234/abc"));
    assert!(doi_from_url("https://scholar.google.com/scholar?cluster=123").is_none());
    assert!(doi_from_url("").is_none());
    // DOI embedded in prose is found; trailing punctuation is not part of it.
    assert_eq!(doi_from_text("See doi.org/10.1234/abc (2020)").as_deref(), Some("10.1234/abc"));
    assert_eq!(doi_from_text("A - B, 2021 - 10.1234/def").as_deref(), Some("10.1234/def"));
    assert!(doi_from_text("no doi here").is_none());
  }

  #[test]
  fn bibtex_export_yields_doi_field() {
    // A typical BibTeX export carries the DOI in a `doi = {...}` field.
    let bibtex = "@article{smith2024title,\n  title = {A Title},\n  author = {Smith, John},\n  journal = {Journal of Tests},\n  year = {2024},\n  doi = {10.1234/abc},\n}\n";
    assert_eq!(extract_doi_from_bibtex(bibtex).as_deref(), Some("10.1234/abc"));
    // No DOI field yields nothing.
    assert!(extract_doi_from_bibtex("@article{x,\n  title = {T},\n}\n").is_none());
    assert!(extract_doi_from_bibtex("not bibtex").is_none());
  }

  #[test]
  fn reference_library_is_one_markdown_plus_pdfs() {
    let fixture = Fixture::new();
    let reference = fixture.0.join("reference");
    fs::create_dir_all(&reference).unwrap();
    let detail = LiteratureRecord {
      doi: "10.1234/example".into(), title: "Test title".into(),
      bib: "Ada Lovelace - Journal of Tests, 2024 - example.org".into(),
      authors: "Ada Lovelace".into(), abstract_text: "Detailed abstract".into(),
      cited_by_count: 3, url: "https://doi.org/10.1234/example".into(),
      pdf_link: Some("https://example.org/paper.pdf".into()),
    };
    let pdf_path = reference.join("0000000000000001.pdf");
    let entry = reference_entry(&detail, &pdf_path);
    let markdown_path = persist_reference_entry(&reference, &detail, &entry).unwrap();
    assert_eq!(markdown_path, reference.join("index.md"));
    let markdown = fs::read_to_string(&markdown_path).unwrap();
    // The heading is the paper title, and Google Scholar's citation line is
    // embedded verbatim rather than rebuilt from structured metadata.
    assert!(markdown.contains("## Test title"));
    assert!(markdown.contains("Ada Lovelace - Journal of Tests, 2024 - example.org"));
    assert!(markdown.contains("作者: Ada Lovelace"));
    assert!(markdown.contains("Detailed abstract") && markdown.contains("引用数: 3"));
    assert!(!reference.join("papers.json").exists());
    // Saving the same DOI again replaces its entry instead of duplicating it.
    let detail2 = LiteratureRecord {
      doi: "10.1234/example".into(), title: "Replaced title".into(),
      bib: String::new(), authors: String::new(), abstract_text: String::new(),
      cited_by_count: 0, url: String::new(), pdf_link: None,
    };
    let entry2 = reference_entry(&detail2, &pdf_path);
    persist_reference_entry(&reference, &detail2, &entry2).unwrap();
    let markdown = fs::read_to_string(&markdown_path).unwrap();
    assert_eq!(markdown.matches("<!-- DOI:10.1234/example -->").count(), 1);
    assert!(markdown.contains("## Replaced title"));
  }

  #[test]
  fn literature_deduplicates_local_and_batch_dois_before_limiting() {
    let fixture = Fixture::new();
    fixture.write("reference/index.md", "# References\n\n- DOI: `10.1234/EXISTING`\n");
    let existing = local_literature_dois(&fixture.0.join("reference")).unwrap();
    let record = |doi: &str| LiteratureRecord {
      doi: doi.into(), title: String::new(), bib: String::new(), authors: String::new(),
      abstract_text: String::new(), cited_by_count: 0, url: String::new(), pdf_link: None,
    };
    let selected = select_new_papers(
      vec![record("10.1234/existing"), record("10.1234/new"), record("10.1234/new"), record("10.1234/other")],
      existing, 2,
    );
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
