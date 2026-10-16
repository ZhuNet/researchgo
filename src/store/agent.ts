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
  | { kind: 'patch'; id: string; path: string; op: 'create' | 'modify' | 'delete'; bytes: number; diff: string }
  | { kind: 'notice'; id: string; tone: 'info' | 'warn' | 'error'; text: string }
  /**
   * How a finished turn went, as the last row of that turn's own transcript.
   *
   * A row rather than a field on the store because a tally belongs to the turn
   * it describes: held apart from the transcript it could only ever describe
   * whichever turn ran last, which is the wrong answer as soon as there are two.
   */
  | { kind: 'stat'; id: string; ms: number; tokens: number };

let n = 0;
const uid = (p: string) => `${p}_${++n}`;

/**
 * What the panel is doing, as one state rather than a set of booleans.
 *
 * The states are ordered and only ever move forward: a send becomes a running
 * turn, a running turn becomes a stop, a stop becomes idle. Everything the
 * composer needs to decide what to draw follows from which one it is in, and no
 * combination of them can say "idle and stopping" — which is how a stop button
 * used to come back while the turn behind it was still running.
 */
type Phase =
  /** Nothing is happening. The only state a prompt may be sent from. */
  | 'idle'
  /** The prompt has been handed to the host and no turn exists yet. */
  | 'sending'
  /** A turn is running and can be stopped. */
  | 'running'
  /** A stop has been asked for; the host is tearing the turn down. */
  | 'stopping';

/**
 * How long the renderer waits for a stop before settling the panel itself.
 *
 * The host already refuses to wait forever; this is the same backstop on the
 * other side of the IPC, for the case where the answer never comes back at all.
 * Long enough that a real stop — which is immediate — never gets near it, and
 * short enough that a lost answer does not leave a disabled button on screen
 * until the app is restarted.
 */
const STOP_BACKSTOP_MS = 12_000;

/**
 * How often the running timer repaints.
 *
 * A tenth of a second, because that is the resolution the panel prints: a
 * faster tick would recompute the same tenth more often than anyone can read
 * it, and a slower one would make the digits jump. Display only — nothing about
 * a turn depends on it, so a dropped frame costs a stale number rather than a
 * wrong one.
 */
const TICK_MS = 100;

/**
 * The window the context meter is a fraction of.
 *
 * A round million. Not a budget the panel enforces and not a total that
 * accumulates toward something — it is the scale the bar is drawn against, and
 * a model will have refused the request long before the bar fills. Nothing
 * wraps, resets or persists: the figure is however large the conversation
 * currently is, which is the whole of what a context window means.
 */
export const CONTEXT_WINDOW = 1_000_000;

/** The two figures a turn produces, both straight from the provider. */
export interface Usage {
  /** How large the conversation is right now. */
  context: number;
  /** What this turn has cost across every request it made. */
  tokens: number;
}

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
  const [phase, setPhase] = createSignal<Phase>('idle');
  const [spent, setSpent] = createSignal<Usage>({ context: 0, tokens: 0 });
  const [elapsed, setElapsed] = createSignal(0);

  /** The context meter: how large the conversation is right now. */
  const context = () => spent().context;

  let startedAt = 0;
  let tick: ReturnType<typeof setInterval> | undefined;
  let turnSerial = 0;
  let activeTurn = 0;
  const textIds = new Map<string, string>();
  const toolIds = new Map<string, string>();

  // Anything the panel is doing, for the composer and the working row. `stopping`
  // counts: the turn is still on screen and still real, it is just on its way
  // out, and a panel that forgot that shows a spinner nobody can dismiss.
  const busy = () => phase() !== 'idle';
  /** The stop is in flight: the button is disabled and the turn is going away. */
  const stopping = () => phase() === 'stopping';
  /** Only in this state is there a turn to interrupt. */
  const stoppable = () => phase() === 'running';

  // The host numbers its own frames per turn (`a1`, `a2`, …) and reuses those
  // numbers on the next one, so the turn they belong to is part of the key
  // here. Without it a second turn's answer appends to the first turn's
  // message and its cards land on rows that are already on screen.
  const frameKey = (id: string) => `${activeTurn}:${id}`;

  /**
   * Ends the turn the panel believes is running, exactly once.
   *
   * The single place `phase` leaves `running` on the host's word, so a turn
   * cannot be closed twice — by its own `turn.end` and by the stop that
   * superseded it.
   */
  function settle() {
    if (phase() === 'idle') return;
    setPhase('idle');
    stopTimer();
    const ms = performance.now() - startedAt;
    // The turn's cost and how fast it came, as the last row of that turn. The
    // context figure survives the turn on purpose: the transcript does, so the
    // conversation is still that long — zeroing it would make the meter claim
    // an empty context between prompts. The next turn's first usage frame
    // supersedes it, and by then it has grown again.
    setItems((prev) => [...prev, { kind: 'stat', id: uid('s'), ms, tokens: spent().tokens }]);
    setSpent({ context: spent().context, tokens: 0 });
  }

  function apply(ev: UiEvent) {
    switch (ev.kind) {
      case 'text.start':
        {
          const key = frameKey(ev.id);
          const id = uid('a');
          textIds.set(key, id);
          setItems((prev) => [...prev, { kind: 'assistant', id, text: '', streaming: true }]);
        }
        break;
      case 'text.delta':
        setItems((prev) => {
          const key = frameKey(ev.id);
          let id = textIds.get(key);
          if (!id) {
            id = uid('a');
            textIds.set(key, id);
          }
          const at = prev.findIndex((it) => it.kind === 'assistant' && it.id === id);
          if (at < 0) {
            return [...prev, { kind: 'assistant', id, text: ev.text, streaming: true }];
          }
          return prev.map((it, i) =>
            i === at && it.kind === 'assistant' ? { ...it, text: it.text + ev.text } : it,
          );
        });
        break;
      case 'text.end':
        {
          const id = textIds.get(frameKey(ev.id));
          if (id) {
            setItems((prev) =>
              prev.map((it) => it.kind === 'assistant' && it.id === id ? { ...it, streaming: false } : it),
            );
          }
        }
        break;
      case 'tool.start':
        setItems((prev) => {
          // Tool call ids can be reused by a later turn. Give each card a
          // unique renderer id, while retaining a per-turn lookup for frames.
          const key = frameKey(ev.callId);
          const id = uid('t');
          toolIds.set(key, id);
          return [
            ...prev,
            {
              kind: 'tool',
              id,
              callId: ev.callId,
              name: ev.name,
              input: formatInput(ev.input),
              output: '',
              status: 'running',
              summary: '',
              ms: 0,
            },
          ];
        });
        break;
      case 'tool.output':
        {
          const id = toolIds.get(frameKey(ev.callId));
          if (!id) break;
          setItems((prev) =>
          prev.map((it) =>
            it.kind === 'tool' && it.id === id
              ? { ...it, output: it.output + ev.chunk }
              : it,
          ),
          );
        }
        break;
      case 'tool.end':
        {
          const key = frameKey(ev.callId);
          const id = toolIds.get(key);
          if (!id) break;
          toolIds.delete(key);
          setItems((prev) =>
          prev.map((it) =>
            it.kind === 'tool' && it.id === id
              ? {
                  ...it,
                  status: ev.ok ? 'ok' : 'error',
                  summary: ev.summary,
                  streaming: false,
                }
              : it,
          ),
          );
        }
        break;
      case 'patch':
        setItems((prev) => [
          ...prev,
          { kind: 'patch', id: uid('p'), path: ev.path, op: ev.op, bytes: ev.bytes, diff: ev.diff },
        ]);
        break;
      case 'usage':
        setSpent({ context: ev.context, tokens: ev.tokens });
        break;
      case 'turn.end':
        // The host counts its turns from 1 and so does `activeTurn`, one per
        // prompt the panel sends, so the two numbers line up. A frame carrying
        // any other number belongs to a turn that is already over: its panel
        // was settled by the stop that ended it, and applying it now would
        // close the turn that replaced it.
        if (ev.turn !== activeTurn) break;
        // A turn in the middle of being stopped settles itself when the stop
        // returns, and not before — that is the whole point of keeping the
        // button disabled until the host says the turn is gone.
        if (stopping()) break;
        settle();
        break;
      case 'error':
        setItems((prev) => [
          ...prev,
          { kind: 'notice', id: uid('n'), tone: 'error', text: ev.message },
        ]);
        // Deliberately does not end the turn. Every error the loop emits is
        // followed by a `turn.end`, and ending the turn here as well is how an
        // error in one turn used to leave the next one looking finished.
        break;
    }
  }

  /**
   * Hands the prompt to the host and waits for frames.
   *
   * Nothing is generated here. The user row is added optimistically so the
   * composer clears instantly, and everything after it arrives as an event —
   * which is why the spinner below is driven by `phase` rather than by a timer
   * that has to be cancelled when the model turns out to be slow.
   */
  async function send(text: string, root: string) {
    const body = text.trim();
    if (!body || busy()) return;
    setItems((prev) => [...prev, { kind: 'user', id: uid('u'), text: body }]);
    activeTurn = ++turnSerial;
    setPhase('sending');
    startedAt = performance.now();
    // `spent` was already emptied by the `settle` that let this prompt be sent
    // at all, so the turn starts counting from zero without restating it here.
    startTimer();
    try {
      await agentApi.send(body, root);
      // The turn exists from here on, and only from here on can it be stopped.
      // Between the click and this line there is nothing to interrupt, which is
      // why the button is disabled in `sending` rather than armed at the click.
      setPhase('running');
    } catch (err) {
      setItems((prev) => [
        ...prev,
        { kind: 'notice', id: uid('n'), tone: 'error', text: String(err) },
      ]);
      settle();
    }
  }

  /**
   * Stops the running turn, and returns when the turn is actually gone.
   *
   * The host drops the model response mid-stream and kills a running command
   * rather than waiting for either to finish, so this is not a wait on the
   * network — it is a wait for the turn to unwind. Until it returns the button
   * stays disabled: a stop that returned early would put the send button back
   * while the transcript is still being written, and the prompt typed into that
   * window would land on top of a turn nobody could see.
   */
  async function abort() {
    if (!stoppable()) return;
    setPhase('stopping');
    try {
      await Promise.race([
        agentApi.abort(),
        new Promise((resolve) => setTimeout(resolve, STOP_BACKSTOP_MS)),
      ]);
    } catch {
      // Nothing to say and nothing to do. The host timed out waiting for a turn
      // it could not tear down; the rows below are settled regardless, and the
      // host is still the only thing that writes the transcript.
    }
    // The host settles the rows it can — a command it killed still ends with a
    // frame. This covers the ones it could not: a tool that never got far
    // enough to report, and the message whose stream was cut mid-word.
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'tool' && it.status === 'running'
          ? { ...it, status: 'error', summary: 'stopped' }
          : it.kind === 'assistant' && it.streaming
            ? { ...it, streaming: false }
            : it,
      ),
    );
    settle();
  }

  /** Drops the thread on screen and the transcript behind it. The host's log of
   * what happened is not part of either. */
  async function clear() {
    // Clearing under a running turn empties the panel and then lets the turn go
    // on filling it again, so the thread comes back from nothing. Stopping first
    // costs a moment and is the same serial path the stop button uses.
    if (stoppable()) await abort();
    await agentApi.clear().catch(() => undefined);
    stopTimer();
    textIds.clear();
    toolIds.clear();
    setItems([]);
    setSpent({ context: 0, tokens: 0 });
    settle();
  }

  function stopTimer() {
    if (tick) {
      clearInterval(tick);
      tick = undefined;
    }
  }

  /**
   * Repaints `elapsed` for as long as a turn runs.
   *
   * The clock is the renderer's own rather than the host's: `startedAt` was set
   * when the prompt was handed over and is not touched again, so there is no
   * round trip to negotiate for a number that exists only to be looked at. The
   * interval stops at `settle`, and one already past due when a turn ends loses
   * to the frozen `elapsed` written there.
   */
  function startTimer() {
    stopTimer();
    const repaint = () => setElapsed(performance.now() - startedAt);
    repaint();
    // Bare `setInterval` rather than `window.` because this module is also
    // driven headlessly by tests, and `unref` because a timer that only paints
    // a number must not be the reason a process stays alive — in a browser the
    // handle is a number and has no `unref`, hence the optional call.
    const handle = setInterval(repaint, TICK_MS) as ReturnType<typeof setInterval> & {
      unref?: () => void;
    };
    handle.unref?.();
    tick = handle;
  }

  // One subscription for the panel's lifetime. Frames arrive for whatever turn
  // is running, so there is nothing to wire up per prompt.
  onAgentEvent(apply);

  return {
    items,
    busy,
    stopping,
    stoppable,
    spent,
    elapsed,
    context,
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
