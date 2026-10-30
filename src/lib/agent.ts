/**
 * The agent, as the renderer sees it: three commands and one event.
 *
 * The renderer never opens a socket, holds a key, or parses a stream. It asks
 * the host to run a turn and receives the same JSONL frames the renderer was
 * written against before any of this existed — `translate()` in `bridge.ts` is
 * the boundary, and it has not changed.
 *
 * There is no session on this side either. The host keeps the conversation and
 * writes every interaction to its log; the renderer shows what arrives, in the
 * order it arrives.
 */

import { translate, type UiEvent } from './bridge';

/** What the host is willing to say about one stored endpoint. No key. */
export interface LlmView {
  name: string;
  url: string;
  models: string[];
  /** A fingerprint of the stored key, enough to tell two keys apart. */
  keyHint: string;
  /** Whether this entry could actually make a call. */
  ready: boolean;
  /** Whether the agent is currently pointed at one of this entry's models. */
  active: boolean;
  /** The model the agent is pointed at, when this entry is the active one. */
  activeModel: string | null;
}

export interface LlmConfig {
  url: string;
  apiKey: string;
  name: string;
  models: string[];
}

export interface ConfigView {
  configs: LlmView[];
}

export interface ApiKeyView {
  keyHint: string;
  ready: boolean;
}

/**
 * What the host knows about itself, for a panel that knows none of it.
 *
 * The host outlives the panel: it keeps the conversation, the running turn and
 * the turn counter. Frames cannot carry that, because a frame only says what
 * happened from the moment it was emitted. So a panel reads this once, when it
 * starts, instead of inferring three things it has not been told.
 */
export interface AgentStatus {
  /** The number the host has reached. The next prompt will be this plus one. */
  turn: number;
  phase: 'idle' | 'running' | 'stopping';
  /** How long the live turn has been running. A duration, not a timestamp. */
  ageMs: number;
  /** How large the conversation is, in the terms the panel's meter shows. */
  context: number;
  /** How many records the transcript holds. */
  records: number;
}

export interface EditorContext {
  path: string;
  text: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** The event the host emits every JSONL frame on. */
const STREAM = 'agent:frame';

/** The event the host emits when the on-disk config file changes. */
const CONFIG_CHANGE = 'llm:change';

interface Tauri {
  core: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event: {
    listen: (event: string, cb: (msg: { payload: unknown }) => void) => Promise<() => void>;
  };
}

function tauri(): Tauri | undefined {
  return (globalThis as Record<string, unknown>).__TAURI__ as Tauri | undefined;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = tauri();
  if (!bridge) return Promise.reject(new Error('the agent runs in the desktop app only'));
  return bridge.core.invoke(cmd, args) as Promise<T>;
}

export const agentApi = {
  getConfig: () => invoke<ConfigView>('get_llm_config'),
  getOpenAlexConfig: () => invoke<ApiKeyView>('get_openalex_config'),
  setOpenAlexKey: (apiKey: string) => invoke<ApiKeyView>('set_openalex_key', { apiKey }),

  /** Adds an entry. The host rejects a name that is already taken. */
  addConfig: (config: LlmConfig) => invoke<ConfigView>('add_llm_config', { config }),

  /**
   * Replaces the entry named `name`, keeping its place in the list.
   *
   * `name` is the entry's current identity and `config.name` may differ — that
   * pair is what makes a rename possible without the host having to guess which
   * row the caller meant.
   */
  updateConfig: (name: string, config: LlmConfig) =>
    invoke<ConfigView>('update_llm_config', { name, config }),

  deleteConfig: (name: string) => invoke<ConfigView>('delete_llm_config', { name }),

  /** Points the agent at one model of one stored entry. */
  setActive: (name: string, model: string) =>
    invoke<ConfigView>('set_active_llm_config', { name, model }),

  /** Starts a turn. Resolves once the host has accepted it, not when it ends. */
  send: (prompt: string, root: string, context: EditorContext | null = null) =>
    invoke<void>('agent_send', { prompt, root, context }),

  /** Asks the host what it is doing. See `AgentStatus`. */
  status: () => invoke<AgentStatus>('agent_status'),

  /** Asks the running turn to stop. The transcript survives. */
  abort: () => invoke<void>('agent_abort'),

  /**
   * Drops the transcript the model reads.
   *
   * The host's log is untouched: a turn cleared from the panel still happened.
   */
  clear: () => invoke<void>('agent_clear'),
};

/**
 * Subscribes to frames, already translated.
 *
 * The handler gets UI events rather than raw JSON, so nothing downstream of
 * here knows the wire format exists. Frames arrive as objects, not as the
 * newline-delimited text a standalone sidecar would print, so each one is
 * re-serialised and pushed through the same `translate()` the renderer has
 * always used — one classifier, not two that can disagree.
 */
export function onAgentEvent(handler: (event: UiEvent) => void, ready?: () => void): () => void {
  const bridge = tauri();
  if (!bridge) return () => {};

  let dispose: (() => void) | undefined;
  let cancelled = false;

  void bridge.event
    .listen(STREAM, (message) => {
      for (const event of translate(JSON.stringify(message.payload))) {
        handler(event);
      }
    })
    .then((un) => {
      // The panel can unmount in the same tick it subscribed in, so the
      // unsubscribe has to work before the listener handle exists.
      if (cancelled) un();
      else dispose = un;
      if (!cancelled) ready?.();
    });

  return () => {
    cancelled = true;
    dispose?.();
  };
}

/**
 * Subscribes to config-file changes.
 *
 * `llm.json` is the real configuration — Settings is only one of its editors,
 * and a hand edit while the app runs is as much a change as a save. The host
 * watches the file and says so here; the caller re-reads.
 */
export function onLlmConfigChange(handler: () => void): () => void {
  const bridge = tauri();
  if (!bridge) return () => {};

  let dispose: (() => void) | undefined;
  let cancelled = false;

  void bridge.event.listen(CONFIG_CHANGE, () => handler()).then((un) => {
    if (cancelled) un();
    else dispose = un;
  });

  return () => {
    cancelled = true;
    dispose?.();
  };
}
