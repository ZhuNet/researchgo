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
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use agent_loop::AgentState;

/// Registers the state the commands share. Called once from `lib.rs`.
pub fn init(app: &mut tauri::App) {
  app.manage(AgentState::new());
  config::init(app.handle());
}

/// How long a stop waits for the turn to actually let go of the transcript.
///
/// A backstop, not the expected cost. A stopped turn tears itself down — the
/// model response is dropped mid-stream and a running command is killed — so
/// this is only reached by a turn wedged somewhere the stop cannot reach. It
/// used to be five seconds of a *prompt* being refused outright, which is a
/// different problem: that one threw the prompt away.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs one turn: the user's prompt, streamed back as frames on `agent:frame`.
///
/// Spawned rather than awaited so the window stays responsive. The transcript
/// is taken inside the task and held for the whole turn — that is the mutual
/// exclusion a growing conversation needs — and it is released before this
/// command answers, so the answer means "a turn is running", never "a turn is
/// somewhere".
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

  // A new prompt supersedes whatever was running, and waits for it to be gone.
  // Serial rather than parallel because two turns writing one transcript produce
  // a conversation that reads as nonsense; a wait rather than a refusal because
  // stopping is immediate and there is no longer a reason to throw the prompt
  // away. The stopped turn releases the transcript before announcing that it is
  // done, so the turn spawned below does not queue behind it.
  //
  // A stop that ran out of time is stepped over rather than refused. Refusing
  // is what used to lose the prompt — and the renderer counts its turns the
  // same way this does, so a refused prompt would leave the two out of step
  // and every later `turn.end` would look like it belonged to a turn that had
  // already ended. Queueing behind a wedged turn is the smaller problem.
  if let Err(()) = stop_running(&state).await {
    ::log::warn!("[agent] the previous turn did not stop; starting the new one behind it");
  }

  // Registered before this returns, so a stop that follows the prompt finds a
  // turn rather than a gap where one ought to be.
  let turn = state.begin_turn();
  let root = PathBuf::from(root);

  tauri::async_runtime::spawn(async move {
    // `state()` borrows from an owned handle held here; taking it inline would
    // drop the handle at the end of the statement and leave the guard pointing
    // at nothing.
    let handle = app.clone();
    let shared = handle.state::<AgentState>();
    {
      let mut conversation = shared.conversation.lock().await;
      conversation.turn(&handle, &prompt, &turn, root).await;
    }
    // Only now is the transcript free, which is what makes a stop a wait for the
    // real thing: a stop that returned while the turn still held the lock was a
    // stop that returned early, and the prompt typed into that window queued
    // behind a turn nobody was watching.
    shared.end_turn(&turn);
  });

  Ok(())
}

/// Stops the running turn and returns once it is over.
///
/// The transcript is kept, so the next prompt continues rather than starting
/// over. Returns after the turn has let go, not after it has been asked to: the
/// button this call drives stays disabled for exactly this long, and a stop
/// that returned early would put the send button back while the agent was still
/// working.
#[tauri::command]
pub async fn agent_abort(state: State<'_, AgentState>) -> Result<(), String> {
  // Whatever went wrong, the turn is as stopped as it is going to get, and the
  // panel settles on this answer rather than waiting for a frame that may never
  // come. The failure is in the log.
  stop_running(&state).await.map_err(|()| {
    "the turn did not stop; the panel has settled but the host may still be finishing it".to_string()
  })
}

/// Asks the live turn to stop and waits for it to be over. Instant when nothing
/// is running. The error is about a turn that could not be torn down, which the
/// caller can log but not do anything about.
async fn stop_running(state: &AgentState) -> Result<(), ()> {
  let Some(turn) = state.stop_running() else {
    return Ok(());
  };
  ::log::info!("[agent] stopping turn {}", turn.serial());
  tokio::time::timeout(STOP_TIMEOUT, turn.finished())
    .await
    .map_err(|_| {
      ::log::error!(
        "[agent] turn {} did not stop within {}s",
        turn.serial(),
        STOP_TIMEOUT.as_secs()
      );
    })
}

/// Stops the running turn without waiting for it, for the window going away.
///
/// The close path is the one place where waiting buys nothing: there is no panel
/// left to settle and the process is exiting either way. The stop still earns
/// its keep, because what it tears down is a shell command that would otherwise
/// keep running with the window gone — holding a file handle, burning a core,
/// and able to rewrite a source file the next session has already read.
pub fn stop_without_waiting(state: &AgentState) {
  if let Some(turn) = state.stop_running() {
    ::log::info!("[agent] window closing: stopping turn {}", turn.serial());
  }
}

/// Drops the transcript the model reads. The log is untouched: a turn the user
/// cleared from the panel still happened, and the log is a record of what
/// happened rather than of what is on screen.
#[tauri::command]
pub async fn agent_clear(state: State<'_, AgentState>) -> Result<(), String> {
  state.conversation.lock().await.clear();
  Ok(())
}