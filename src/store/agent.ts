import { createSignal } from 'solid-js';

import { agentApi, onAgentEvent } from '../lib/agent';
import type { UiEvent } from '../lib/bridge';

export interface AgentTool {
  kind: 'tool';
  id: string;
  callId: string;
  name: string;
  input: string;
  output: string;
  status: 'running' | 'ok' | 'error';
  summary: string;
  ms: number;
}

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | AgentTool
  | { kind: 'patch'; id: string; path: string; op: 'create' | 'modify' | 'delete'; bytes: number }
  | { kind: 'notice'; id: string; tone: 'info' | 'warn' | 'error'; text: string };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

let n = 0;
const uid = (p: string) => `${p}_${++n}`;

const TOOL_META: Record<string, string> = {
  read: 'Read',
  grep: 'Search',
  edit: 'Edit',
  write: 'Write',
  bash: 'Shell',
  latexmk: 'LaTeX',
  glob: 'Glob',
  todowrite: 'Plan',
};

export function createAgent() {
  // An empty thread. The seed that used to be here made the panel look alive
  // before a single model had been called, which is a demo dressed as a
  // feature: it showed tool rows and benchmark output that no run produced.
  const [items, setItems] = createSignal<Item[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [usage, setUsage] = createSignal<Usage>({ input: 0, output: 0, cacheRead: 0 });
  const [session, setSession] = createSignal<{
    id: string;
    model: string;
    cwd: string;
    tools: string[];
  }>({ id: '—', model: '', cwd: '', tools: Object.keys(TOOL_META) });
  const [elapsed, setElapsed] = createSignal(0);

  let startedAt = 0;
  let tick: number | undefined;

  function apply(ev: UiEvent) {
    switch (ev.kind) {
      case 'session':
        setSession({ id: ev.sessionId, model: ev.model, cwd: ev.cwd, tools: ev.tools });
        break;
      case 'text.start':
        setItems((prev) => [...prev, { kind: 'assistant', id: ev.id, text: '', streaming: true }]);
        break;
      case 'text.delta':
        setItems((prev) => {
          const at = prev.findIndex((it) => it.kind === 'assistant' && it.id === ev.id);
          if (at < 0) {
            return [...prev, { kind: 'assistant', id: ev.id, text: ev.text, streaming: true }];
          }
          return prev.map((it, i) =>
            i === at && it.kind === 'assistant' ? { ...it, text: it.text + ev.text } : it,
          );
        });
        break;
      case 'text.end':
        setItems((prev) =>
          prev.map((it) =>
            it.kind === 'assistant' && it.id === ev.id ? { ...it, streaming: false } : it,
          ),
        );
        break;
      case 'tool.start':
        setItems((prev) => [
          ...prev,
          {
            kind: 'tool',
            id: ev.id,
            callId: ev.callId,
            name: ev.name,
            input: formatInput(ev.input),
            output: '',
            status: 'running',
            summary: '',
            ms: 0,
          },
        ]);
        break;
      case 'tool.output':
        setItems((prev) =>
          prev.map((it) =>
            it.kind === 'tool' && it.callId === ev.callId
              ? { ...it, output: it.output + ev.chunk }
              : it,
          ),
        );
        break;
      case 'tool.end':
        setItems((prev) =>
          prev.map((it) =>
            it.kind === 'tool' && it.callId === ev.callId
              ? {
                  ...it,
                  status: ev.ok ? 'ok' : 'error',
                  summary: ev.summary,
                  streaming: false,
                }
              : it,
          ),
        );
        break;
      case 'patch':
        setItems((prev) => [
          ...prev,
          { kind: 'patch', id: uid('p'), path: ev.path, op: ev.op, bytes: ev.bytes },
        ]);
        break;
      case 'usage':
        setUsage({ input: ev.input, output: ev.output, cacheRead: ev.cacheRead });
        break;
      case 'turn.end':
        setBusy(false);
        stopTimer();
        setElapsed(Math.round(performance.now() - startedAt));
        break;
      case 'error':
        setItems((prev) => [
          ...prev,
          { kind: 'notice', id: uid('n'), tone: 'error', text: ev.message },
        ]);
        setBusy(false);
        stopTimer();
        break;
    }
  }

  /**
   * Hands the prompt to the host and waits for frames.
   *
   * Nothing is generated here. The user row is added optimistically so the
   * composer clears instantly, and everything after it arrives as an event —
   * which is why the spinner below is driven by `busy` rather than by a timer
   * that has to be cancelled when the model turns out to be slow.
   */
  async function send(text: string, root: string) {
    const body = text.trim();
    if (!body || busy()) return;
    setItems((prev) => [...prev, { kind: 'user', id: uid('u'), text: body }]);
    setBusy(true);
    startedAt = performance.now();
    try {
      await agentApi.send(body, root);
    } catch (err) {
      setItems((prev) => [
        ...prev,
        { kind: 'notice', id: uid('n'), tone: 'error', text: String(err) },
      ]);
      setBusy(false);
      if (tick) {
        clearInterval(tick);
        tick = undefined;
      }
    }
  }

  /**
   * Asks the host to stop, then settles the rows the turn left half-finished.
   *
   * The host sends its own `turn.end`, so this does not fabricate one — but a
   * turn cancelled mid-stream leaves a tool row spinning and a message marked
   * streaming, and those are corrected here rather than waiting for a frame
   * that will never come.
   */
  async function abort() {
    if (!busy()) return;
    await agentApi.abort().catch(() => undefined);
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'tool' && it.status === 'running'
          ? { ...it, status: 'error', summary: 'stopped' }
          : it.kind === 'assistant' && it.streaming
            ? { ...it, streaming: false }
            : it,
      ),
    );
    setBusy(false);
    if (tick) {
      clearInterval(tick);
      tick = undefined;
    }
    setElapsed(Math.round(performance.now() - startedAt));
  }

  /** Drops the thread on both sides: the transcript the host keeps, and this one. */
  async function clear() {
    await agentApi.clear().catch(() => undefined);
    stopTimer();
    setItems([]);
    setUsage({ input: 0, output: 0, cacheRead: 0 });
    setBusy(false);
  }

  function stopTimer() {
    if (tick) {
      clearInterval(tick);
      tick = undefined;
    }
  }

  // One subscription for the panel's lifetime. Frames arrive for whatever turn
  // is running, so there is nothing to wire up per prompt.
  onAgentEvent(apply);

  return {
    items,
    busy,
    usage,
    session,
    elapsed,
    send,
    abort,
    clear,
    label: (name: string) => TOOL_META[name] ?? name,
  };
}

export type Agent = ReturnType<typeof createAgent>;

function formatInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input as Record<string, unknown>);
  return entries
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}
