export type RawEvent =
  | { type: 'assistant.message'; id: string; role: 'assistant'; text: string }
  | { type: 'assistant.delta'; id: string; text: string }
  | { type: 'assistant.done'; id: string }
  | { type: 'tool.start'; id: string; call_id: string; name: string; input: unknown }
  | { type: 'tool.output'; id: string; call_id: string; chunk: string }
  | { type: 'tool.end'; id: string; call_id: string; ok: boolean; summary: string }
  | { type: 'file.patch'; path: string; op: 'create' | 'modify' | 'delete'; bytes: number; diff: string }
  | { type: 'usage'; context: number; tokens: number }
  | { type: 'agent.status'; turn: number; phase: 'idle' | 'running' | 'stopping'; age_ms: number; context: number; records: number }
  | { type: 'turn.start'; turn: number }
  | { type: 'turn.end'; turn: number; reason: 'stop' | 'aborted' | 'error'; tools: number }
  | { type: 'error'; message: string };

export type UiEvent =
  | { kind: 'text.start'; id: string }
  | { kind: 'text.delta'; id: string; text: string }
  | { kind: 'text.end'; id: string }
  | { kind: 'tool.start'; id: string; callId: string; name: string; input: unknown }
  | { kind: 'tool.output'; id: string; callId: string; chunk: string }
  | { kind: 'tool.end'; id: string; callId: string; ok: boolean; summary: string }
  | { kind: 'patch'; path: string; op: 'create' | 'modify' | 'delete'; bytes: number; diff: string }
  | { kind: 'usage'; context: number; tokens: number }
  | { kind: 'status'; turn: number; phase: 'idle' | 'running' | 'stopping'; ageMs: number; context: number; records: number }
  | { kind: 'turn.start'; turn: number }
  | { kind: 'turn.end'; turn: number; reason: 'stop' | 'aborted' | 'error'; tools: number }
  | { kind: 'error'; message: string };

export function translate(line: string): UiEvent[] {
  let raw: RawEvent;
  try {
    raw = JSON.parse(line) as RawEvent;
  } catch {
    return [{ kind: 'error', message: `malformed jsonl: ${line.slice(0, 120)}` }];
  }
  switch (raw.type) {
    case 'assistant.message':
      return [
        { kind: 'text.start', id: raw.id },
        { kind: 'text.delta', id: raw.id, text: raw.text },
        { kind: 'text.end', id: raw.id },
      ];
    case 'assistant.delta':
      return [{ kind: 'text.delta', id: raw.id, text: raw.text }];
    case 'assistant.done':
      return [{ kind: 'text.end', id: raw.id }];
    case 'tool.start':
      return [
        { kind: 'tool.start', id: raw.id, callId: raw.call_id, name: raw.name, input: raw.input },
      ];
    case 'tool.output':
      return [{ kind: 'tool.output', id: raw.id, callId: raw.call_id, chunk: raw.chunk }];
    case 'tool.end':
      return [
        {
          kind: 'tool.end',
          id: raw.id,
          callId: raw.call_id,
          ok: raw.ok,
          summary: raw.summary,
        },
      ];
    case 'file.patch':
      return [{ kind: 'patch', path: raw.path, op: raw.op, bytes: raw.bytes, diff: raw.diff }];
    case 'usage':
      return [{ kind: 'usage', context: raw.context, tokens: raw.tokens }];
    case 'agent.status':
      return [{
        kind: 'status',
        turn: raw.turn,
        phase: raw.phase,
        ageMs: raw.age_ms,
        context: raw.context,
        records: raw.records,
      }];
    case 'turn.start':
      // The host naming the turn it has just registered. The panel adopts this
      // rather than counting prompts of its own, because a count that lives in
      // the webview restarts with the webview while the host's does not — and two
      // counters that have to agree by equality are two sources of truth.
      return [{ kind: 'turn.start', turn: raw.turn }];
    case 'turn.end':
      // The turn number travels with the frame rather than being inferred. A
      // stopped turn settles itself, so the `turn.end` announcing that can
      // still be in flight when the next prompt starts; the consumer needs to be
      // able to tell that one from the frame that ends the turn it is running.
      return [{ kind: 'turn.end', turn: raw.turn, reason: raw.reason, tools: raw.tools }];
    case 'error':
      return [{ kind: 'error', message: raw.message }];
    default: {
      // A frame this switch does not know is protocol drift, and drift that
      // is dropped silently is drift that ships: the tag vocabulary on the
      // Rust side once drifted from dot-case to snake_case and every frame
      // but `error` and `usage` vanished here without a trace, leaving turns
      // that spun forever. Surfaced, the next drift is a visible error the
      // moment it happens.
      const unknown = (raw as { type: string }).type;
      return [{ kind: 'error', message: `unrecognised frame type: ${unknown}` }];
    }
  }
}

export type Transport = {
  send: (payload: unknown) => void;
  abort: () => void;
  subscribe: (fn: (line: string) => void) => () => void;
};

interface TauriBridge {
  window?: {
    getCurrentWindow?: () => {
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      startDragging: () => void;
    };
  };
}

function tauri(): TauriBridge | undefined {
  return (globalThis as Record<string, unknown>).__TAURI__ as TauriBridge | undefined;
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const windowCtl = {
  minimize: () => tauri()?.window?.getCurrentWindow?.().minimize(),
  toggleMaximize: () => tauri()?.window?.getCurrentWindow?.().toggleMaximize(),
  close: () => tauri()?.window?.getCurrentWindow?.().close(),
  startDragging: () => tauri()?.window?.getCurrentWindow?.().startDragging(),
};
