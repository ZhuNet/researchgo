export type RawEvent =
  | { type: 'session.start'; session_id: string; model: string; cwd: string; tools: string[] }
  | { type: 'assistant.message'; id: string; role: 'assistant'; text: string }
  | { type: 'assistant.delta'; id: string; text: string }
  | { type: 'assistant.done'; id: string }
  | { type: 'tool.start'; id: string; call_id: string; name: string; input: unknown }
  | { type: 'tool.output'; id: string; call_id: string; chunk: string }
  | { type: 'tool.end'; id: string; call_id: string; ok: boolean; summary: string }
  | { type: 'file.patch'; path: string; op: 'create' | 'modify' | 'delete'; bytes: number }
  | { type: 'usage'; input: number; output: number; cache_read: number }
  | { type: 'turn.end'; reason: 'stop' | 'aborted' | 'error' }
  | { type: 'error'; message: string };

export type UiEvent =
  | { kind: 'session'; sessionId: string; model: string; cwd: string; tools: string[] }
  | { kind: 'text.start'; id: string }
  | { kind: 'text.delta'; id: string; text: string }
  | { kind: 'text.end'; id: string }
  | { kind: 'tool.start'; id: string; callId: string; name: string; input: unknown }
  | { kind: 'tool.output'; id: string; callId: string; chunk: string }
  | { kind: 'tool.end'; id: string; callId: string; ok: boolean; summary: string }
  | { kind: 'patch'; path: string; op: 'create' | 'modify' | 'delete'; bytes: number }
  | { kind: 'usage'; input: number; output: number; cacheRead: number }
  | { kind: 'turn.end'; reason: 'stop' | 'aborted' | 'error' }
  | { kind: 'error'; message: string };

export function translate(line: string): UiEvent[] {
  let raw: RawEvent;
  try {
    raw = JSON.parse(line) as RawEvent;
  } catch {
    return [{ kind: 'error', message: `malformed jsonl: ${line.slice(0, 120)}` }];
  }
  switch (raw.type) {
    case 'session.start':
      return [
        {
          kind: 'session',
          sessionId: raw.session_id,
          model: raw.model,
          cwd: raw.cwd,
          tools: raw.tools ?? [],
        },
      ];
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
      return [{ kind: 'patch', path: raw.path, op: raw.op, bytes: raw.bytes }];
    case 'usage':
      return [
        { kind: 'usage', input: raw.input, output: raw.output, cacheRead: raw.cache_read },
      ];
    case 'turn.end':
      return [{ kind: 'turn.end', reason: raw.reason }];
    case 'error':
      return [{ kind: 'error', message: raw.message }];
    default:
      return [];
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
};
