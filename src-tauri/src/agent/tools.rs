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
/// The single longest wait for any network step (an OpenAlex search, a Sci-Hub
/// page, the PDF itself). It is a safety net against a very slow network, not a
/// substitute for handling errors: HTTP 4xx/5xx, parse failures and invalid
/// PDFs are real errors and are reported as such, never swallowed by a timeout.
const LITERATURE_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(60);
/// Bounds paper downloads across the batch. One paper's pipeline (download,
/// metadata, write PDF, write index) stays serial and atomic, while different
/// papers run in parallel so a slow Sci-Hub response never stalls the batch.
const LITERATURE_CONCURRENCY: usize = 4;
/// Top-level publishers that qualify a journal article as high quality. The
/// filter uses `host_organization_lineage` so every imprint and sub-brand under
/// a publisher is matched. Conference papers are deliberately NOT restricted by
/// publisher: the leading CS/ML venues are run by societies, universities and
/// independent bodies (NeurIPS, ICML, ICLR, AAAI, ACL/EMNLP...) rather than by
/// commercial publishers, so restricting them would drop the papers the user
/// actually wants.
const LITERATURE_PUBLISHERS: &str = "P4310319965|P4310320990|P4310320595|P4310320449|P4310320017|P4310319808|P4310319798|P4310311648|P4310311721|P4310313990|P4310319811|P4310320083|P4310320061|P4310320261|P4310320006|P4310320556|P4310318547|P4310319945";
/// Only the fields the reference library needs, to keep the search payload and
/// the transfer small. `relevance_score` is fetched so the two search queries
/// (journal articles and conference papers) can be merged by relevance.
const OPENALEX_SELECT: &str = "id,doi,display_name,publication_year,type,authorships,primary_location,locations,biblio,cited_by_count,abstract_inverted_index,relevance_score";
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
  let results = search_openalex(&client, args, openalex_key, turn).await?;
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
  let downloaded = count - paper_failures;
  Ok(ToolOutput {
    content: serde_json::to_string_pretty(&json!({ "query": query, "papers": papers })).map_err(|e| ToolError(format!("cannot encode research result: {e}")))?,
    summary: format!("{downloaded} of {count} papers downloaded"),
    ok: count == 0 || paper_failures < count,
    patch: None,
  })
}

#[derive(Clone, Debug, serde::Serialize, Deserialize)]
struct LiteratureRecord {
  doi: String,
  title: String,
  /// BibTeX citation text, built from the work's structured metadata.
  bib: String,
  abstract_text: String,
  cited_by_count: u64,
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
  // Published journal articles and conference papers enter the library. The
  // search queries ask OpenAlex for the same set, so the conversion and the
  // search cannot disagree about what a literature record is -- and a unit
  // test of this function asserts the same boundary the search enforces. (The
  // search additionally restricts journal articles to the publisher allowlist;
  // the conversion itself only needs to agree on the work type.)
  if !matches!(work["type"].as_str(), Some("article" | "proceedings-article" | "conference-paper")) {
    return None;
  }
  let doi = normalize_doi(work["doi"].as_str()?)?;
  let title = work["display_name"]
    .as_str()
    .or_else(|| work["title"].as_str())
    .unwrap_or("untitled paper")
    .to_string();
  let abstract_text = work["abstract_inverted_index"].as_object().map(|index| {
    let mut words: Vec<(usize, &str)> = index.iter().flat_map(|(word, positions)| positions.as_array().into_iter().flatten()
      .filter_map(|position| position.as_u64().map(|position| (position as usize, word.as_str())))).collect();
    words.sort_by_key(|(position, _)| *position);
    words.into_iter().map(|(_, word)| word).collect::<Vec<_>>().join(" ")
  }).unwrap_or_default();
  let bib = bibtex_entry(work, &doi, &title);
  Some(LiteratureRecord {
    doi,
    title,
    bib,
    abstract_text,
    cited_by_count: work["cited_by_count"].as_u64().unwrap_or(0),
  })
}

/// A BibTeX citation built from the work's structured metadata.
///
/// OpenAlex returns no ready-made citation string, so the reference library
/// builds one from the fields it does return: title, authors, year, venue,
/// volume and pages. That is the citation text the model can paste straight
/// into a `.bib` file when it writes a paper from the library.
fn bibtex_entry(work: &Value, doi: &str, title: &str) -> String {
  let authors: Vec<String> = work["authorships"]
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|author| {
      author["author"]["display_name"]
        .as_str()
        .or_else(|| author["raw_author_name"].as_str())
        .map(str::to_string)
    })
    .collect();
  let year = work["publication_year"].as_u64().unwrap_or(0);
  // The venue lives on the primary location, or on whichever location has one;
  // many works expose the source only on a non-primary location.
  let venue = std::iter::once(work["primary_location"]["source"]["display_name"].as_str())
    .chain(
      work["locations"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|location| location["source"]["display_name"].as_str()),
    )
    .flatten()
    .find(|name| !name.trim().is_empty())
    .unwrap_or("")
    .to_string();
  let volume = work["biblio"]["volume"].as_str().unwrap_or("");
  let pages = {
    let first = work["biblio"]["first_page"].as_str().unwrap_or("");
    let last = work["biblio"]["last_page"].as_str().unwrap_or("");
    if !first.is_empty() && !last.is_empty() && first != last {
      format!("{first}--{last}")
    } else {
      first.to_string()
    }
  };
  // A stable, human-typed key: first author's surname + year + first title word.
  let surname = authors
    .first()
    .and_then(|author| author.split_whitespace().last())
    .unwrap_or("")
    .to_lowercase();
  let headword = title.split_whitespace().next().unwrap_or("").to_lowercase();
  let key: String = format!("{surname}{year}{headword}")
    .chars()
    .filter(|c| c.is_ascii_alphanumeric())
    .collect();
  let key = if key.is_empty() { format!("ref{year}") } else { key };
  let conference = matches!(work["type"].as_str(), Some("proceedings-article" | "conference-paper"));
  let entry_type = if conference { "inproceedings" } else { "article" };

  let mut out = String::new();
  out.push_str(&format!("@{entry_type}{{{key},\n"));
  out.push_str(&format!("  title = {{{}}},\n", bibtex_escape(title)));
  out.push_str(&format!(
    "  author = {{{}}},\n",
    authors.iter().map(|a| bibtex_escape(a)).collect::<Vec<_>>().join(" and ")
  ));
  let venue_field = if conference { "booktitle" } else { "journal" };
  if !venue.is_empty() {
    out.push_str(&format!("  {venue_field} = {{{}}},\n", bibtex_escape(&venue)));
  }
  if year > 0 {
    out.push_str(&format!("  year = {{{year}}},\n"));
  }
  if !volume.is_empty() {
    out.push_str(&format!("  volume = {{{}}},\n", bibtex_escape(volume)));
  }
  if !pages.is_empty() {
    out.push_str(&format!("  pages = {{{}}},\n", bibtex_escape(&pages)));
  }
  out.push_str(&format!("  doi = {{{}}},\n", bibtex_escape(doi)));
  out.push_str("}\n");
  out
}

/// Escapes the characters BibTeX / LaTeX treat specially inside a braced value.
fn bibtex_escape(value: &str) -> String {
  let mut out = String::with_capacity(value.len());
  for ch in value.chars() {
    match ch {
      '\\' | '{' | '}' | '%' | '#' | '&' | '_' | '$' => {
        out.push('\\');
        out.push(ch);
      }
      _ => out.push(ch),
    }
  }
  out
}

async fn literature_json(client: &reqwest::Client, url: &str, params: &[(String, String)], turn: &Arc<Turn>) -> Result<Value, ToolError> {
  tokio::select! {
    biased;
    _ = turn.stopped() => Err(ToolError(STOPPED.into())),
    result = async {
      let response = client.get(url).query(params).header("User-Agent", "ResearchGO/0.1").send().await
        .map_err(|_| ToolError("OpenAlex search request failed".into()))?;
      if !response.status().is_success() { return Err(ToolError(format!("OpenAlex returned HTTP {}", response.status()))); }
      response.json::<Value>().await.map_err(|_| ToolError("Invalid OpenAlex response".into()))
    } => result,
  }
}

async fn search_openalex(client: &reqwest::Client, args: &ResearchLiteratureArgs, api_key: &str, turn: &Arc<Turn>) -> Result<Vec<LiteratureRecord>, ToolError> {
  // Two queries, merged by relevance. Journal articles must come from the
  // publisher allowlist (the quality gate); conference papers are unrestricted
  // because the leading CS/ML venues are not commercial publishers.
  let journal_filters = journal_filters(args);
  let conference_filters = conference_filters(args);
  let (journal, conference) = tokio::try_join!(
    openalex_query(client, &journal_filters, args, api_key, turn),
    openalex_query(client, &conference_filters, args, api_key, turn),
  )?;
  let mut all: Vec<(LiteratureRecord, f64)> = journal;
  all.extend(conference);
  // Relevance-sorted merge: both queries are relevance-ordered, so sorting the
  // combined list by descending relevance_score keeps the best matches on top.
  all.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
  Ok(all.into_iter().map(|(record, _)| record).collect())
}

/// Filter for journal articles: published `article` works from one of the
/// common publishers. `host_organization_lineage` matches every imprint and
/// sub-brand under a top-level publisher.
fn journal_filters(args: &ResearchLiteratureArgs) -> Vec<String> {
  let mut filters = vec![
    "type:article".to_string(),
    format!("primary_location.source.host_organization_lineage:{LITERATURE_PUBLISHERS}"),
  ];
  if let Some(year) = args.year_from { filters.push(format!("from_publication_date:{year}-01-01")); }
  if let Some(year) = args.year_to { filters.push(format!("to_publication_date:{year}-12-31")); }
  filters
}

/// Filter for conference papers: any published conference proceedings article or
/// conference paper, regardless of the body that published it. Restricting
/// conferences by publisher would drop NeurIPS, ICML, ICLR, AAAI, ACL/EMNLP and
/// the other venues the user actually wants.
fn conference_filters(args: &ResearchLiteratureArgs) -> Vec<String> {
  let mut filters = vec!["type:proceedings-article|conference-paper".to_string()];
  if let Some(year) = args.year_from { filters.push(format!("from_publication_date:{year}-01-01")); }
  if let Some(year) = args.year_to { filters.push(format!("to_publication_date:{year}-12-31")); }
  filters
}

async fn openalex_query(client: &reqwest::Client, filters: &[String], args: &ResearchLiteratureArgs, api_key: &str, turn: &Arc<Turn>) -> Result<Vec<(LiteratureRecord, f64)>, ToolError> {
  let mut params = vec![
    ("search".into(), args.query.trim().into()),
    ("per-page".into(), "100".into()),
    ("filter".into(), filters.join(",")),
    ("select".into(), OPENALEX_SELECT.into()),
  ];
  if !api_key.is_empty() { params.push(("api_key".into(), api_key.to_string())); }
  let body = literature_json(client, "https://api.openalex.org/works", &params, turn).await?;
  let results = body["results"].as_array().ok_or_else(|| ToolError("Invalid OpenAlex results".into()))?;
  Ok(results.iter().filter_map(|work| {
    openalex_record(work).map(|record| (record, work["relevance_score"].as_f64().unwrap_or(0.0)))
  }).collect())
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
  use std::hash::{Hash, Hasher};
  let mut hasher = std::collections::hash_map::DefaultHasher::new();
  detail.doi.hash(&mut hasher);
  let identity = format!("{:016x}", hasher.finish());
  let pdf_path = reference_dir.join(format!("{identity}.pdf"));
  let doi_url = format!("https://doi.org/{}", detail.doi);
  // Step 1: download the PDF through Sci-Hub, held in memory. Nothing is on
  // disk yet, so a failure here cannot leave a partial file behind.
  let bytes = match sci_hub_pdf(client, &detail.doi, turn).await {
    Ok(bytes) => bytes,
    Err(error) => {
      if turn.is_stopped() { return Err(ToolError(STOPPED.into())); }
      let result = json!({ "doi": detail.doi, "title": detail.title, "url": doi_url, "pdf_path": Value::Null, "markdown_path": Value::Null, "source": { "status": "unavailable", "url": doi_url, "path": Value::Null }, "extraction_note": error.0 });
      emit_result_progress(progress, index, &result);
      return Ok(result);
    }
  };
  // Step 2: build the metadata markdown entry in memory.
  let entry = reference_entry(detail, &doi_url, &pdf_path);
  // Steps 3+4: write the PDF and the reference index atomically (all or
  // nothing) under one lock, so a failed index write rolls the PDF back.
  match persist_paper(reference_dir, detail, &pdf_path, &bytes, &entry) {
    Ok(markdown_path) => {
      let result = json!({ "doi": detail.doi, "title": detail.title, "url": doi_url, "pdf_path": pdf_path, "markdown_path": markdown_path, "source": { "status": "pdf", "url": doi_url, "path": pdf_path }, "extraction_note": Value::Null });
      emit_result_progress(progress, index, &result);
      Ok(result)
    }
    Err(error) => {
      let result = json!({ "doi": detail.doi, "title": detail.title, "url": doi_url, "pdf_path": Value::Null, "markdown_path": Value::Null, "source": { "status": "unavailable", "url": doi_url, "path": Value::Null }, "extraction_note": error.0 });
      emit_result_progress(progress, index, &result);
      Ok(result)
    }
  }
}

/// Sci-Hub mirrors tried in order. A real error (HTTP status, no parseable PDF
/// URL, invalid PDF) falls through to the next mirror; a stop aborts at once.
/// sci-hub.ru serves the current `/storage/...` layout and is reachable; the
/// classic-layout mirrors (sci-hub.ee/.ren) proxy the PDF from a third-party
/// host and are kept as fallbacks. `sci-hub.se` no longer resolves and
/// `sci-hub.st` answers with a DDoS-Guard challenge, so they are not tried.
const SCI_HUB_MIRRORS: [&str; 3] = ["https://sci-hub.ru", "https://sci-hub.ee", "https://sci-hub.ren"];
/// Sci-Hub serves a captcha/challenge to non-browser agents, so download
/// requests use a realistic desktop Chrome User-Agent.
const SCI_HUB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/// PDFs larger than this are rejected: Sci-Hub PDFs are small and a bigger body
/// is almost certainly an HTML error page or a redirected landing page.
const SCI_HUB_MAX_PDF: usize = 50 * 1024 * 1024;

/// GETs `url` and returns the body bytes, aborting the moment the turn stops.
/// The client's single timeout is the whole "longest wait" safety net; a
/// non-success HTTP status is a real error and is reported, never timed out.
async fn http_bytes(client: &reqwest::Client, url: &str, turn: &Arc<Turn>) -> Result<Vec<u8>, ToolError> {
  tokio::select! {
    biased;
    _ = turn.stopped() => Err(ToolError(STOPPED.into())),
    result = async {
      let response = client.get(url)
        .header("User-Agent", SCI_HUB_UA)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        // This client is built without a decompression feature, and Sci-Hub's
        // CDN gzip-encodes the PDF when a client advertises gzip. Force identity
        // so we receive the raw `%PDF-` bytes instead of a gzip wrapper we could
        // not read (curl confirms identity is honoured and returns the PDF).
        .header("Accept-Encoding", "identity")
        .send().await
        .map_err(|e| ToolError(format!("request failed: {e}")))?;
      if !response.status().is_success() { return Err(ToolError(format!("HTTP {}", response.status()))); }
      response.bytes().await.map(|b| b.to_vec()).map_err(|_| ToolError("response read failed".into()))
    } => result,
  }
}

/// Downloads a paper's PDF from Sci-Hub by DOI, trying each mirror in order.
///
/// This is the download step of one paper's pipeline. The bytes stay in memory
/// and are only written to disk by the caller after the metadata entry is
/// built, so a failure here cannot leave a partial file on disk.
async fn sci_hub_pdf(client: &reqwest::Client, doi: &str, turn: &Arc<Turn>) -> Result<Vec<u8>, ToolError> {
  let mut last_reason = "no Sci-Hub mirror returned a PDF".to_string();
  for mirror in SCI_HUB_MIRRORS {
    match sci_hub_try(client, mirror, doi, turn).await {
      Ok(bytes) => return Ok(bytes),
      Err(error) => {
        if turn.is_stopped() { return Err(ToolError(STOPPED.into())); }
        last_reason = error.0;
      }
    }
  }
  Err(ToolError(format!("Sci-Hub: {last_reason}")))
}

async fn sci_hub_try(client: &reqwest::Client, mirror: &str, doi: &str, turn: &Arc<Turn>) -> Result<Vec<u8>, ToolError> {
  let bytes = http_bytes(client, &format!("{mirror}/{doi}"), turn).await?;
  let html = String::from_utf8_lossy(&bytes);
  let raw = sci_hub_pdf_url(&html)
    .ok_or_else(|| ToolError(format!("article not found or blocked on {mirror}")))?;
  let pdf_url = normalize_pdf_url(&raw, mirror)?;
  let bytes = http_bytes(client, &pdf_url, turn).await?;
  if !bytes.starts_with(b"%PDF-") || bytes.len() > SCI_HUB_MAX_PDF {
    return Err(ToolError(format!("{mirror} did not return a valid PDF")));
  }
  Ok(bytes)
}

/// Extracts the PDF URL from a Sci-Hub article page.
///
/// Two layouts are in the wild. The current one (sci-hub.ru) carries the PDF in
/// `meta name="citation_pdf_url"`, an `<object data>` or the `.download` anchor,
/// as a path like `/storage/<year>/<id>/<hash>/file.pdf`. The classic layout
/// (sci-hub.ee/.ren) embeds the PDF in an `<iframe src>` on a third-party host
/// (`https://<host>/pdf/<doi>.pdf`). Both are found by scanning attributes for
/// a `.pdf` value; the first match wins, so an inline viewer is preferred.
fn sci_hub_pdf_url(html: &str) -> Option<String> {
  for attr in ["src=\"", "href=\"", "data=\"", "content=\""] {
    let mut rest = html;
    while let Some(start) = rest.find(attr) {
      let value_start = start + attr.len();
      let tail = &rest[value_start..];
      let end = tail.find(['"', '\'']).unwrap_or(tail.len());
      let value = &tail[..end];
      if value.contains(".pdf") {
        return Some(value.to_string());
      }
      rest = &tail[end..];
    }
  }
  // The classic "save" link sets `location.href` inside an onclick attribute
  // with escaped slashes (`https:\/\/host\/pdf\/doi.pdf?download=true`).
  if let Some(start) = html.find("location.href='") {
    let tail = &html[start + "location.href='".len()..];
    let end = tail.find('\'').unwrap_or(tail.len());
    let value = tail[..end].replace("\\/", "/");
    if value.contains(".pdf") { return Some(value); }
  }
  None
}

/// Turns the raw link from the page into an absolute URL. sci-hub.ru serves a
/// relative `/storage/...` path; the classic layout gives an absolute or
/// protocol-relative URL on a third-party host.
fn normalize_pdf_url(raw: &str, mirror: &str) -> Result<String, ToolError> {
  let raw = raw.trim().replace("\\/", "/");
  let url = if let Some(rest) = raw.strip_prefix("//") {
    format!("https://{rest}")
  } else if raw.starts_with('/') {
    format!("{mirror}{raw}")
  } else {
    raw
  };
  // A fragment (`#view=FitH`) is never sent over HTTP; drop it for cleanliness.
  let url = url.split('#').next().unwrap_or(&url).to_string();
  if !url.contains(".pdf") { return Err(ToolError("Sci-Hub page did not expose a PDF link".into())); }
  Ok(url)
}

/// The reference library is one Markdown index and the PDFs themselves.
static REFERENCE_INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Commits one paper's PDF and its metadata entry atomically.
///
/// Both the PDF and the whole reference index are first staged to `.part` files
/// and only then renamed into place, under one lock. If the index cannot be
/// saved, the freshly written PDF is rolled back, so a paper either lands on
/// disk whole or not at all.
fn persist_paper(reference_dir: &Path, detail: &LiteratureRecord, pdf_path: &Path, bytes: &[u8], entry: &str) -> Result<PathBuf, ToolError> {
  let _guard = REFERENCE_INDEX_LOCK.lock().unwrap();
  let markdown_path = reference_dir.join("index.md");
  let markdown = if markdown_path.exists() {
    fs::read_to_string(&markdown_path).map_err(|_| ToolError("Cannot read reference index".into()))?
  } else {
    "# References\n\n".into()
  };
  let markdown = upsert_reference_entry(&markdown, detail, entry);
  let pdf_temp = pdf_path.with_extension("pdf.part");
  let md_temp = markdown_path.with_extension("md.part");
  if let Err(error) = fs::write(&pdf_temp, bytes)
    .and_then(|_| fs::write(&md_temp, markdown))
    .and_then(|_| fs::rename(&pdf_temp, pdf_path))
    .and_then(|_| fs::rename(&md_temp, &markdown_path))
  {
    let _ = fs::remove_file(&pdf_temp);
    let _ = fs::remove_file(&md_temp);
    let _ = fs::remove_file(pdf_path);
    return Err(ToolError(format!("Cannot save reference paper: {error}")));
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

fn reference_entry(detail: &LiteratureRecord, _page_url: &str, pdf_path: &Path) -> String {
  format!("<!-- DOI:{} -->\n## {}\n\n- DOI: `{}`\n- BibTeX: ```\n{}```\n- 摘要: {}\n- 引用数: {}\n- PDF: `{}`\n\n",
    detail.doi, detail.title, detail.doi, detail.bib, detail.abstract_text,
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
  fn openalex_work_builds_record_and_enforces_type_boundary() {
    let work = json!({
      "type": "article", "doi": "https://doi.org/10.1234/TEST", "title": "Paper", "display_name": "Paper",
      "publication_year": 2024,
      "abstract_inverted_index": {"result": [1], "Our": [0]},
      "authorships": [{"author": {"display_name": "Ada Lovelace"}}],
      "primary_location": {"source": {"display_name": "Journal of Tests"}},
      "biblio": {"volume": "2", "issue": "1", "first_page": "10", "last_page": "20"}
    });
    let paper = openalex_record(&work).unwrap();
    assert_eq!(paper.doi, "10.1234/test");
    assert_eq!(paper.title, "Paper");
    // The citation is built from the structured metadata, not a page-number blob.
    assert!(paper.bib.contains("@article{lovelace2024paper"));
    assert!(paper.bib.contains("author = {Ada Lovelace}"));
    assert!(paper.bib.contains("journal = {Journal of Tests}"));
    assert!(paper.bib.contains("pages = {10--20}"));
    // Conference papers of either OpenAlex type enter the library too.
    assert!(openalex_record(&json!({"type": "proceedings-article", "doi": "10.1234/conf"})).is_some());
    let conference = openalex_record(&json!({
      "type": "conference-paper", "doi": "10.1234/conf2", "title": "A Conf Paper", "display_name": "A Conf Paper",
      "authorships": [{"author": {"display_name": "Grace Hopper"}}],
      "primary_location": {"source": {"display_name": "FCRC"}}
    })).unwrap();
    assert!(conference.bib.contains("@inproceedings"));
    assert!(conference.bib.contains("booktitle = {FCRC}"));
    assert!(openalex_record(&json!({"doi": null})).is_none());
    // Only published articles and conference papers enter the library; the
    // search queries ask OpenAlex for the same set, so a preprint is rejected
    // here as well rather than admitted by one layer and hidden by the other.
    assert!(openalex_record(&json!({"doi": "10.1234/test", "type": "preprint"})).is_none());
    // The search splits the set: journal articles are restricted to the
    // publisher allowlist, conference papers are not. The record conversion and
    // the search agree on the type set, so the filters stay coherent.
    let args = ResearchLiteratureArgs { query: "q".into(), year_from: None, year_to: None, max_papers: 5 };
    assert!(journal_filters(&args).iter().any(|f| f.starts_with("primary_location.source.host_organization_lineage:")));
    assert!(conference_filters(&args).iter().any(|f| f == "type:proceedings-article|conference-paper"));
  }

  #[test]
  fn sci_hub_pdf_url_extracts_download_link() {
    // The current sci-hub.ru layout: a relative /storage/ path in a meta tag or
    // a download anchor.
    let ru = r#"<meta name="citation_pdf_url" content="/storage/2024/7251/ee253ec27e28ed6b0df7da99c853917f/laemmli1970.pdf"><div class="download"><a href="/storage/2024/7251/ee253ec27e28ed6b0df7da99c853917f/laemmli1970.pdf"></a></div>"#;
    assert_eq!(sci_hub_pdf_url(ru).as_deref(), Some("/storage/2024/7251/ee253ec27e28ed6b0df7da99c853917f/laemmli1970.pdf"));
    // The classic layout: an absolute iframe src on a third-party host.
    let classic = r#"<div id="article"><iframe src="https://sci.bban.top/pdf/10.1038/227680a0.pdf#view=FitH" id="pdf"></iframe></div>"#;
    assert_eq!(sci_hub_pdf_url(classic).as_deref(), Some("https://sci.bban.top/pdf/10.1038/227680a0.pdf#view=FitH"));
    // The "save" link sets location.href with escaped slashes.
    let save = r##"<a href="#" onclick="location.href='https:\/\/sci.bban.top\/pdf\/10.1038\/227680a0.pdf?download=true'">save</a>"##;
    assert_eq!(sci_hub_pdf_url(save).as_deref(), Some("https://sci.bban.top/pdf/10.1038/227680a0.pdf?download=true"));
    // A page with no PDF link (article not found, captcha) yields nothing.
    assert!(sci_hub_pdf_url("<html><body>Article not found</body></html>").is_none());
    // Normalisation: relative -> mirror origin, protocol-relative -> https,
    // fragment stripped, escaped slashes unescaped.
    assert_eq!(normalize_pdf_url("/storage/2024/7251/ee253ec27e28ed6b0df7da99c853917f/laemmli1970.pdf", "https://sci-hub.ru").unwrap(), "https://sci-hub.ru/storage/2024/7251/ee253ec27e28ed6b0df7da99c853917f/laemmli1970.pdf");
    assert_eq!(normalize_pdf_url("//sci.bban.top/pdf/10.1038/227680a0.pdf", "https://sci-hub.ee").unwrap(), "https://sci.bban.top/pdf/10.1038/227680a0.pdf");
    assert_eq!(normalize_pdf_url("https://sci.bban.top/pdf/10.1038/227680a0.pdf#view=FitH", "https://sci-hub.ee").unwrap(), "https://sci.bban.top/pdf/10.1038/227680a0.pdf");
    assert_eq!(normalize_pdf_url(r#"https:\/\/sci.bban.top\/pdf\/10.1038\/227680a0.pdf?download=true"#, "https://sci-hub.ee").unwrap(), "https://sci.bban.top/pdf/10.1038/227680a0.pdf?download=true");
    assert!(normalize_pdf_url("https://sci-hub.ru/not-a-pdf", "https://sci-hub.ru").is_err());
  }

  #[test]
  fn reference_library_is_one_markdown_plus_pdfs() {
    let fixture = Fixture::new();
    let reference = fixture.0.join("reference");
    fs::create_dir_all(&reference).unwrap();
    let detail = LiteratureRecord { doi: "10.1234/example".into(), title: "Test title".into(), bib: "@article{example,\n  title = {Test title},\n}\n".into(), abstract_text: "Detailed abstract".into(), cited_by_count: 3 };
    let pdf_path = reference.join("0000000000000001.pdf");
    let entry = reference_entry(&detail, "https://doi.org/10.1234/example", &pdf_path);
    let markdown_path = persist_paper(&reference, &detail, &pdf_path, b"%PDF-test", &entry).unwrap();
    assert_eq!(markdown_path, reference.join("index.md"));
    assert_eq!(fs::read(&pdf_path).unwrap(), b"%PDF-test");
    let markdown = fs::read_to_string(&markdown_path).unwrap();
    // The heading is the paper title, not the DOI, and the BibTeX is embedded
    // as citation text the model can copy straight into a .bib file.
    assert!(markdown.contains("## Test title"));
    assert!(markdown.contains("@article{example,"));
    assert!(markdown.contains("Detailed abstract") && markdown.contains("0000000000000001.pdf"));
    assert!(!reference.join("papers.json").exists());
    // Saving the same DOI again replaces its entry instead of duplicating it.
    let detail2 = LiteratureRecord { doi: "10.1234/example".into(), title: "Replaced title".into(), bib: String::new(), abstract_text: String::new(), cited_by_count: 0 };
    let entry2 = reference_entry(&detail2, "https://doi.org/10.1234/example", &pdf_path);
    persist_paper(&reference, &detail2, &pdf_path, b"%PDF-2", &entry2).unwrap();
    let markdown = fs::read_to_string(&markdown_path).unwrap();
    assert_eq!(markdown.matches("<!-- DOI:10.1234/example -->").count(), 1);
    assert!(markdown.contains("## Replaced title"));
  }

  #[test]
  fn literature_deduplicates_local_and_batch_dois_before_limiting() {
    let fixture = Fixture::new();
    fixture.write("reference/index.md", "# References\n\n- DOI: `10.1234/EXISTING`\n");
    let existing = local_literature_dois(&fixture.0.join("reference")).unwrap();
    let record = |doi: &str| LiteratureRecord { doi: doi.into(), title: String::new(), bib: String::new(), abstract_text: String::new(), cited_by_count: 0 };
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
