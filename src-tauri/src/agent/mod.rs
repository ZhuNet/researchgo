//! The agent: an LLM, the tools it can call, and the loop that runs them.
//!
//! Everything here runs on the host. The renderer's CSP has no outbound
//! `connect-src`, so it could not call a model even if it wanted to, and the
//! API key should not sit anywhere the webview can read. The frontend sends a
//! prompt, receives JSONL frames on one event, and renders them; the host keeps
//! the transcript and writes every interaction to the log beside `llm.json`.
//!
//! There is no session. One panel is one conversation, so there is nothing for
//! an id to identify, and the id used to have to travel out to the renderer,
//! be stored there, and be handed back to say which conversation a frame
//! belonged to — all of it naming a distinction that is not there any more.

pub mod agent_loop;
pub mod config;
pub mod frame;
pub mod log;
pub mod tools;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use agent_loop::AgentState;

/// Registers the state the commands share. Called once from `lib.rs`.
pub fn init(app: &mut tauri::App) {
  app.manage(AgentState::new());
  config::init(app.handle());
}

/// How long a new prompt waits for the previous turn to notice it was cancelled.
///
/// Long enough for a turn between tool calls, short enough that a prompt sent
/// after hitting stop does not appear to hang. Past this the new turn is
/// refused rather than queued, because two turns sharing one transcript produce
/// a conversation that reads as nonsense.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs one turn: the user's prompt, streamed back as frames on `agent:frame`.
///
/// Spawned rather than awaited so the window stays responsive. The transcript
/// is taken here, at the edge, and moved into the task — holding it for the
/// whole turn is exactly the mutual exclusion a growing conversation needs.
#[tauri::command]
pub async fn agent_send(
  app: AppHandle,
  state: State<'_, AgentState>,
  prompt: String,
  root: String,
) -> Result<(), String> {
  let prompt = prompt.trim().to_string();
  if prompt.is_empty() {
    return Ok(());
  }

  // A new prompt supersedes whatever was running.
  state.cancel.store(true, Ordering::Relaxed);

  // Wait for the previous turn to release the transcript. Holding the guard
  // across a `.await` and then handing it to a spawned task would pin the
  // `State` borrow for the task's lifetime, which outlives this command — so
  // the lock is taken here only to learn *when* the old turn is done, and the
  // task takes its own. The cancel flag is what actually serialises them: once
  // the lock is free, the old turn has passed its last check and cannot take
  // it again.
  {
    let _held = tokio::time::timeout(HANDOFF_TIMEOUT, state.conversation.lock())
      .await
      .map_err(|_| {
        "the previous turn did not stop; press stop again or wait for it to finish".to_string()
      })?;
  }

  // Cleared only after the old turn is out, so the new turn is not cancelled by
  // the flag meant for its predecessor.
  state.cancel.store(false, Ordering::Relaxed);
  let cancel = state.cancel.clone();
  let root = PathBuf::from(root);

  tauri::async_runtime::spawn(async move {
    // `state()` borrows from an owned handle held here; taking it inline would
    // drop the handle at the end of the statement and leave the guard pointing
    // at nothing.
    let handle = app.clone();
    let shared = handle.state::<AgentState>();
    let mut conversation = shared.conversation.lock().await;
    conversation.turn(&handle, &prompt, &cancel, root).await;
  });

  Ok(())
}

/// Stops the running turn. The transcript is kept, so the next prompt continues
/// rather than starting over.
#[tauri::command]
pub fn agent_abort(state: State<'_, AgentState>) {
  state.cancel.store(true, Ordering::Relaxed);
}

/// Drops the transcript the model reads. The log is untouched: a turn the user
/// cleared from the panel still happened, and the log is a record of what
/// happened rather than of what is on screen.
#[tauri::command]
pub async fn agent_clear(state: State<'_, AgentState>) -> Result<(), String> {
  state.conversation.lock().await.clear();
  Ok(())
}