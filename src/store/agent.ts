import { createSignal } from 'solid-js';

import { translate, type UiEvent } from '../lib/bridge';

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

function framesFor(prompt: string, seq: number): string[] {
  const lower = prompt.toLowerCase();
  const wantsLatex = /latex|tex|pdf|paper|figure|table/.test(lower);
  const wantsTree = /tree|file|folder|node|explorer/.test(lower);
  const id = `a${seq}`;
  const out: string[] = [];

  const say = (text: string) => {
    for (const chunk of chunkText(text, 34)) {
      out.push(JSON.stringify({ type: 'assistant.delta', id, text: chunk }));
    }
    out.push(JSON.stringify({ type: 'assistant.done', id }));
  };

  const tool = (
    name: string,
    input: unknown,
    output: string,
    summary: string,
    ok = true,
  ) => {
    const callId = uid('call');
    out.push(JSON.stringify({ type: 'tool.start', id, call_id: callId, name, input }));
    for (const chunk of chunkText(output)) {
      out.push(JSON.stringify({ type: 'tool.output', id, call_id: callId, chunk }));
    }
    out.push(
      JSON.stringify({ type: 'tool.end', id, call_id: callId, ok, summary }),
    );
    return callId;
  };

  if (wantsTree) {
    say(
      `The tree is already normalized, so the cost is in the projection, not the store. I'll confirm where rows are derived before touching anything.`,
    );
    tool(
      'grep',
      { pattern: 'buildRows', path: 'apps/desktop/src' },
      'src/lib/tree.ts:14  export function buildRows(map: FsMap, expanded: ReadonlySet<string>): Row[] {\nsrc/store/workspace.ts:52  const rows = createMemo(() => buildRows(fs as FsMap, expanded()));',
      '2 matches in 2 files',
    );
    tool(
      'edit',
      { path: 'src/store/workspace.ts', op: 'replace', lines: '52-56' },
      'patched src/store/workspace.ts (+4 −3)\n  · projection memo now keyed by (fs, expanded) tuple\n  · explicit bump() removed in favour of store tracking',
      'src/store/workspace.ts patched',
    );
    out.push(
      JSON.stringify({
        type: 'file.patch',
        path: '/apps/desktop/src/store/workspace.ts',
        op: 'modify',
        bytes: 3184,
      }),
    );
    say(
      `Done. The memo now recomputes only when the map or the expansion set actually changes, and the synthetic 500k-node corpus holds a flat frame cost.`,
    );
  } else if (wantsLatex) {
    say(`Recompiling the manuscript so the preview reflects the new table.`),
      tool(
        'read',
        { path: 'paper/sections/results.tex' },
        '…\\begin{tabular}{lrrr}\n\\toprule\nNodes & Tree build & First paint & Frame cost \\\\\n500{,}000 & 71 ms & 5.6 ms & 0.4 ms \\\\\n\\bottomrule',
        'paper/sections/results.tex · 1.4 KB',
      ),
      tool(
        'edit',
        { path: 'paper/sections/results.tex', op: 'replace', lines: '18-19' },
        'patched paper/sections/results.tex (+1 −1)\n  · widened the tabular column spec to account for the 500k row',
        'paper/sections/results.tex patched',
      ),
      tool(
        'latexmk',
        { target: 'paper/main.tex', job: 'pdf' },
        'Latexmk: Nothing to do? paper/build/main.pdf regenerated.\nOutput written on paper/build/main.pdf (3 pages, 214.6 KB).',
        'pdf rebuilt · 3 pages · 1.9 s',
      );
    out.push(
      JSON.stringify({
        type: 'file.patch',
        path: '/paper/build/main.pdf',
        op: 'modify',
        bytes: 219_742,
      }),
    );
    say(
      `The PDF is rebuilt and the preview pane already has the new bytes — switch the stage to Split if you want source and output side by side.`,
    );
  } else {
    say(`Reading the protocol first; the renderer contract depends on it.`),
      tool(
        'read',
        { path: 'crates/omp-wire/src/protocol.rs' },
        'pub enum Frame {\n    SessionStart { session_id: String, model: String, cwd: String, tools: Vec<String> },\n    AssistantDelta { id: String, text: String },\n    ToolStart { id: String, call_id: String, name: String, input: Value },\n    …\n}',
        'crates/omp-wire/src/protocol.rs · 2.1 KB',
      ),
      tool(
        'bash',
        { cmd: 'cargo check -p omp-wire' },
        '    Checking omp-wire v0.4.0\n    Finished dev profile in 1.42s',
        'cargo check · ok · 1.4 s',
      );
    say(
      `Everything checks out. The frame set is complete for the panel you are looking at — the only gap is \`Frame::Usage\`, which I would move out of the ordered stream.`,
    );
  }

  out.push(
    JSON.stringify({
      type: 'usage',
      input: 24_180 + seq * 1_140,
      output: 1_284 + seq * 96,
      cache_read: 18_902,
    }),
    JSON.stringify({ type: 'turn.end', reason: 'stop' }),
  );
  return out;
}

function chunkText(text: string, size = 220): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

function seed(): Item[] {
  return [
    {
      kind: 'user',
      id: uid('u'),
      text: 'The file tree gets sluggish once a workspace passes ~50k nodes. Find out why and fix it.',
    },
    {
      kind: 'assistant',
      id: uid('a'),
      text: 'Two suspects: row projection running on every reactive read, and no windowing on the rendered rows. Let me measure before changing anything.',
      streaming: false,
    },
    {
      kind: 'tool',
      id: uid('t'),
      callId: uid('call'),
      name: 'bash',
      input: 'cargo bench -p omp-core --bench projection',
      output:
        'projection/flat_map      71.2 ms   500_000 nodes\nprojection/deep_walk    412.8 ms   500_000 nodes\nwindowing/rows_1k        0.21 ms   1_000 visible',
      status: 'ok',
      summary: 'bench · 500k nodes',
      ms: 1840,
    },
    {
      kind: 'assistant',
      id: uid('a'),
      text: 'Found it. `buildRows` walked the whole tree on every expand because the memo depended on the raw store proxy instead of the expansion set. Windowing was fine.',
      streaming: false,
    },
    {
      kind: 'patch',
      id: uid('p'),
      path: '/apps/desktop/src/store/workspace.ts',
      op: 'modify',
      bytes: 3184,
    },
    {
      kind: 'assistant',
      id: uid('a'),
      text: 'Patch applied. Projection is now incremental and the frame cost is flat regardless of workspace size.',
      streaming: false,
    },
  ];
}

export function createAgent() {
  const [items, setItems] = createSignal<Item[]>(seed());
  const [busy, setBusy] = createSignal(false);
  const [usage, setUsage] = createSignal<Usage>({ input: 48_210, output: 3_940, cacheRead: 31_200 });
  const [session, setSession] = createSignal<{
    id: string;
    model: string;
    cwd: string;
    tools: string[];
  }>({ id: '01JQZ8XK4M', model: 'claude-sonnet-4.6', cwd: '~/researchgo', tools: Object.keys(TOOL_META) });
  const [elapsed, setElapsed] = createSignal(0);

  let timers: number[] = [];
  let turn = 0;
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
        if (tick) {
          clearInterval(tick);
          tick = undefined;
        }
        setElapsed(Math.round(performance.now() - startedAt));
        break;
      case 'error':
        setItems((prev) => [
          ...prev,
          { kind: 'notice', id: uid('n'), tone: 'error', text: ev.message },
        ]);
        setBusy(false);
        break;
    }
  }

  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers = [];
  }

  function abort() {
    if (!busy()) return;
    clearTimers();
    for (const ev of translate(JSON.stringify({ type: 'turn.end', reason: 'aborted' })))
      apply(ev);
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'tool' && it.status === 'running'
          ? { ...it, status: 'error', summary: 'aborted' }
          : it.kind === 'assistant' && it.streaming
            ? { ...it, streaming: false }
            : it,
      ),
    );
  }

  function send(text: string) {
    const body = text.trim();
    if (!body || busy()) return;
    const seq = ++turn;
    setItems((prev) => [...prev, { kind: 'user', id: uid('u'), text: body }]);
    setBusy(true);
    startedAt = performance.now();
    clearTimers();
    const frames = framesFor(body, seq);
    let delay = 90;
    for (const frame of frames) {
      timers.push(
        setTimeout(() => {
          for (const ev of translate(frame)) apply(ev);
        }, delay),
      );
      delay += frame.includes('tool.output') ? 22 : frame.includes('assistant') ? 24 : 130;
    }
  }

  function clear() {
    clearTimers();
    setItems([]);
  }

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
