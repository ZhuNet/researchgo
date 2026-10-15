//! The agent loop: model, tools, repeat.
//!
//! This is the part of a coding agent that is not a negotiation with an API. A
//! turn is: ask the model, run whatever it asked for, feed the results back,
//! ask again. Stop when the model stops asking. Everything else in a harness —//! compaction, subagents, steering, skills —exists to make that loop survive
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
//! * The turn ends when the model stops asking or when the person stops it.
//!   There is deliberately no step ceiling: a long task is the ordinary case
//!   rather than an exception to be tolerated, and the stop button is a real
//!   exit rather than a courtesy —it cuts the model stream where it stands.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use super::config::{secret, ResolvedModel};
use super::frame::{Frame, PatchOp, TurnReason, STREAM};
use super::log::{Recorder, Store, ToolRecord};
use super::tools;

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
/// log beside it. What a session id used to identify —which conversation these
/// records belong to —is the answer to a question nobody asks once there is
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
  /// Loops until the model answers without asking for a tool, or until the turn
  /// is stopped. Nothing caps the number of steps, so the model and the stop
  /// button are the only two endings a turn has. The transcript is appended to
  /// as it goes rather than assembled at the end, so a turn that is aborted
  /// mid-way leaves usable context behind.
  pub async fn turn(&mut self, app: &AppHandle, prompt: &str, turn: &Arc<Turn>, root: PathBuf) {
    // The workspace can change under a conversation that was kept alive across
    // a folder switch. Re-pointing here rather than at construction keeps a
    // conversation that is still relevant while still refusing to hand the new
    // folder the old folder's history.
    if self.root != root {
      *self = Conversation::new(root, String::new());
      // The transcript went with it, so there is now no conversation to
      // measure. Saying so is the only way the panel's meter stops describing
      // the old one: it is driven entirely by what the model is sent, and a
      // silent reset here would leave the bar sitting on the previous
      // project's size for as long as the new one stayed under the first reply.
      emit(app, Frame::Usage { context: 0, tokens: 0 });
    }

    // Read once per turn, not per request: switching models in Settings takes
    // effect on the next prompt, and a turn that changed models halfway through
    // would leave a transcript stitched from two of them.
    let cfg = secret(app);
    self.model = cfg.model.clone();
    log::info!(
      "[agent] turn {} start: model={} root={}",
      turn.serial(),
      cfg.model,
      self.root.display()
    );

    if !cfg.is_ready() {
      emit(
        app,
        Frame::Error {
          message: "No model configured. Add an endpoint with a model in Settings.".into(),
        },
      );
      finish(app, turn, TurnReason::Error);
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

    // Counts model round-trips, and names the assistant message each one
    // streams into. Not a budget —nothing consults it to end the turn.
    let mut step = 0usize;
    // Two running figures, because a turn is two different questions. `ctx` is
    // how large the conversation has become, which is the only thing a context
    // window can be compared against. `tok` is what this turn has cost: every
    // request re-sends the whole conversation, so the twenty calls of a long
    // turn have paid for the history twenty times over while the conversation
    // itself grew by only the last of them.
    // Only `tok` carries across steps. `ctx` is deliberately not a running total:
    // it is whatever the next request measures itself, so a stale one can never
    // outlive the conversation it described.
    let mut tok = 0u64;
    let reason = loop {
      if turn.is_stopped() {
        break TurnReason::Aborted;
      }
      step += 1;

      // One model call. This is the only await that can fail for reasons
      // outside the model's control, so it is the only place a turn reports an
      // error rather than a tool error. It is also the await a stop interrupts
      // rather than waits for: the stream is dropped on the spot, so a slow
      // endpoint cannot hold a turn open by taking its time to finish an answer
      // nobody is going to read.
      log::info!(
        "[agent] step {step}: calling model ({} messages)",
        self.messages.len()
      );
      let id = format!("a{step}");
      // What this request is about to carry, measured here rather than asked
      // for afterwards. The conversation is a local fact, so the meter is right
      // the moment the prompt is on its way — it stays right on an endpoint
      // that reports no usage at all, and on a request that is stopped before
      // it is ever answered, which a provider's count never arrives for.
      let ctx = estimate_tokens(
        &serde_json::to_string(&json!({
          "messages": model_messages(&self.messages),
          "tools": tools::tool_defs(),
        }))
        .unwrap_or_default(),
      );
      emit(app, Frame::Usage { context: ctx, tokens: tok });

      let result = call_model_streaming(&cfg, &self.messages, turn, |text| {
        emit(app, Frame::AssistantDelta { id: id.clone(), text: text.to_string() });
      })
      .await;
      let reply = match result {
        Ok(reply) => reply,
        // Stopping is something the user asked for, so it unwinds the way a
        // `return` from the loop does rather than the way a failed request
        // does: no error notice, nothing to act on.
        Err(CallError::Stopped) => break TurnReason::Aborted,
        Err(CallError::Failed(err)) => {
          emit(app, Frame::Error { message: err });
          break TurnReason::Error;
        }
      };
      // What came back, on the same terms: the text and the arguments of any
      // tool it asked for, which are tokens the model produced just as much as
      // the prose is.
      let produced = estimate_tokens(&reply.text)
        + reply
          .tool_calls
          .iter()
          .map(|call| estimate_tokens(&call.arguments.to_string()))
          .sum::<u64>();
      tok += ctx + produced;
      emit(app, Frame::Usage { context: ctx, tokens: tok });
      emit(app, Frame::AssistantDone { id: id.clone() });
      log::info!(
        "[agent] step {step}: reply text_len={} tool_calls={} context={} turn={}",
        reply.text.len(),
        reply.tool_calls.len(),
        ctx,
        tok
      );

      if turn.is_stopped() {
        break TurnReason::Aborted;
      }

      self.record(&reply.message, None);

      if reply.tool_calls.is_empty() {
        break TurnReason::Stop;
      }

      for call in reply.tool_calls {
        // Every tool call the model asked for gets an answer, including the ones
        // that will never run. An assistant message carrying `tool_calls` with
        // no matching `tool` message behind it is rejected by the endpoint on
        // the next request —a 400 that kills the conversation rather than the
        // turn —and stopping part-way through a batch is exactly how that
        // shape gets written.
        if turn.is_stopped() {
          self.record(
            &json!({
              "role": "tool",
              "tool_call_id": call.id,
              "content": tools::STOPPED,
            }),
            Some(ToolRecord {
              call_id: call.id.clone(),
              name: call.name.clone(),
              input: parse_args(&call.arguments),
              ok: false,
              summary: tools::STOPPED.into(),
              ms: 0,
            }),
          );
          continue;
        }
        let outcome = run_one_tool(app, &self.root, &id, &call, turn).await;
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

      if turn.is_stopped() {
        break TurnReason::Aborted;
      }
    };

    // The turn is over, so the records it could not write get their one retry
    // as a whole —before `turn.end`, so that frame still means what it says.
    self.end_turn();
    finish(app, turn, reason);
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
  /// or the reverse —is a conversation that cannot be read back from disk.
  fn record(&mut self, message: &Value, tool: Option<ToolRecord>) {
    let model = self.model.clone();
    self.messages.push(message.clone());
    if let Some(rec) = self.log.as_mut() {
      rec.push(model, message.clone(), tool);
    }
  }
}

fn finish(app: &AppHandle, turn: &Turn, reason: TurnReason) {
  log::info!("[agent] turn {} end: {reason:?}", turn.serial());
  emit(
    app,
    Frame::TurnEnd {
      turn: turn.serial(),
      reason,
    },
  );
}

/// Runs one tool call and emits its frames. Always returns a result for the
/// model.
///
/// An error is not an exception here: a tool that failed is information the
/// model needs in order to try something else, and a turn that dies on a failed
/// read is a turn that never gets to the second attempt.
async fn run_one_tool(
  app: &AppHandle,
  root: &Path,
  msg_id: &str,
  call: &ToolCall,
  turn: &Arc<Turn>,
) -> ToolOutcome {
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
  let outcome = tools::run(root, &call.name, &input, &call.id, turn).await;
  log::info!("[agent] tool `{}` finished in {:?}", call.name, started.elapsed());

  let (ok, content, summary, patch) = match outcome {
    // `out.ok`, not an unconditional `true`: a tool that ran but whose work
    // failed —a shell command with a non-zero exit —is not a success, and
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
      // no summary by design —its outcome is the icon beside it —and
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
/// Both halves, because they are two different readings of one event —the
/// result the model reads is a file's contents, the row the user reads is
/// "Read · 1 line · 4ms" —and the log is the only place they can be kept
/// together.
struct ToolOutcome {
  content: String,
  input: Value,
  ok: bool,
  summary: String,
  elapsed: u64,
}

#[derive(Debug)]
pub struct ToolCall {
  pub id: String,
  pub name: String,
  pub arguments: Value,
}

/// What one model call produced: the complete reply. `Debug` because the tests
/// print one when a round trip fails.
#[derive(Debug)]
pub struct Reply {
  /// The assistant message exactly as it goes back into the transcript.
  pub message: Value,
  pub text: String,
  pub tool_calls: Vec<ToolCall>,
}

/// An estimate of what a piece of text costs the model's context.
///
/// Not exact, and not trying to be. The only exact answer is the model's own
/// tokenizer, which this protocol does not carry and which differs per model;
/// carrying one would mean shipping a word list for every endpoint the user
/// might type in. What this has to be instead is *consistent* —the same text
/// always scores the same, so the meter moves when the conversation grows and
/// not when a provider happens to feel like reporting usage.
///
/// One token per wide character and one per four of everything else. The four
/// is the familiar rule of thumb for alphabetic text; the one is closer than it
/// sounds for Chinese, where tokenizers sit near one character per token, and
/// that is the case that matters here —the usual four-to-one rule applied to
/// this app's prose would understate it threefold.
fn estimate_tokens(text: &str) -> u64 {
  let (mut wide, mut rest) = (0u64, 0u64);
  for ch in text.chars() {
    if is_wide(ch) {
      wide += 1;
    } else {
      rest += 1;
    }
  }
  wide + rest / 4
}

/// Whether a character is one the tokenizers spend roughly a token on.
///
/// The ranges a CJK-capable tokenizer treats as individually addressable:
/// Hangul, the CJK blocks and their extensions, and the fullwidth forms.
fn is_wide(c: char) -> bool {
  matches!(c as u32,
    0x1100..=0x115F            // Hangul Jamo
    | 0x2E80..=0x303E          // CJK radicals, Kangxi, punctuation
    | 0x3041..=0x33FF          // Kana, CJK compatibility
    | 0x3400..=0x4DBF          // CJK extension A
    | 0x4E00..=0x9FFF          // CJK unified ideographs
    | 0xA000..=0xA4CF          // Yi
    | 0xAC00..=0xD7A3          // Hangul syllables
    | 0xF900..=0xFAFF          // CJK compatibility ideographs
    | 0xFE30..=0xFE6F          // CJK compatibility forms
    | 0xFF00..=0xFF60          // fullwidth forms
    | 0xFFE0..=0xFFE6
    | 0x20000..=0x3FFFD        // CJK extensions B and beyond
  )
}
/// Asks the model once, streaming the reply.
///
/// Streamed because the difference between text appearing as it is written and
/// text appearing all at once is the whole reason a panel shows a spinner, and
/// because a long answer should be readable while it is still arriving. The SSE
/// chunks are reassembled into one message at the end —the model needs the
/// complete tool-call arguments, and a tool call that has been truncated
/// halfway is not an argument.
/// Why a model call produced no reply.
///
/// Two cases rather than one string: a request that failed is something the user
/// needs to read, and a turn that was stopped is something they asked for.
/// Folding them together prints "stopped" as an error notice every time anyone
/// presses the stop button.
#[derive(Debug)]
pub enum CallError {
  /// The turn was stopped while the reply was still arriving.
  Stopped,
  /// The endpoint could not be reached, or answered with something unusable.
  Failed(String),
}

impl std::fmt::Display for CallError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Stopped => f.write_str("stopped"),
      Self::Failed(err) => f.write_str(err),
    }
  }
}

pub async fn call_model(
  cfg: &ResolvedModel,
  messages: &[Value],
  turn: &Arc<Turn>,
) -> Result<Reply, CallError> {
  call_model_streaming(cfg, messages, turn, |_| {}).await
}

/// Delivers text as it arrives while retaining the full reply for the transcript
/// and waiting for complete tool arguments before any tool can run.
///
/// Both awaits that can outlive a stop are raced against it, and losing that
/// race drops the HTTP response on the way out. This is the whole difference
/// between stopping a turn and asking one to stop: asking left the response
/// being read to the end, so how long the button felt dead was however long the
/// network took to notice —on a slow connection longer than anyone will sit and
/// watch a disabled button.
///
/// The request asks for no token counts: the panel measures the payload itself
/// with `estimate_tokens`, which works on endpoints that do not implement
/// `include_usage` and is correct for a request that is still in flight.
pub async fn call_model_streaming(
  cfg: &ResolvedModel,
  messages: &[Value],
  turn: &Arc<Turn>,
  mut on_text: impl FnMut(&str),
) -> Result<Reply, CallError> {
  let client = reqwest::Client::builder()
    .connect_timeout(CONNECT_TIMEOUT)
    .read_timeout(STREAM_IDLE_TIMEOUT)
    .build()
    .map_err(|e| CallError::Failed(format!("cannot build HTTP client: {e}")))?;

  let endpoint = format!("{}/chat/completions", cfg.url.trim_end_matches('/'));

  let body = json!({
    "model": cfg.model,
    "messages": model_messages(messages),
    "tools": tools::tool_defs(),
    "stream": true,
  });

  let response = tokio::select! {
    // `biased` so a stop that arrived first wins the race: both branches can be
    // ready at once, and the one that matters here is the one that lets the
    // turn go.
    biased;
    _ = turn.stopped() => return Err(CallError::Stopped),
    result = client
      .post(&endpoint)
      .header("Authorization", format!("Bearer {}", cfg.api_key))
      .header("Content-Type", "application/json")
      .json(&body)
      .send() =>
    {
      result.map_err(|e| CallError::Failed(format!("cannot reach {}: {e}", cfg.url)))?
    }
  };

  let status = response.status();
  log::info!("[agent] POST {endpoint} -> {status}");
  if !status.is_success() {
    // The body carries the provider's own complaint, which is the only thing
    // that distinguishes a bad key from a bad model from a wrong URL.
    let detail = response.text().await.unwrap_or_default();
    return Err(CallError::Failed(format!(
      "{status} from {}: {}",
      cfg.url,
      detail.chars().take(400).collect::<String>()
    )));
  }

  let mut content = String::new();
  let mut tool_calls: Vec<ToolCall> = Vec::new();
  let mut buffer = Vec::new();

  let mut stream = response.bytes_stream();
  use futures_util::StreamExt;
  loop {
    // Raced per chunk rather than around the whole stream, so a stop lands on
    // the chunk already in flight instead of on the end of a reply that may be
    // minutes away.
    let next = tokio::select! {
      biased;
      _ = turn.stopped() => return Err(CallError::Stopped),
      next = stream.next() => next,
    };
    let Some(bytes) = next else { break };
    let bytes = bytes.map_err(|e| {
      if e.is_timeout() {
        CallError::Failed(format!(
          "model stream was silent for {} seconds; check the endpoint or proxy",
          STREAM_IDLE_TIMEOUT.as_secs()
        ))
      } else {
        CallError::Failed(format!("stream failed: {e}"))
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
          absorb(&chunk, &mut content, &mut tool_calls);
          if content.len() > before {
            on_text(&content[before..]);
          }
        }
      }
    }
  }

  if content.is_empty() && tool_calls.is_empty() {
    return Err(CallError::Failed("the model returned an empty reply".into()));
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
/// supported part types —the turn dies on the request after the first tool
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
        // Arguments are a JSON-encoded string on the wire —how they streamed
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
) {
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

/// One turn's stop switch, its identity, and the two signals that go with it.
///
/// Stop used to be an `AtomicBool` the loop polled at a handful of points. That
/// is enough to end a turn between two steps, and not enough to end one that is
/// waiting on the model —which is where a turn spends nearly all of its time,
/// and which is what the person who pressed stop is actually watching. Cutting
/// an `await` short takes a `select!`, and a `select!` branch needs something to
/// await, so the flag is backed by a channel: a receiver created at any moment
/// sees a stop that has already happened rather than missing it. That is what
/// makes "set the flag, then wait for the turn to be over" a complete operation
/// instead of a hopeful one.
///
/// Not a kill. The turn unwinds, so the transcript keeps the work it did and the
/// next prompt has context to continue from.
pub struct Turn {
  /// Flipped once, by `stop`, and read by every check point in the loop.
  stop: watch::Sender<bool>,
  /// Flipped once the turn has let go of the transcript, which is the only
  /// moment a second turn may start.
  done: watch::Sender<bool>,
  /// Which turn this is, counted from 1 and carried on `turn.end` so a late
  /// frame from a stopped turn cannot close the one that replaced it.
  serial: u64,
}

impl Turn {
  fn new(serial: u64) -> Arc<Self> {
    Arc::new(Self {
      stop: watch::channel(false).0,
      done: watch::channel(false).0,
      serial,
    })
  }

  /// A turn nothing will ever stop.
  ///
  /// For callers outside the loop: the tests drive `call_model` directly, and a
  /// direct call is not part of a turn that has a stop button.
  pub fn detached() -> Arc<Self> {
    Self::new(0)
  }

  pub fn serial(&self) -> u64 {
    self.serial
  }

  /// The cheap check, for the points in the loop where stopping is free.
  pub fn is_stopped(&self) -> bool {
    *self.stop.borrow()
  }

  /// Asks the turn to stop. Returns at once; `finished()` is how you wait for
  /// it to actually be over.
  pub fn stop(&self) {
    self.stop.send_replace(true);
  }

  /// Resolves once this turn has been asked to stop.
  pub async fn stopped(&self) {
    let mut rx = self.stop.subscribe();
    loop {
      if *rx.borrow_and_update() {
        return;
      }
      if rx.changed().await.is_err() {
        return;
      }
    }
  }

  /// Resolves once the turn has released the transcript.
  pub async fn finished(&self) {
    let mut rx = self.done.subscribe();
    loop {
      if *rx.borrow_and_update() {
        return;
      }
      if rx.changed().await.is_err() {
        return;
      }
    }
  }

  fn mark_finished(&self) {
    self.done.send_replace(true);
  }
}

/// Live agent state: the conversation plus the turn that is running on it.
///
/// The conversation lives on the app rather than inside a spawned task so a
/// second prompt can find the first and stop it. Two turns writing the same
/// transcript would interleave their tool calls into a history the model then
/// reads as one conversation - a thread that makes sense in no order at all.
///
/// A `tokio` mutex, not `std::sync::Mutex`: the transcript is held across
/// awaits while the model streams, and a blocking lock across an await point
/// would stall the runtime thread rather than just the other waiter.
pub struct AgentState {
  pub(crate) conversation: tokio::sync::Mutex<Conversation>,
  /// The turn that is live right now, or `None`. Registered before `agent_send`
  /// answers, so a stop cannot land in the gap between the click and the turn
  /// existing and find nothing to stop.
  running: std::sync::Mutex<Option<Arc<Turn>>>,
  /// Numbers the turns. From 1, because the renderer counts its own the same way
  /// and compares the two to recognise a frame that arrives late.
  serial: AtomicU64,
}

impl AgentState {
  pub fn new() -> Self {
    Self {
      // A placeholder root; the first turn installs the real one.
      conversation: tokio::sync::Mutex::new(Conversation::new(
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        String::new(),
      )),
      running: std::sync::Mutex::new(None),
      serial: AtomicU64::new(0),
    }
  }

  /// Registers a new turn. Any turn still registered has already been stopped
  /// and waited for by the caller.
  pub fn begin_turn(&self) -> Arc<Turn> {
    let serial = self.serial.fetch_add(1, Ordering::Relaxed) + 1;
    let turn = Turn::new(serial);
    *self.lock_running() = Some(turn.clone());
    turn
  }

  /// Deregisters a finished turn and announces that the transcript is free.
  ///
  /// Only clears the slot if it is still this turn's: a turn that ends after
  /// being superseded must not unregister the one that took its place.
  pub fn end_turn(&self, turn: &Arc<Turn>) {
    let mut running = self.lock_running();
    if running.as_ref().is_some_and(|current| Arc::ptr_eq(current, turn)) {
      *running = None;
    }
    drop(running);
    turn.mark_finished();
  }

  /// Asks the live turn to stop and hands back its ticket, so the caller can
  /// wait for the turn to be over. `None` when nothing was running.
  pub fn stop_running(&self) -> Option<Arc<Turn>> {
    let turn = self.lock_running().clone();
    if let Some(turn) = &turn {
      turn.stop();
    }
    turn
  }

  fn lock_running(&self) -> std::sync::MutexGuard<'_, Option<Arc<Turn>>> {
    // A poisoned lock means some other thread panicked holding it, and the only
    // thing in here is an `Arc` to a turn. Carrying on with whatever is there
    // beats taking the whole agent down over it.
    self.running.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[tokio::test]
  async fn a_stop_is_visible_to_a_wait_that_starts_after_it() {
    // The race this closes: a flag polled at check points cannot be waited on,
    // so every await that has to be interruptible subscribes to the channel —
    // and one of those subscribes in the window between the stop and the first
    // await. A wait that begins after the stop has to see it, or the turn it is
    // guarding waits for something that already happened.
    let turn = Turn::detached();
    turn.stop();

    assert!(turn.is_stopped());
    tokio::time::timeout(std::time::Duration::from_millis(200), turn.stopped())
      .await
      .expect("a stop that already happened is seen immediately");
  }

  #[tokio::test]
  async fn a_wait_interrupted_by_a_stop_returns_before_the_slow_thing() {
    let turn = Turn::detached();
    let stopper = turn.clone();
    tokio::spawn(async move {
      tokio::time::sleep(std::time::Duration::from_millis(50)).await;
      stopper.stop();
    });

    // The stand-in for the model's response: it would take far longer than this
    // test allows, and nothing about the stop changes how long it would take.
    let slow = async {
      tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    };
    tokio::select! {
      biased;
      _ = turn.stopped() => {}
      _ = slow => panic!("the wait ran to completion instead of being stopped"),
    }
  }

  #[tokio::test]
  async fn finishing_is_announced_once_and_seen_by_late_waiters() {
    let turn = Turn::detached();
    // Nothing announces a turn that has not finished, however long anyone waits.
    assert!(
      tokio::time::timeout(std::time::Duration::from_millis(50), turn.finished())
        .await
        .is_err(),
      "an unfinished turn must not report itself finished"
    );

    turn.mark_finished();
    tokio::time::timeout(std::time::Duration::from_millis(200), turn.finished())
      .await
      .expect("a turn that is over is over for a waiter that arrives late");
  }

  #[tokio::test]
  async fn state_tracks_one_turn_at_a_time() {
    let state = AgentState::new();
    assert!(state.stop_running().is_none(), "nothing to stop before anything runs");

    let first = state.begin_turn();
    let second = state.begin_turn();
    assert_eq!(second.serial(), first.serial() + 1, "turns are numbered from 1");

    // A turn that ends after being superseded must not deregister its successor,
    // or the stop that follows would find nothing to stop.
    state.end_turn(&first);
    assert_eq!(
      state.stop_running().map(|turn| turn.serial()),
      Some(second.serial()),
      "the superseded turn cleared the slot of the live one"
    );
    assert!(second.is_stopped(), "stopping stops the turn that is actually running");

    state.end_turn(&second);
    assert!(state.stop_running().is_none());
  }

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
    absorb(&delta(json!({ "content": "Hello " })), &mut content, &mut calls);
    absorb(&delta(json!({ "content": "world" })), &mut content, &mut calls);
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

    absorb(
      &delta(json!({
        "tool_calls": [{ "index": 0, "id": "call_a", "function": {
          "name": "edit", "arguments": "{\"path\":\"a." } }]
      })),
      &mut content, &mut calls,
    );
    absorb(
      &delta(json!({
        "tool_calls": [{ "index": 0, "function": { "arguments": "ts\",\"old_string\":\"x\"}" } }]
      })),
      &mut content, &mut calls,
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

    absorb(
      &delta(json!({
        "tool_calls": [
          { "index": 0, "id": "c0", "function": { "name": "read", "arguments": "{\"path\":\"a\"}" } },
          { "index": 1, "id": "c1", "function": { "name": "read", "arguments": "{\"path\":\"b\"}" } }
        ]
      })),
      &mut content, &mut calls,
    );

    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].name, "read");
    assert_eq!(parse_args(&calls[0].arguments)["path"], "a");
    assert_eq!(parse_args(&calls[1].arguments)["path"], "b");
  }

  #[test]
  fn latin_text_scores_about_four_characters_to_a_token() {
    // "Hello world" is two tokens to every tokenizer worth the name; the point
    // is the ratio, not the exact figure.
    let counted = estimate_tokens("Hello world");
    assert!((1..=3).contains(&counted), "scored {counted} for eleven characters");
  }

  #[test]
  fn chinese_is_scored_by_character_not_by_the_latin_ratio() {
    // The regression that matters for this app: nine Chinese characters are
    // roughly nine tokens, and the familiar four-characters-per-token rule
    // would score them at two and understate a Chinese conversation fivefold.
    assert_eq!(estimate_tokens("\u{4eca}\u{5929}\u{6211}\u{4eec}\u{6539}\u{4e00}\u{4e0b}\u{6587}\u{4ef6}"), 9);
    assert!(estimate_tokens("\u{4eca}\u{5929}\u{6211}\u{4eec}\u{6539}\u{4e00}\u{4e0b}\u{6587}\u{4ef6}") > estimate_tokens("abcdefghijkl"));
  }

  #[test]
  fn a_usage_frame_in_the_stream_is_no_longer_looked_at() {
    // Nothing reads the provider's token counts any more, so a payload can
    // carry them without the estimate moving: the number is the conversation's
    // size, measured here, and a count from the wire would only be a second
    // opinion about it that could arrive late or not at all.
    let mut content = String::new();
    let mut calls = Vec::new();
    absorb(&json!({ "usage": { "prompt_tokens": 120, "completion_tokens": 34 } }), &mut content, &mut calls);
    assert!(content.is_empty());
    assert!(calls.is_empty());
  }

  #[test]
  fn a_malformed_fragment_is_dropped_rather_than_fatal() {
    // A keep-alive or a provider-specific delta must not end the turn; the
    // stream is only over when the connection closes.
    let mut content = String::new();
    let mut calls = Vec::new();
    absorb(&json!({ "choices": [] }), &mut content, &mut calls);
    absorb(&json!({ "something": "else" }), &mut content, &mut calls);
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
