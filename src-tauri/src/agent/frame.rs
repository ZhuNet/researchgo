//! The wire format the renderer already speaks.
//!
//! `bridge.ts` applies a total function from JSON frames to UI events, and it
//! is the only place protocol drift is caught: a frame it cannot classify is
//! surfaced as an error rather than dropped. That contract is why this enum
//! exists in the shape it does — the renderer was written against it, not the
//! other way around, so adding a variant here means teaching `translate()` the
//! same variant or making every unrecognised frame loud.
//!
//! Frames are newline-delimited JSON in the standalone sidecar. Inside the app
//! they travel as Tauri event payloads, so the trailing newline is dropped and
//! the serialisation is the same object either way.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchOp {
  Create,
  Modify,
  Delete,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnReason {
  Stop,
  Aborted,
  Error,
}

/// The tag vocabulary is dot-case (`tool.end`, `turn.end`) because that is what
/// `bridge.ts` parses — the renderer was written against this wire format, not
/// the other way around. A broad `rename_all = "snake_case"` here once turned
/// `TurnEnd` into `turn_end`, which the renderer silently dropped, and every
/// turn looked like a spinner that never stopped while the backend had finished
/// long before. The per-variant renames are deliberate: a tag is a contract,
/// and contracts are spelled out, not derived by a case convention that happens
/// to be wrong for most of them.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum Frame {
  #[serde(rename = "assistant.message")]
  AssistantMessage {
    id: String,
    text: String,
  },
  #[serde(rename = "assistant.delta")]
  AssistantDelta {
    id: String,
    text: String,
  },
  #[serde(rename = "assistant.done")]
  AssistantDone {
    id: String,
  },
  #[serde(rename = "tool.start")]
  ToolStart {
    id: String,
    call_id: String,
    name: String,
    input: serde_json::Value,
  },
  #[serde(rename = "tool.output")]
  ToolOutput {
    id: String,
    call_id: String,
    chunk: String,
  },
  #[serde(rename = "tool.end")]
  ToolEnd {
    id: String,
    call_id: String,
    ok: bool,
    summary: String,
  },
  #[serde(rename = "file.patch")]
  FilePatch {
    path: String,
    op: PatchOp,
    bytes: usize,
    diff: String,
  },
  #[serde(rename = "usage")]
  Usage {
    /// How large the conversation is right now: everything the last request
    /// carried, plus what it answered. This is what the panel's context meter
    /// shows, and the only figure comparable to a model's context window.
    context: u64,
    /// Everything this turn has cost so far, across all of its requests.
    ///
    /// Not the same number as `context`, and not interchangeable with it: each
    /// request re-sends the whole conversation, so a turn that made twenty
    /// calls has paid for the history twenty times over while the conversation
    /// itself grew by only the last of those. This one is a cost, for the rate.
    tokens: u64,
  },
  #[serde(rename = "agent.status")]
  Status {
    turn: u64,
    phase: String,
    age_ms: u64,
    context: u64,
    records: usize,
  },
  #[serde(rename = "turn.start")]
  TurnStart {
    /// Which turn has just been allocated and registered.
    ///
    /// Announced here, in the same operation that allocated the number, rather
    /// than leaving the renderer to count prompts in parallel and hope the two
    /// agree. They agreed only for as long as both processes did: a panel whose
    /// webview reloaded mid-turn came back counting from one while the host
    /// carried on from where it was, and from then on every `turn.end` carried a
    /// number the panel had never issued — so no turn could close itself, the
    /// phase stayed `running`, and the button stayed on interrupt for the rest
    /// of the session. One allocation, announced once, cannot drift from itself.
    turn: u64,
  },
  #[serde(rename = "turn.end")]
  TurnEnd {
    /// Which turn this ends. The renderer drops a `turn.end` whose number is not
    /// the turn it is running: a stop settles the turn it stopped, and the frame
    /// announcing that can still be in flight when the next prompt has already
    /// started — and one that closes the wrong turn leaves a live turn looking
    /// finished, which puts the send button back while the agent is still
    /// working.
    turn: u64,
    reason: TurnReason,
  },
  #[serde(rename = "error")]
  Error {
    message: String,
  },
}

/// The event name the frontend listens on.
pub const STREAM: &str = "agent:frame";

#[cfg(test)]
mod tests {
  use super::*;

  /// The wire tags the renderer parses. `bridge.ts` switches on these exact
  /// strings, and a frame whose tag it does not recognise is dropped on the
  /// floor — so a tag renamed by a broad `rename_all` here is a frame the
  /// whole renderer never sees. This is the regression that made every turn
  /// look like an endless spinner: `snake_case` turned `TurnEnd` into
  /// `turn_end`, the renderer parsed only `turn.end`, and the panel stayed
  /// "working" forever while the backend had finished long before.
  #[test]
  fn frame_tags_are_the_dot_case_the_renderer_parses() {
    let cases: Vec<(Frame, &str)> = vec![
      (
        Frame::AssistantMessage {
          id: "m".into(),
          text: "t".into(),
        },
        "assistant.message",
      ),
      (
        Frame::AssistantDelta {
          id: "m".into(),
          text: "t".into(),
        },
        "assistant.delta",
      ),
      (Frame::AssistantDone { id: "m".into() }, "assistant.done"),
      (
        Frame::ToolStart {
          id: "t".into(),
          call_id: "c".into(),
          name: "read".into(),
          input: serde_json::json!({}),
        },
        "tool.start",
      ),
      (
        Frame::ToolOutput {
          id: "t".into(),
          call_id: "c".into(),
          chunk: "x".into(),
        },
        "tool.output",
      ),
      (
        Frame::ToolEnd {
          id: "t".into(),
          call_id: "c".into(),
          ok: true,
          summary: "s".into(),
        },
        "tool.end",
      ),
      (
        Frame::FilePatch {
          path: "p".into(),
          op: PatchOp::Create,
          bytes: 1,
          diff: "--- p\n+++ p\n@@ -0,0 +1 @@\n+x\n".into(),
        },
        "file.patch",
      ),
      (
        Frame::Usage { context: 1, tokens: 1 },
        "usage",
      ),
      (
        Frame::Status {
          turn: 1,
          phase: "running".into(),
          age_ms: 2,
          context: 3,
          records: 4,
        },
        "agent.status",
      ),
      (Frame::TurnStart { turn: 1 }, "turn.start"),
      (Frame::TurnEnd { turn: 1, reason: TurnReason::Stop }, "turn.end"),
      (Frame::Error { message: "e".into() }, "error"),
    ];

    for (frame, want) in cases {
      let json = serde_json::to_value(&frame).unwrap();
      assert_eq!(
        json["type"], want,
        "frame {json} carries a tag the renderer will not parse"
      );
    }
  }
}
