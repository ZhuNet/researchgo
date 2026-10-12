//! The agent: an LLM, the tools it can call, and the loop that runs them.
//!
//! Everything here runs on the host. The renderer's CSP has no outbound
//! `connect-src`, so it could not call a model even if it wanted to, and the
//! API key should not sit anywhere the webview can read. The frontend sends a
//! prompt, receives JSONL frames on one event, and renders them.

pub mod agent_loop;
pub mod config;
pub mod frame;
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
    let _held = tokio::time::timeout(HANDOFF_TIMEOUT, state.session.lock())
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
    let mut session = shared.session.lock().await;
    session.turn(&handle, &prompt, &cancel, root).await;
  });

  Ok(())
}

/// Stops the running turn. The transcript is kept, so the next prompt continues
/// rather than starting over.
#[tauri::command]
pub fn agent_abort(state: State<'_, AgentState>) {
  state.cancel.store(true, Ordering::Relaxed);
}

/// Drops the transcript. The next prompt starts a fresh session.
#[tauri::command]
pub async fn agent_clear(state: State<'_, AgentState>) -> Result<(), String> {
  state.session.lock().await.clear();
  Ok(())
}

/// The session id, model and workspace, for a panel that reopened before any
/// prompt had been sent.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
  pub id: String,
  pub model: String,
  pub root: String,
}

#[tauri::command]
pub async fn agent_info(state: State<'_, AgentState>) -> Result<AgentInfo, String> {
  let session = state.session.lock().await;
  Ok(AgentInfo {
    id: session.id.clone(),
    model: session.model.clone(),
    root: session.root.display().to_string(),
  })
}