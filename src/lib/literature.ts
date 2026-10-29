export interface LiteraturePaper {
  title: string;
  url?: string;
  source: { status: 'pdf' | 'html' | 'unavailable'; path?: string | null; url?: string | null };
  extraction_note?: string | null;
}

export interface LiteratureProgress {
  total: number;
  papers: { title: string; result?: LiteraturePaper }[];
}

export type LiteratureEvent =
  | { stage: 'retrieving'; total: number }
  | { stage: 'paper'; index: number; title: string }
  | { stage: 'result'; index: number; paper: LiteraturePaper };

export function updateLiterature(previous: LiteratureProgress | undefined, event: LiteratureEvent): LiteratureProgress {
  if (event.stage === 'retrieving') return { total: event.total, papers: [] };
  const next = { total: previous?.total ?? 0, papers: [...(previous?.papers ?? [])] };
  next.papers[event.index] = event.stage === 'paper'
    ? { title: event.title }
    : { title: event.paper.title, result: event.paper };
  return next;
}

export function onLiteratureProgress(handler: (turn: number, callId: string, progress: LiteratureEvent) => void) {
  const bridge = (globalThis as { __TAURI__?: { event: { listen: (name: string, cb: (event: { payload: { turn: number; callId: string; progress: LiteratureEvent } }) => void) => Promise<() => void> } } }).__TAURI__;
  if (bridge) void bridge.event.listen('literature:progress', (event) => {
    handler(event.payload.turn, event.payload.callId, event.payload.progress);
  });
}
