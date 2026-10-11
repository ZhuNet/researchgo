/**
 * The agent, as the renderer sees it: three commands and one event.
 *
 * The renderer never opens a socket, holds a key, or parses a stream. It asks
 * the host to run a turn and receives the same JSONL frames the renderer was
 * written against before any of this existed — `translate()` in `bridge.ts` is
 * the boundary, and it has not changed.
 */

import { translate, type UiEvent } from './bridge';

/** What the host is willing to say about one stored endpoint. No key. */
export interface LlmView {
  name: string;
  url: string;
  model: string;
  /** A fingerprint of the stored key, enough to tell two keys apart. */
  keyHint: string;
  /** Whether this entry could actually make a call. */
  ready: boolean;
  /** Whether the agent is currently pointed at this one. */
  active: boolean;
}

export interface LlmConfig {
  url: string;
  apiKey: string;
  name: string;
  model: string;
}

export interface ConfigView {
  configs: LlmView[];
}

export interface AgentInfo {
  id: string;
  model: string;
  root: string;
}

/** The event the host emits every JSONL frame on. */
const STREAM = 'agent:frame';

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

  setActive: (name: string) => invoke<ConfigView>('set_active_llm_config', { name }),

  info: () => invoke<AgentInfo>('agent_info'),

  /** Starts a turn. Resolves once the host has accepted it, not when it ends. */
  send: (prompt: string, root: string) => invoke<void>('agent_send', { prompt, root }),

  /** Asks the running turn to stop. The transcript survives. */
  abort: () => invoke<void>('agent_abort'),

  /** Drops the transcript. The next prompt starts a fresh session. */
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
export function onAgentEvent(handler: (event: UiEvent) => void): () => void {
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
    });

  return () => {
    cancelled = true;
    dispose?.();
  };
}