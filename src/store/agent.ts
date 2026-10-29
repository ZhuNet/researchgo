import { createSignal } from 'solid-js';

import { agentApi, onAgentEvent, type AgentStatus, type EditorContext } from '../lib/agent';
import type { UiEvent } from '../lib/bridge';
import { onLiteratureProgress, updateLiterature, type LiteratureProgress } from '../lib/literature';

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
  literature?: LiteratureProgress;
}

export type Item =
  | { kind: 'user'; id: string; text: string; context: EditorContext | null; root: string }
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
  | { kind: 'stat'; id: string; ms: number; tokens: number; tools: number };

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
  /** A turn is running and can be stopped. */
  | 'running'
  /** A stop has been asked for; the host is tearing the turn down. */
  | 'stopping';

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
  grep: 'grep',
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
  /**
   * Which turn the host last said it registered, or 0 if it has not said.
   *
   * Adopted from `turn.start` rather than counted here. The panel used to keep
   * its own counter and compare the two, which held only while this process and
   * the host were the same age: a webview that reloaded mid-turn came back
   * counting from one while the host carried on from where it was, so every
   * later `turn.end` named a turn this store had never issued and was thrown
   * away as stale. Since `turn.end` is the only thing that can settle a turn,
   * that left the phase on `running` for the rest of the session — the spinner
   * spinning and the send button showing interrupt, with Enter and the send
   * click both refused by `busy()`. One counter, allocated where the turn is
   * registered, cannot drift from itself.
   */
  let activeTurn = 0;
  const [submitting, setSubmitting] = createSignal(false);
  const [aborting, setAborting] = createSignal(false);
  let sawStatus = false;
  let endedTurn = 0;
  const textIds = new Map<string, string>();
  const toolIds = new Map<string, string>();

  // Anything the panel is doing, for the composer and the working row. `stopping`
  // counts: the turn is still on screen and still real, it is just on its way
  // out, and a panel that forgot that shows a spinner nobody can dismiss.
  // Until the command returns the host has not yet published its snapshot;
  // accepting another command in that gap would be a local race.
  const busy = () => phase() !== 'idle' || submitting();
  /** The stop is in flight: the button is disabled and the turn is going away. */
  const stopping = () => phase() === 'stopping';
  /** Only in this state is there a turn to interrupt. */
  const stoppable = () => phase() === 'running' && !aborting();

  // The host numbers its own frames per turn (`a1`, `a2`, …) and reuses those
  // numbers on the next one, so the turn they belong to is part of the key
  // here. Without it a second turn's answer appends to the first turn's
  // message and its cards land on rows that are already on screen. `activeTurn`
  // is the host's number for the turn in progress, so this is the host's
  // numbering all the way down rather than a local guess at it.
  const frameKey = (id: string) => `${activeTurn}:${id}`;

  /**
   * Ends the turn the panel believes is running, exactly once.
   *
   * The single place `phase` leaves `running` on the host's word, so a turn
   * cannot be closed twice — by its own `turn.end` and by the stop that
   * superseded it.
   */
  function finishTurn(tools: number) {
    if (endedTurn === activeTurn) return;
    endedTurn = activeTurn;
    const ms = performance.now() - startedAt;
    // The turn's cost and how fast it came, as the last row of that turn. The
    // context figure survives the turn on purpose: the transcript does, so the
    // conversation is still that long — zeroing it would make the meter claim
    // an empty context between prompts. The next turn's first usage frame
    // supersedes it, and by then it has grown again.
    setItems((prev) => [...prev, { kind: 'stat', id: uid('s'), ms, tokens: spent().tokens, tools }]);
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
      case 'status':
        {
          const sameTurn = activeTurn === ev.turn;
          sawStatus = true;
          activeTurn = ev.turn;
          if (submitting() && ev.phase === 'running') setSubmitting(false);
          if (aborting() && ev.phase !== 'running') setAborting(false);
          setSpent((prev) => ev.context === prev.context ? prev : { ...prev, context: ev.context });
          setPhase(ev.phase);
          if (ev.phase === 'idle') {
            startedAt = performance.now() - ev.ageMs;
            stopTimer();
            setElapsed(ev.ageMs);
          } else if (!sameTurn || !tick) {
            startedAt = performance.now() - ev.ageMs;
            startTimer();
          }
          break;
        }
      case 'turn.start':
        activeTurn = ev.turn;
        endedTurn = 0;
        break;
      case 'turn.end':
        // A frame carrying any other number belongs to a turn this panel is not
        // running — one that was stopped, and whose `turn.end` is still in
        // flight, or one that began before this panel existed. Applying it would
        // close the turn that replaced it.
        if (ev.turn !== activeTurn) break;
        finishTurn(ev.tools);
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
   * Reads what the host knows that this panel does not, once, on its way up.
   *
   * The host outlives the panel. When a webview reloads mid-turn the host is
   * still working, still holding a transcript, still counting turns — and the
   * panel comes back knowing none of it, having been told only that a turn once
   * existed by frames that stopped arriving the moment it went. Left to itself
   * it then says three things that are false: that the conversation is empty,
   * that nothing is running while something is, and that the counter starts at
   * one. So this is read once rather than inferred forever.
   *
   * Optional in the strict sense that a host which cannot answer leaves the
   * panel where it was — which is where it would have been anyway, since the
   * read only ever corrects a panel that the host outlived.
   */
  async function adopt() {
    let status: AgentStatus | undefined;
    try {
      status = await agentApi.status();
    } catch {
      return;
    }
    // A prompt sent while this read was in flight supersedes whatever it finds:
    // from the moment the panel asked for a turn of its own, the panel is the
    // one that knows. Adopting over the top of it would name the wrong turn.
    if (!status || sawStatus || submitting()) return;

    // The host's number either way. It is the next turn's number once this one
    // ends, and it is what a `turn.end` arriving now has to be checked against.
    activeTurn = status.turn;
    setSpent((prev) => ({ ...prev, context: status!.context }));

    setPhase(status.phase);
    if (status.phase !== 'idle') {
      // A turn this panel did not start and so cannot time from its own click.
      // The host's age is taken as the starting point rather than ignored,
      // because reporting a turn that has been working forty seconds as one
      // that started just now is the same kind of lie this read exists to stop.
      startedAt = performance.now() - status.ageMs;
      startTimer();
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
  async function send(text: string, root: string, editorContext: EditorContext | null = null) {
    const body = text.trim();
    if (!body || busy()) return;
    setSubmitting(true);
    setItems((prev) => [
      ...prev,
      { kind: 'user', id: uid('u'), text: body, context: editorContext, root },
    ]);
    try {
      await agentApi.send(body, root, editorContext);
    } catch (err) {
      setItems((prev) => [
        ...prev,
        { kind: 'notice', id: uid('n'), tone: 'error', text: String(err) },
      ]);
    } finally {
      // The host's status frame releases this lock. Keeping it through the
      // invoke response closes the gap where the event is still in transit.
      if (phase() === 'idle') setSubmitting(false);
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
    setAborting(true);
    try {
      await agentApi.abort();
    } catch (err) {
      setAborting(false);
      setItems((prev) => [
        ...prev,
        { kind: 'notice', id: uid('n'), tone: 'error', text: String(err) },
      ]);
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
  }

  /** Drops the thread on screen and the transcript behind it. The host's log of
   * what happened is not part of either. */
  async function clear() {
    await agentApi.clear();
    stopTimer();
    textIds.clear();
    toolIds.clear();
    setItems([]);
    setSpent((prev) => ({ context: prev.context, tokens: 0 }));
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
   * The clock starts from a backend-provided age and only repaints locally;
   * backend status frames start or stop it.
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
  onLiteratureProgress((turn, callId, progress) => {
    if (turn !== activeTurn) return;
    const id = toolIds.get(frameKey(callId));
    if (!id) return;
    setItems((prev) => prev.map((it) => it.kind === 'tool' && it.id === id && it.name === 'research_literature' && it.status === 'running'
      ? { ...it, literature: updateLiterature(it.literature, progress) } : it));
  });
  onAgentEvent(apply, () => void adopt());

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
