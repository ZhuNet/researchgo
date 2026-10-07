import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js';

import { Icon } from '../Icon';
import { openPdf, type PdfHandle } from '../../lib/pdf';
import { toast } from '../../store/ui';
import type { Workspace } from '../../store/workspace';
import type { BuildPlan } from '../../store/editor';

const PAGE_W = 595.28;
const PAGE_H = 841.89;

/**
 * The preview of what the project compiled.
 *
 * This pane is one channel: sources in, PDF out. For a TeX project that means
 * XeLaTeX over the main document, and the artifact is the file that command
 * wrote — not "the newest PDF lying around", which is how a preview ends up
 * showing a document older than the source it claims to reflect.
 *
 * Three states, and they are the whole design: not built yet, built and showing
 * the document, or failed and showing why. The failure is shown *here* rather than
 * in a toast because this is where the result belongs — the reader pressed Build
 * in this pane, so the answer belongs in the same pane, and a toast that
 * disappears cannot be read twice.
 *
 * Opening a PDF from the file tree does not land here. A PDF is binary: the tab
 * says so. This pane is for the one the build produced.
 */
export function PdfViewer(props: { ws: Workspace }) {
  const editor = () => props.ws.editor;
  const root = () => props.ws.root();

  /**
   * The one thing this pane shows: the PDF the project's sources compile to.
   *
   * Not a file that happens to be a PDF — opening one of those reports that a PDF
   * is not text. This is the build output channel: nothing to show until the
   * project has been compiled, then the document it produced.
   */
  const target = createMemo(() => editor().artifact()?.absPath ?? null);

  /**
   * Ask what Build would run, once a root exists.
   *
   * Deliberately not "find a PDF that is already there": the preview is empty
   * until the reader compiles something, and a document left in the tree from
   * last week is not what this project builds today.
   */
  createEffect(() => {
    const dir = root();
    if (!dir) return;
    void editor().loadPlan(dir);
  });

  const artifact = createMemo(() => editor().artifact());
  const [handle, setHandle] = createSignal<PdfHandle | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [page, setPage] = createSignal(1);
  const [numPages, setNumPages] = createSignal(0);
  const [zoom, setZoom] = createSignal<number | 'fit'>('fit');
  const [avail, setAvail] = createSignal(720);
  const [visible, setVisible] = createSignal<ReadonlySet<number>>(new Set<number>([1]));
  const [painted, setPainted] = createSignal<ReadonlySet<number>>(new Set<number>());

  let scroller: HTMLDivElement | undefined;
  let wrapEl: HTMLDivElement | undefined;
  let observer: IntersectionObserver | undefined;
  let resize: ResizeObserver | undefined;

  createEffect(() => {
    const abs = target();
    const ws = props.ws;
    if (!abs) return;
    let alive = true;
    setLoading(true);
    setError(null);
    // Re-read whenever the build produced something new: same path, new bytes,
    // and an engine holding the old document would keep showing it.
    editor().revision();
    void ws.backend
      .readArtifact(abs)
      .then((bytes) => openPdf(new Uint8Array(bytes)))
      .then((h) => {
        if (!alive) {
          h.destroy();
          return;
        }
        setHandle(h);
        setNumPages(h.numPages);
        setPainted(new Set<number>());
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    onCleanup(() => {
      alive = false;
    });
  });

  createEffect(() => {
    const el = wrapEl;
    if (!el) return;
    resize = new ResizeObserver(() => setAvail(el.clientWidth - 72));
    resize.observe(el);
    setAvail(el.clientWidth - 72);
    onCleanup(() => resize?.disconnect());
  });

  const scale = createMemo(() => {
    const z = zoom();
    if (z !== 'fit') return z;
    return Math.max(0.3, Math.min(2.4, avail() / PAGE_W));
  });

  const dims = createMemo(() => ({
    w: Math.round(PAGE_W * scale()),
    h: Math.round(PAGE_H * scale()),
  }));

  createEffect(() => {
    const root = scroller;
    const host = wrapEl;
    const total = numPages();
    if (!root || !host || !total) return;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number((entry.target as HTMLElement).dataset.page);
          setVisible((prev) => {
            if (prev.has(n)) return prev;
            const next = new Set(prev);
            next.add(n);
            return next;
          });
        }
      },
      { root, threshold: 0.02 },
    );
    for (let n = 1; n <= total; n++) {
      const el = host.querySelector<HTMLElement>(`[data-page="${n}"]`);
      if (el) observer.observe(el);
    }
    onCleanup(() => observer?.disconnect());
  });

  function markPainted(n: number) {
    setPainted((prev) => {
      if (prev.has(n)) return prev;
      const next = new Set(prev);
      next.add(n);
      return next;
    });
  }

  function jump(dir: number) {
    const pages = wrapEl ? [...wrapEl.querySelectorAll<HTMLElement>('[data-page]')] : [];
    const target = pages[Math.max(0, Math.min(pages.length - 1, page() - 1 + dir))];
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const building = createMemo(() => editor().buildState()?.phase === 'running');
  const state = createMemo(() => editor().buildState());
  const plan = createMemo(() => editor().plan());

  async function build() {
    const dir = root();
    if (!dir || building()) return;
    const outcome = await editor().build(dir);
    if (!outcome) {
      toast('error', 'Build failed', editor().buildState()?.error ?? 'unknown error');
      return;
    }
    if (outcome.ok) {
      const seconds = (outcome.durationMs / 1000).toFixed(1);
      toast(
        'ok',
        'Build succeeded',
        outcome.artifact ? `${outcome.artifact.path} · ${seconds}s` : `${seconds}s`,
      );
    } else {
      toast('error', 'Build failed', `exit ${outcome.code ?? '—'} · see the preview`);
    }
  }

  return (
    <div class="pdf">
      <div class="pdf__bar">
        <div class="pdf__id">
          <Icon name="book" size={14} class="pdf__icon" />
          <span class="truncate">{artifact()?.path.split('/').pop() ?? 'preview'}</span>
          <Show when={artifact()}>
            <Show when={artifact()!.size > 0}>
              <span class="chip">{Math.round((artifact()!.size / 1024) * 10) / 10} KB</span>
              <span class="chip">{relativeTime(artifact()!.builtMs)}</span>
            </Show>
            <Show when={editor().buildCommand()}>
              <span class="chip pdf__tool">
                <Icon name="terminal" size={11} />
                {editor().buildCommand()}
              </span>
            </Show>
          </Show>
        </div>
        <div class="pdf__ctrls">
          <button class="icon-btn" title="Previous page" onClick={() => jump(-1)}>
            <Icon name="chevronRight" size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span class="pdf__page">
            {page()} / {numPages() || '–'}
          </span>
          <button class="icon-btn" title="Next page" onClick={() => jump(1)}>
            <Icon name="chevronRight" size={14} />
          </button>
          <span class="pdf__sep" />
          <button
            class="icon-btn"
            title="Zoom out"
            onClick={() => setZoom(Math.max(0.4, Number((scale() - 0.15).toFixed(2))))}
          >
            <Icon name="minus" size={14} />
          </button>
          <span class="pdf__zoom">{Math.round(scale() * 100)}%</span>
          <button
            class="icon-btn"
            title="Zoom in"
            onClick={() => setZoom(Math.min(3, Number((scale() + 0.15).toFixed(2))))}
          >
            <Icon name="plus" size={14} />
          </button>
          <button
            class="icon-btn"
            classList={{ 'icon-btn--on': zoom() === 'fit' }}
            title="Fit width"
            onClick={() => setZoom('fit')}
          >
            <Icon name="maximize" size={13} />
          </button>
          <span class="pdf__sep" />
          <button
            class="btn"
            classList={{ 'btn--solid': building() }}
            onClick={() => void build()}
            disabled={building() || !root()}
            title={root() ? 'Build this project and show the result here' : 'Open a folder first'}
          >
            <Icon name={building() ? 'refresh' : 'zap'} size={13} class={building() ? 'spin' : ''} />
            {building() ? 'Building…' : 'Build'}
          </button>
        </div>
      </div>

      <div
        class="pdf__scroll scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const mid = el.scrollTop + el.clientHeight / 2;
          const pages = wrapEl ? [...wrapEl.querySelectorAll<HTMLElement>('[data-page]')] : [];
          let current = 1;
          for (const node of pages) {
            if (node.offsetTop <= mid) current = Number(node.dataset.page);
            else break;
          }
          setPage(current);
        }}
      >
        <Switch
          fallback={
            <div class="pdf__empty">
              <Icon name="book" size={28} />
              <h3>Not built yet</h3>
              <p>
                This pane shows what the sources compile to, so it stays empty until
                you build.
              </p>
              <PlanHint plan={plan()} />
              <button
                class="btn btn--solid"
                onClick={() => void build()}
                disabled={building() || !root() || plan()?.buildable === false}
              >
                <Icon name={building() ? 'refresh' : 'zap'} size={13} class={building() ? 'spin' : ''} />
                {building() ? 'Building…' : 'Build'}
              </button>
            </div>
          }
        >
          <Match when={state()?.phase === 'failed'}>
            <div class="pdf__empty">
              <Icon name="alert" size={28} />
              <h3>Build failed</h3>
              <p>
                The reason is below, in full. Nothing was replaced: whatever was on
                screen is still the last thing that actually built.
              </p>
            </div>
          </Match>
          <Match when={target()}>
            <div class="pdf__wrap" ref={wrapEl}>
            <Show when={loading()}>
              <div class="pdf__loading">
                <span class="spinner" />
                <span>Loading document…</span>
              </div>
            </Show>
            <Show when={error()}>
              <div class="pdf__empty">
                <Icon name="alert" size={26} />
                <h3>Could not render PDF</h3>
                <p>{error()}</p>
              </div>
            </Show>
            <For each={Array.from({ length: numPages() }, (_, i) => i + 1)}>
              {(n) => <PdfPage n={n} visible={visible()} painted={painted()} handle={handle()} dims={dims()} onPainted={markPainted} />}
            </For>
            </div>
          </Match>
        </Switch>
      </div>

      <Show when={state()?.phase === 'failed'}>
        <div class="pdf__log scroll">
          <div class="pdf__loghead">
            <Icon name="alert" size={13} />
            <span class="truncate">{editor().buildCommand() || 'build'} failed</span>
            <Show when={editor().buildState()?.error}>
              <span class="chip chip--warn">{editor().buildState()!.error}</span>
            </Show>
            <button class="btn" onClick={() => void build()} disabled={building()}>
              <Icon name="refresh" size={12} />
              Try again
            </button>
          </div>
          <pre class="pdf__logbody">{editor().buildOutput() || 'No output was captured.'}</pre>
        </div>
      </Show>
    </div>
  );
}

/**
 * What the empty preview says about the build it is waiting for.
 *
 * An empty pane with one sentence in it reads as broken. Naming the command, the
 * toolchain and the path the result will appear at makes the pane legible before
 * anything has happened — and when there is no build command to name, it says
 * that instead of offering a button that would fail.
 */
function PlanHint(props: { plan: BuildPlan | null }) {
  return (
    <Switch fallback={<p class="pdf__hint">Looking for a build command…</p>}>
      <Match when={props.plan === null}>
        <p class="pdf__hint">Looking for a build command…</p>
      </Match>
      <Match when={!props.plan?.buildable}>
        <p class="pdf__hint pdf__hint--warn">
          {props.plan?.detail ?? 'No build command found for this project.'}
        </p>
        <Show when={props.plan?.command}>
          <p class="pdf__hint pdf__hint--dim">
            It would have run: <code>{props.plan!.command}</code>
          </p>
        </Show>
      </Match>
      <Match when={props.plan?.buildable}>
        <dl class="pdf__plan">
          <div class="pdf__planrow">
            <dt>Command</dt>
            <dd class="truncate" title={props.plan!.command ?? undefined}>
              {props.plan!.command}
            </dd>
          </div>
          <Show when={props.plan!.reason}>
            <div class="pdf__planrow">
              <dt>Detected from</dt>
              <dd>{props.plan!.reason}</dd>
            </div>
          </Show>
          <Show when={props.plan!.artifact}>
            <div class="pdf__planrow">
              <dt>Result</dt>
              <dd class="truncate" title={props.plan!.artifact ?? undefined}>
                {props.plan!.artifact}
              </dd>
            </div>
          </Show>
        </dl>
      </Match>
    </Switch>
  );
}

/** "12 s ago" from an epoch millis, without pulling in a date library. */
function relativeTime(ms: number): string {
  if (!ms) return 'unknown';
  const delta = Math.max(0, Date.now() - ms);
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}


function PdfPage(props: {
  n: number;
  visible: ReadonlySet<number>;
  painted: ReadonlySet<number>;
  handle: PdfHandle | null;
  dims: { w: number; h: number };
  onPainted: (n: number) => void;
}) {
  let canvas: HTMLCanvasElement | undefined;

  createEffect(() => {
    const h = props.handle;
    const n = props.n;
    if (!h || !canvas) return;
    if (!props.visible.has(n) || props.painted.has(n)) return;
    let alive = true;
    void h
      .paint(n, canvas as HTMLCanvasElement, props.dims.w, props.dims.h)
      .then(() => alive && props.onPainted(n))
      .catch(() => {});
    onCleanup(() => {
      alive = false;
    });
  });

  return (
    <figure
      class="pdfpage"
      data-page={props.n}
      style={{ width: `${props.dims.w}px`, height: `${props.dims.h}px` }}
    >
      <canvas ref={canvas} />
      <span class="pdfpage__no">{props.n}</span>
    </figure>
  );
}
