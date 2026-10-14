//! The agent loop: model, tools, repeat.
//!
//! This is the part of a coding agent that is not a negotiation with an API. A
//! turn is: ask the model, run whatever it asked for, feed the results back,
//! ask again. Stop when the model stops asking. Everything else in a harness �?//! compaction, subagents, steering, skills �?exists to make that loop survive
//! longer, and none of it changes what the loop does.
//!
//! What does matter, and what is implemented here rather than skipped:
//!
//! * Tools run one at a time. Parallel tool calls are a large win in wall-clock
//!   and a large loss in a UI where every result mutates the file tree; the
//!   sequential version is what a reader can follow.
//! * Every frame leaves through one emitter, and so does every record on its
//!   way to the log: the order is whatever the loop did, not whatever the
//!   transport or the filesystem did.
//! * The turn ends on a budget as well as on the model. A model that has
//!   decided to keep editing is indistinguishable from one that is stuck, and
//!   the difference is only visible in the count.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::config::{secret, ResolvedModel};
use super::frame::{Frame, PatchOp, TurnReason, STREAM};
use super::log::{Recorder, Store, ToolRecord};
use super::tools;

/// Ceiling on model round-trips per turn. Generous for real work, and finite so
/// a loop the model cannot exit costs a turn rather than the conversation.
const MAX_STEPS: usize = 48;
/// A connection should be established quickly even when generation itself is
/// allowed to run for a long time.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum silence between two chunks. This is deliberately a read timeout,
/// not a total request timeout: a tool-heavy or reasoning-heavy response can
/// legitimately stream for longer than three minutes.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);

// The host knows the absolute workspace path; the model only needs to know
// that every tool starts inside the folder currently open in the app.
const WORKSPACE_INSTRUCTIONS: &str = "Your working directory is the currently open project folder. All file paths in read, write, edit, grep and glob, and paths in shell commands, are relative to that folder. For a file directly inside the open folder use its filename (e.g. `1.txt`), not the folder name followed by the filename (e.g. `paper/1.txt` when the open folder is `paper`). Use glob to discover paths when unsure. Do not guess or prepend the open folder's name.";

/// The conversation, kept across turns so the model remembers what it did.
///
/// There is no session and no session id: one panel, one transcript, and the
/// log beside it. What a session id used to identify — which conversation these
/// records belong to — is the answer to a question nobody asks once there is
/// only ever one conversation, and carrying it meant the renderer had to be
/// told about it and had to keep track of it.
pub struct Conversation {
  pub root: PathBuf,
  pub model: String,
  messages: Vec<Value>,
  /// Opened on the first turn rather than in `new`, because where the log lives
  /// is only known once there is an app to ask.
  log: Option<Recorder>,
}

impl Conversation {
  pub fn new(root: PathBuf, model: String) -> Self {
    Self {
      root,
      model,
      messages: Vec::new(),
      log: None,
    }
  }

  /// The one method that runs a whole turn.
  ///
  /// Loops until the model answers without asking for a tool or the step budget
  /// runs out. The transcript is appended to as it goes rather than assembled
  /// at the end, so a turn that is aborted mid-way leaves usable context
  /// behind.
  pub async fn turn(&mut self, app: &AppHandle, prompt: &str, cancel: &AtomicBool, root: PathBuf) {
    // The workspace can change under a conversation that was kept alive across
    // a folder switch. Re-pointing here rather than at construction keeps a
    // conversation that is still relevant while still refusing to hand the new
    // folder the old folder's history.
    if self.root != root {
      *self = Conversation::new(root, String::new());
    }

    // Read once per turn, not per request: switching models in Settings takes
    // effect on the next prompt, and a turn that changed models halfway through
    // would leave a transcript stitched from two of them.
    let cfg = secret(app);
    self.model = cfg.model.clone();
    log::info!("[agent] turn start: model={} root={}", cfg.model, self.root.display());

    if !cfg.is_ready() {
      emit(
        app,
        Frame::Error {
          message: "No model configured. Add an endpoint with a model in Settings.".into(),
        },
      );
      finish(app, TurnReason::Error);
      return;
    }

    self.open_log(app);
    self.begin_turn();

    self.record(
      &json!({
        "role": "user",
        "content": prompt,
      }),
      None,
    );

    let mut step = 0usize;
    let reason = loop {
      if cancel.load(Ordering::Relaxed) {
        break TurnReason::Aborted;
      }
      if step >= MAX_STEPS {
        emit(
          app,
          Frame::Error {
            message: format!("Stopped after {MAX_STEPS} steps without a final answer."),
          },
        );
        break TurnReason::Stop;
      }
      step += 1;

      // One model call. This is the only await that can fail for reasons
      // outside the model's control, so it is the only place a turn reports an
      // error rather than a tool error.
      log::info!("[agent] step {step}: calling model ({} messages)", self.messages.len());
      let id = format!("a{step}");
      let result = call_model_streaming(&cfg, &self.messages, |text| {
        if !cancel.load(Ordering::Relaxed) {
          emit(app, Frame::AssistantDelta { id: id.clone(), text: text.to_string() });
        }
      }).await;
      emit(app, Frame::AssistantDone { id: id.clone() });
      let reply = match result {
        Ok(reply) => reply,
        Err(err) => {
          emit(app, Frame::Error { message: err });
          break TurnReason::Error;
        }
      };
      log::info!(
        "[agent] step {step}: reply text_len={} tool_calls={}",
        reply.text.len(),
        reply.tool_calls.len()
      );

      if cancel.load(Ordering::Relaxed) {
        break TurnReason::Aborted;
      }

      self.record(&reply.message, None);

      if reply.tool_calls.is_empty() {
        emit(
          app,
          Frame::Usage {
            input: reply.input_tokens,
            output: reply.output_tokens,
            cache_read: reply.cache_read_tokens,
          },
        );
        break TurnReason::Stop;
      }

      for call in reply.tool_calls {
        if cancel.load(Ordering::Relaxed) {
          break;
        }
        let outcome = run_one_tool(app, &self.root, &id, &call).await;
        self.record(
          &json!({
            "role": "tool",
            "tool_call_id": call.id,
            "content": outcome.content,
          }),
          Some(ToolRecord {
            call_id: call.id.clone(),
            name: call.name.clone(),
            input: outcome.input,
            ok: outcome.ok,
            summary: outcome.summary,
            ms: outcome.elapsed,
          }),
        );
      }

      if cancel.load(Ordering::Relaxed) {
        break TurnReason::Aborted;
      }
    };

    // The turn is over, so the records it could not write get their one retry
    // as a whole — before `turn.end`, so that frame still means what it says.
    self.end_turn();
    finish(app, reason);
  }

  /// Drops the transcript. The log is not cleared with it: a turn the user
  /// cleared from the panel still happened, and the log is a record of what
  /// happened rather than of what is on screen.
  pub fn clear(&mut self) {
    self.messages.clear();
  }

  /// Opens the log the first time a turn needs it.
  fn open_log(&mut self, app: &AppHandle) {
    if self.log.is_some() {
      return;
    }
    match Store::open(app) {
      Ok(store) => self.log = Some(Recorder::new(store)),
      // A log that cannot be opened is not a reason to refuse the turn: the
      // model still has the transcript to read, and the warning says what is
      // missing from disk.
      Err(err) => log::warn!("[agent] no interaction log: {err}"),
    }
  }

  fn begin_turn(&mut self) {
    if let Some(rec) = self.log.as_mut() {
      rec.begin_turn();
    }
  }

  fn end_turn(&mut self) {
    if let Some(rec) = self.log.as_mut() {
      rec.end_turn();
    }
  }

  /// One interaction: the transcript the model reads next, and the log, in the
  /// same order.
  ///
  /// Both from one call, because a record the model saw but the log did not —
  /// or the reverse — is a conversation that cannot be read back from disk.
  fn record(&mut self, message: &Value, tool: Option<ToolRecord>) {
    let model = self.model.clone();
    self.messages.push(message.clone());
    if let Some(rec) = self.log.as_mut() {
      rec.push(model, message.clone(), tool);
    }
  }
}

fn finish(app: &AppHandle, reason: TurnReason) {
  log::info!("[agent] turn end: {reason:?}");
  emit(app, Frame::TurnEnd { reason });
}

/// Runs one tool call and emits its frames. Always returns a result for the
/// model.
///
/// An error is not an exception here: a tool that failed is information the
/// model needs in order to try something else, and a turn that dies on a failed
/// read is a turn that never gets to the second attempt.
async fn run_one_tool(app: &AppHandle, root: &Path, msg_id: &str, call: &ToolCall) -> ToolOutcome {
  // Parsed once: the frame and the log record both want the arguments as JSON,
  // while the transcript has them as the text the endpoint streamed.
  let input = parse_args(&call.arguments);
  emit(
    app,
    Frame::ToolStart {
      id: msg_id.to_string(),
      call_id: call.id.clone(),
      name: call.name.clone(),
      input: input.clone(),
    },
  );

  let started = Instant::now();
  let outcome = tools::run(root, &call.name, &input, &call.id).await;
  log::info!("[agent] tool `{}` finished in {:?}", call.name, started.elapsed());

  let (ok, content, summary, patch) = match outcome {
    // `out.ok`, not an unconditional `true`: a tool that ran but whose work
    // failed — a shell command with a non-zero exit — is not a success, and
    // reporting it as one draws a tick beside a failed build.
    Ok(out) => (out.ok, out.content, out.summary, out.patch),
    Err(err) => (false, format!("Error: {err}"), err.0.clone(), None),
  };

  for chunk in chunks(&content, 4000) {
    emit(
      app,
      Frame::ToolOutput {
        id: msg_id.to_string(),
        call_id: call.id.clone(),
        chunk,
      },
    );
  }

  let elapsed = started.elapsed().as_millis() as u64;
  let timing = if elapsed > 1000 {
    format!("{}s", elapsed / 1000)
  } else {
    format!("{elapsed}ms")
  };
  emit(
    app,
    Frame::ToolEnd {
      id: msg_id.to_string(),
      call_id: call.id.clone(),
      ok,
      // Joined only when the tool had something of its own to say. `bash` has
      // no summary by design — its outcome is the icon beside it — and
      // concatenating unconditionally left every shell row starting with a
      // bare " · ", which reads like a missing value rather than a timing.
      summary: match summary.trim() {
        "" => timing,
        part => format!("{part} · {timing}"),
      },
    },
  );

  if let Some((path, created)) = patch {
    emit(
      app,
      Frame::FilePatch {
        path,
        op: if created { PatchOp::Create } else { PatchOp::Modify },
        bytes: content.len(),
      },
    );
  }

  ToolOutcome {
    content,
    input,
    ok,
    summary,
    elapsed,
  }
}

/// What one tool call produced: the text the model gets, and what the panel
/// showed for it.
///
/// Both halves, because they are two different readings of one event — the
/// result the model reads is a file's contents, the row the user reads is
/// "Read · 1 line · 4ms" — and the log is the only place they can be kept
/// together.
struct ToolOutcome {
  content: String,
  input: Value,
  ok: bool,
  summary: String,
  elapsed: u64,
}

pub struct ToolCall {
  pub id: String,
  pub name: String,
  pub arguments: Value,
}

pub struct Reply {
  /// The assistant message exactly as it goes back into the transcript.
  pub message: Value,
  pub text: String,
  pub tool_calls: Vec<ToolCall>,
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub cache_read_tokens: u64,
}

/// Asks the model once, streaming the reply.
///
/// Streamed because the difference between text appearing as it is written and
/// text appearing all at once is the whole reason a panel shows a spinner, and
/// because a long answer should be readable while it is still arriving. The SSE
/// chunks are reassembled into one message at the end �?the model needs the
/// complete tool-call arguments, and a tool call that has been truncated
/// halfway is not an argument.
pub async fn call_model(
  cfg: &ResolvedModel,
  messages: &[Value],
) -> Result<Reply, String> {
  call_model_streaming(cfg, messages, |_| {}).await
}

/// Delivers text as it arrives while retaining the full reply for the transcript
/// and waiting for complete tool arguments before any tool can run.
pub async fn call_model_streaming(
  cfg: &ResolvedModel,
  messages: &[Value],
  mut on_text: impl FnMut(&str),
) -> Result<Reply, String> {
  let client = reqwest::Client::builder()
    .connect_timeout(CONNECT_TIMEOUT)
    .read_timeout(STREAM_IDLE_TIMEOUT)
    .build()
    .map_err(|e| format!("cannot build HTTP client: {e}"))?;

  let endpoint = format!("{}/chat/completions", cfg.url.trim_end_matches('/'));

  let body = json!({
    "model": cfg.model,
    "messages": model_messages(messages),
    "tools": tools::tool_defs(),
    "stream": true,
    "stream_options": { "include_usage": true },
  });

  let response = client
    .post(&endpoint)
    .header("Authorization", format!("Bearer {}", cfg.api_key))
    .header("Content-Type", "application/json")
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("cannot reach {}: {e}", cfg.url))?;

  let status = response.status();
  log::info!("[agent] POST {endpoint} -> {status}");
  if !status.is_success() {
    // The body carries the provider's own complaint, which is the only thing
    // that distinguishes a bad key from a bad model from a wrong URL.
    let detail = response.text().await.unwrap_or_default();
    return Err(format!(
      "{status} from {}: {}",
      cfg.url,
      detail.chars().take(400).collect::<String>()
    ));
  }

  let mut content = String::new();
  let mut tool_calls: Vec<ToolCall> = Vec::new();
  let mut usage = (0u64, 0u64, 0u64);
  let mut buffer = Vec::new();

  let mut stream = response.bytes_stream();
  use futures_util::StreamExt;
  while let Some(next) = stream.next().await {
    let bytes = next.map_err(|e| {
      if e.is_timeout() {
        format!(
          "model stream was silent for {} seconds; check the endpoint or proxy",
          STREAM_IDLE_TIMEOUT.as_secs()
        )
      } else {
        format!("stream failed: {e}")
      }
    })?;
    buffer.extend_from_slice(&bytes);

    // SSE frames are separated by a blank line. A chunk can land anywhere,
    // including mid-line, so whatever follows the last newline is held back
    // until the next one completes it.
    while let Some(pos) = buffer.iter().position(|&byte| byte == b'\n') {
      // Decode complete lines, since a network chunk can split a UTF-8 character.
      let line = String::from_utf8_lossy(&buffer[..pos]).trim().to_string();
      buffer.drain(..=pos);
      if let Some(data) = line.strip_prefix("data:") {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
          continue;
        }
        if let Ok(chunk) = serde_json::from_str::<Value>(data) {
          let before = content.len();
          absorb(&chunk, &mut content, &mut tool_calls, &mut usage);
          if content.len() > before {
            on_text(&content[before..]);
          }
        }
      }
    }
  }

  if content.is_empty() && tool_calls.is_empty() {
    return Err("the model returned an empty reply".into());
  }
  log::info!(
    "[agent] stream ended: content_len={} tool_calls={}",
    content.len(),
    tool_calls.len()
  );

  Ok(Reply {
    message: assistant_message(&content, &tool_calls),
    text: content,
    tool_calls,
    input_tokens: usage.0,
    output_tokens: usage.1,
    cache_read_tokens: usage.2,
  })
}

fn model_messages(messages: &[Value]) -> Vec<Value> {
  // Keep the guidance outside the saved transcript: it stays at the front of
  // every model request without being duplicated on later turns.
  let mut context = Vec::with_capacity(messages.len() + 1);
  context.push(json!({ "role": "system", "content": WORKSPACE_INSTRUCTIONS }));
  context.extend_from_slice(messages);
  context
}

/// The assistant message exactly as it goes back into the transcript.
///
/// Tool calls live in the top-level `tool_calls` field, never inside
/// `content`: a `tool_calls` entry in the content array is a content part no
/// OpenAI-compatible endpoint accepts, and the reply is a 400 naming the
/// supported part types — the turn dies on the request after the first tool
/// call. `content` is null rather than an empty string when the model went
/// straight to a tool call, which is the shape the API itself sends back.
fn assistant_message(text: &str, calls: &[ToolCall]) -> Value {
  let mut message = json!({ "role": "assistant", "content": text });
  if text.is_empty() {
    message["content"] = Value::Null;
  }
  if calls.is_empty() {
    return message;
  }
  message["tool_calls"] = Value::Array(
    calls
      .iter()
      .map(|call| {
        // Arguments are a JSON-encoded string on the wire — how they streamed
        // in is how they must stream back out.
        let arguments = match &call.arguments {
          Value::String(raw) => raw.clone(),
          other => other.to_string(),
        };
        json!({
          "id": call.id,
          "type": "function",
          "function": { "name": call.name, "arguments": arguments },
        })
      })
      .collect(),
  );
  message
}

/// Folds one SSE delta into the accumulating reply.
///
/// Tool calls arrive as fragments keyed by index, not as complete objects: the
/// arguments of a long edit stream in pieces that only mean anything joined
/// together. So a fragment extends the call at its index, and a new index starts
/// a new one.
fn absorb(
  chunk: &Value,
  content: &mut String,
  tool_calls: &mut Vec<ToolCall>,
  usage: &mut (u64, u64, u64),
) {
  if let Some(u) = chunk.get("usage").filter(|v| !v.is_null()) {
    usage.0 = u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(usage.0);
    usage.1 = u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(usage.1);
    usage.2 = u
      .get("prompt_tokens_details")
      .and_then(|d| d.get("cached_tokens"))
      .and_then(|v| v.as_u64())
      .unwrap_or(usage.2);
  }

  let Some(delta) = chunk.pointer("/choices/0/delta") else {
    return;
  };

  if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
    content.push_str(text);
  }

  let Some(fragments) = delta.get("tool_calls").and_then(|v| v.as_array()) else {
    return;
  };
  for fragment in fragments {
    let index = fragment.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    while tool_calls.len() <= index {
      tool_calls.push(ToolCall {
        id: String::new(),
        name: String::new(),
        arguments: Value::String(String::new()),
      });
    }

    let function = fragment.get("function");
    if let Some(id) = fragment.get("id").and_then(|v| v.as_str()) {
      tool_calls[index].id = id.to_string();
    }
    if let Some(name) = function.and_then(|f| f.get("name")).and_then(|v| v.as_str()) {
      tool_calls[index].name.push_str(name);
    }
    if let Some(args) = function.and_then(|f| f.get("arguments")).and_then(|v| v.as_str()) {
      let mut acc = match std::mem::replace(&mut tool_calls[index].arguments, Value::Null) {
        Value::String(s) => s,
        other => other.to_string(),
      };
      acc.push_str(args);
      tool_calls[index].arguments = Value::String(acc);
    }
  }
}

/// The transcript stores arguments as text because that is how they arrive;
/// this is where they become the JSON a tool can read.
fn parse_args(raw: &Value) -> Value {
  match raw {
    Value::String(s) => serde_json::from_str(s).unwrap_or(json!({})),
    other => other.clone(),
  }
}

fn chunks(text: &str, size: usize) -> Vec<String> {
  if text.is_empty() {
    return Vec::new();
  }
  text
    .chars()
    .collect::<Vec<_>>()
    .chunks(size)
    .map(|c| c.iter().collect::<String>())
    .collect()
}

fn emit(app: &AppHandle, frame: Frame) {
  if let Err(err) = app.emit(STREAM, frame) {
    log::warn!("{STREAM} was not delivered: {err}");
  }
}

/// Live agent state: the conversation plus the flag that stops it.
///
/// The conversation lives on the app rather than inside a spawned task so a
/// second prompt can find the first and cancel it. Two turns writing the same
/// transcript would interleave their tool calls into a history the model then
/// reads as one conversation - a thread that makes sense in no order at all.
///
/// A `tokio` mutex, not `std::sync::Mutex`: the transcript is held across
/// awaits while the model streams, and a blocking lock across an await point
/// would stall the runtime thread rather than just the other waiter.
///
/// The cancel flag is behind an `Arc` because the command that starts a turn
/// hands it to the spawned task and returns immediately; a flag copied into the
/// task would be one the command can no longer set, which is an abort button
/// that does nothing.
pub struct AgentState {
  pub(crate) conversation: tokio::sync::Mutex<Conversation>,
  /// Set by `agent_abort`, checked by the loop at every point where stopping is
  /// safe. Not a kill: the turn unwinds, so the transcript keeps the work it did
  /// and the next prompt has context to continue from.
  pub cancel: Arc<AtomicBool>,
}

impl AgentState {
  pub fn new() -> Self {
    Self {
      // A placeholder root; the first turn installs the real one.
      conversation: tokio::sync::Mutex::new(Conversation::new(
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        String::new(),
      )),
      cancel: Arc::new(AtomicBool::new(false)),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn model_requests_explain_project_relative_paths_without_changing_history() {
    let history = vec![json!({ "role": "user", "content": "read 1.txt" })];
    let request = model_messages(&history);
    assert_eq!(request[0]["role"], "system");
    assert!(request[0]["content"].as_str().unwrap().contains("currently open project folder"));
    assert_eq!(request[1], history[0]);
    assert_eq!(history.len(), 1);
  }

  fn delta(v: Value) -> Value {
    json!({ "choices": [{ "delta": v }] })
  }

  #[test]
  fn text_deltas_accumulate() {
    let mut content = String::new();
    let mut calls = Vec::new();
    let mut usage = (0, 0, 0);
    absorb(&delta(json!({ "content": "Hello " })), &mut content, &mut calls, &mut usage);
    absorb(&delta(json!({ "content": "world" })), &mut content, &mut calls, &mut usage);
    assert_eq!(content, "Hello world");
  }

  #[test]
  fn tool_call_arguments_stream_in_fragments() {
    // This is the case that breaks a naive implementation: a long `edit` call
    // arrives as several deltas whose arguments are only valid JSON once
    // joined, so a parser that reads each fragment as a whole call gets a
    // syntax error on every real edit.
    let mut content = String::new();
    let mut calls = Vec::new();
    let mut usage = (0, 0, 0);

    absorb(
      &delta(json!({
        "tool_calls": [{ "index": 0, "id": "call_a", "function": {
          "name": "edit", "arguments": "{\"path\":\"a." } }]
      })),
      &mut content, &mut calls, &mut usage,
    );
    absorb(
      &delta(json!({
        "tool_calls": [{ "index": 0, "function": { "arguments": "ts\",\"old_string\":\"x\"}" } }]
      })),
      &mut content, &mut calls, &mut usage,
    );

    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_a");
    assert_eq!(calls[0].name, "edit");
    let args = parse_args(&calls[0].arguments);
    assert_eq!(args["path"], "a.ts");
    assert_eq!(args["old_string"], "x");
  }

  #[test]
  fn parallel_tool_calls_are_kept_apart_by_index() {
    let mut content = String::new();
    let mut calls = Vec::new();
    let mut usage = (0, 0, 0);

    absorb(
      &delta(json!({
        "tool_calls": [
          { "index": 0, "id": "c0", "function": { "name": "read", "arguments": "{\"path\":\"a\"}" } },
          { "index": 1, "id": "c1", "function": { "name": "read", "arguments": "{\"path\":\"b\"}" } }
        ]
      })),
      &mut content, &mut calls, &mut usage,
    );

    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].name, "read");
    assert_eq!(parse_args(&calls[0].arguments)["path"], "a");
    assert_eq!(parse_args(&calls[1].arguments)["path"], "b");
  }

  #[test]
  fn usage_lands_in_the_totals() {
    let mut content = String::new();
    let mut calls = Vec::new();
    let mut usage = (0, 0, 0);
    absorb(
      &json!({ "usage": { "prompt_tokens": 120, "completion_tokens": 34,
                          "prompt_tokens_details": { "cached_tokens": 90 } } }),
      &mut content, &mut calls, &mut usage,
    );
    assert_eq!(usage, (120, 34, 90));
  }

  #[test]
  fn a_malformed_fragment_is_dropped_rather_than_fatal() {
    // A keep-alive or a provider-specific delta must not end the turn; the
    // stream is only over when the connection closes.
    let mut content = String::new();
    let mut calls = Vec::new();
    let mut usage = (0, 0, 0);
    absorb(&json!({ "choices": [] }), &mut content, &mut calls, &mut usage);
    absorb(&json!({ "something": "else" }), &mut content, &mut calls, &mut usage);
    assert!(content.is_empty());
    assert!(calls.is_empty());
  }

  #[test]
  fn tool_calls_live_in_their_own_field_not_in_content() {
    // The regression this guards: an assistant message with a `tool_calls`
    // part inside `content` is rejected by the endpoint on the next request
    // ("Invalid value: tool_calls"), and the turn dies right after the first
    // tool call.
    let calls = vec![ToolCall {
      id: "call_1".into(),
      name: "read".into(),
      arguments: json!("{\"path\":\"a\"}"),
    }];
    let message = assistant_message("", &calls);

    assert_eq!(message["content"], Value::Null);
    let sent = message["tool_calls"].as_array().expect("a tool_calls field");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["id"], "call_1");
    assert_eq!(sent[0]["type"], "function");
    assert_eq!(sent[0]["function"]["name"], "read");
    assert_eq!(
      sent[0]["function"]["arguments"].as_str().expect("arguments are text"),
      "{\"path\":\"a\"}"
    );
  }

  #[test]
  fn a_prose_reply_carries_text_and_no_tool_calls_field() {
    let message = assistant_message("hello", &[]);
    assert_eq!(message["content"], "hello");
    assert!(message.get("tool_calls").is_none());
  }

  #[test]
  fn text_and_tool_calls_share_one_message_without_mixing() {
    let calls = vec![ToolCall {
      id: "c".into(),
      name: "bash".into(),
      arguments: Value::String("{}".into()),
    }];
    let message = assistant_message("Running it.", &calls);
    assert_eq!(message["content"], "Running it.");
    assert_eq!(message["tool_calls"].as_array().expect("tool_calls").len(), 1);
  }
}
