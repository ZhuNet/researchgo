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

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
  SessionStart {
    session_id: String,
    model: String,
    cwd: String,
    tools: Vec<String>,
  },
  AssistantMessage {
    id: String,
    text: String,
  },
  AssistantDelta {
    id: String,
    text: String,
  },
  AssistantDone {
    id: String,
  },
  ToolStart {
    id: String,
    call_id: String,
    name: String,
    input: serde_json::Value,
  },
  ToolOutput {
    id: String,
    call_id: String,
    chunk: String,
  },
  ToolEnd {
    id: String,
    call_id: String,
    ok: bool,
    summary: String,
  },
  FilePatch {
    path: String,
    op: PatchOp,
    bytes: usize,
  },
  Usage {
    input: u64,
    output: u64,
    cache_read: u64,
  },
  TurnEnd {
    reason: TurnReason,
  },
  Error {
    message: String,
  },
}

impl Frame {
  /// Frames the renderer must see in order.
  ///
  /// `usage` is the exception: it reports the running total for the session
  /// rather than something that happened at a point in the transcript, so a late
  /// arrival corrects the number instead of corrupting the ordering. The
  /// renderer treats the stream as append-only and never assumes ordering
  /// beyond what a single `id` implies, which is what makes that safe.
  pub fn is_ordered(&self) -> bool {
    !matches!(self, Frame::Usage { .. })
  }
}

/// The event name the frontend listens on.
pub const STREAM: &str = "agent:frame";