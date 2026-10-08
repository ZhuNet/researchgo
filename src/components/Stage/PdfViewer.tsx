import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js';
import 'pdfjs-viewer-element';
import type PdfjsViewerElement from 'pdfjs-viewer-element';

import { Icon } from '../Icon';
import { theme, toast } from '../../store/ui';
import type { Workspace } from '../../store/workspace';
import type { BuildPlan } from '../../store/editor';

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
 * Rendering, pagination, zoom, search and the text layer are pdf.js's own viewer,
 * used as shipped. Only the two things it cannot know about are ours: the command
 * that produced the document, and the build button — which rides inside that
 * viewer's toolbar rather than beside it, for the reason given at `mountToolbar`.
 *
 * Opening a PDF from the file tree does not land here. A PDF is binary: the tab
 * says so. This pane is for the one the build produced.
 */
export function PdfViewer(props: { ws: Workspace }) {
  const editor = () => props.ws.editor;
  const root = () => props.ws.root();

  /**
   * The document to show: the file the build wrote, not any PDF in the tree.
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

  const [viewer, setViewer] = createSignal<PdfjsViewerElement | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [buildButton, setBuildButton] = createSignal<HTMLButtonElement | null>(null);

  /**
   * The element, created by hand rather than written as JSX.
   *
   * Three of its attributes are only read while it initialises, and the viewer it
   * starts is loaded into an iframe that fetches them same-origin — so they have
   * to be set before it is in the document. `document.createElement` makes that
   * ordering explicit; JSX would attach first and set second.
   */
  function mount(host: HTMLDivElement) {
    const base = import.meta.env.BASE_URL;
    const el = document.createElement('pdfjs-viewer-element') as PdfjsViewerElement;
    // A CID font with no ToUnicode table — which is what XeLaTeX produces for
    // CJK — can only be mapped through the predefined CMaps, and pdf.js 5+ needs
    // WebAssembly for JPEG2000 and colour management. Without these the engine
    // reports `translateFont failed` and CJK on the page turns to noise while the
    // Latin text, which carries ToUnicode, renders fine.
    el.setAttribute('c-map-url', `${base}pdfjs/cmaps/`);
    el.setAttribute('standard-font-data-url', `${base}pdfjs/standard_fonts/`);
    el.setAttribute('wasm-url', `${base}pdfjs/wasm/`);
    el.setAttribute('icc-url', `${base}pdfjs/iccs/`);
    // The viewer assembles these names at runtime (`imageResourcesPath` plus a
    // prefix it chooses), so Vite cannot emit them and they are served from
    // `public/` instead. Left unset, the annotation toolbar's buttons come up as
    // blank squares.
    el.setAttribute('image-resources-path', `${base}pdfjs/images/`);
    el.setAttribute('iframe-title', 'PDF preview');
    host.appendChild(el);
    setViewer(el);

    // Only the width: colour, hover and the active theme's own variables come
    // from pdf.js's `.toolbarViewerButton`, which is what keeps this button
    // legible in both themes without a second set of rules here.
    void el.injectViewerStyles?.(
      `#toolbarViewerRight button.rg-build {
         width: auto;
         min-width: 4.5em;
         padding-inline: 0.7em;
         font-size: 11px;
       }`,
    );

    onCleanup(() => {
      el.remove();
      setViewer(null);
    });
  }

  /**
   * The app's theme, in the viewer's vocabulary.
   *
   * pdf.js ships its own light and dark themes and switches between them at
   * runtime, so this is an attribute write rather than a stylesheet of ours.
   */
  createEffect(() => {
    const el = viewer();
    if (!el) return;
    el.setAttribute('viewer-css-theme', theme() === 'dark' ? 'DARK' : 'LIGHT');
  });

  /**
   * The document itself.
   *
   * Bytes rather than a URL: a webview cannot fetch a filesystem path, and handing
   * pdf.js a blob URL would put its own range requests back in — it would
   * re-request the whole document for every range it wants, out of a URL this
   * window has to keep alive. `open` also swaps the document without rebuilding
   * the viewer, so the toolbar and the injected button survive a rebuild.
   */
  createEffect(() => {
    const el = viewer();
    const abs = target();
    if (!el || !abs) return;
    let alive = true;
    setLoadError(null);
    void (async () => {
      try {
        // Both at once: the bytes are the slow half on a large document and the
        // viewer is the slow half on first run, and neither has to wait for the
        // other to be worth having.
        const [{ viewerApp }, bytes] = await Promise.all([
          el.initPromise,
          props.ws.backend.readArtifact(abs),
        ]);
        if (!alive) return;
        // `{ data }`, not the bytes alone: `getDocument` wants exactly one of
        // `data`, `range` or `url`, and handing it a bare `Uint8Array` fails with
        // "expected either `data`, `range`, or `url` parameter" — a mistake the
        // package's own type definition invites, since it also admits a
        // `Uint8Array` that the runtime does not accept here.
        //
        // Fresh bytes every time, and only ever once: `getDocument` transfers the
        // buffer to the worker, which detaches it. A second `open` with the same
        // array would see a zero-length one.
        await viewerApp?.open({ data: new Uint8Array(bytes) });
      } catch (err: unknown) {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    onCleanup(() => {
      alive = false;
    });
  });

  /**
   * Build, inside pdf.js's own toolbar.
   *
   * Appended to the right-hand group rather than floated over the bar. The
   * toolbar is a flex row whose left group grows to fill, so an element added to
   * the right group lands at the end of that row and is laid out as part of it —
   * no z-index, no measured height, and nothing to overlap once the window is
   * narrow enough that pdf.js collapses its own buttons.
   *
   * The element loads its viewer into a same-origin iframe, so the toolbar is
   * reachable as a document; the wait is bounded because a viewer that never
   * finishes loading should leave the pane working rather than hang on it.
   */
  createEffect(() => {
    const el = viewer();
    if (!el) return;
    let alive = true;
    let button: HTMLButtonElement | undefined;
    void el.initPromise
      .then(() => toolbarDocument(el, 10_000))
      .then((doc) => {
        if (!alive || !doc) return;
        const host = doc.querySelector('#toolbarViewerRight');
        if (!host) return;
        button = doc.createElement('button');
        button.type = 'button';
        button.className = 'toolbarViewerButton rg-build';
        button.title = 'Build this project and show the result here';
        button.addEventListener('click', () => void build());
        host.appendChild(button);
        setBuildButton(button);
      })
      .catch(() => {});
    onCleanup(() => {
      alive = false;
      button?.remove();
      setBuildButton(null);
    });
  });

  /**
   * The button's own label and disabled state.
   *
   * The button lives in another document, so Solid does not own it; this is what
   * keeps it honest after the injection effect has run once.
   */
  createEffect(() => {
    const button = buildButton();
    const busy = building();
    if (!button) return;
    button.textContent = busy ? 'Building…' : 'Build';
    button.disabled = busy || !root();
    button.classList.toggle('rg-build--busy', busy);
  });

  return (
    <div class="pdf">
      <div class="pdf__scroll scroll">
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
            {/*
             * The whole pane, not a strip under it.
             *
             * A failure here means there is nothing to preview — the document on
             * screen would be the one from before the edit that caused this — so
             * the reason belongs where the document would have been. The output
             * goes with it rather than into a separate panel: a reader who has to
             * look in two places to find out why their paper did not compile has
             * been asked to do the diagnosis themselves.
             */}
            <div class="pdf__fail">
              <div class="pdf__failhead">
                <Icon name="alert" size={26} />
                <div class="pdf__failtitle">
                  <h3>Build failed</h3>
                  <p>
                    Nothing was replaced: whatever was on screen is still the last
                    thing that actually built.
                  </p>
                </div>
                <button
                  class="btn btn--solid"
                  onClick={() => void build()}
                  disabled={building() || !root()}
                >
                  <Icon name="refresh" size={13} class={building() ? 'spin' : ''} />
                  {building() ? 'Building…' : 'Try again'}
                </button>
              </div>
              <div class="pdf__loghead">
                <span class="truncate">{editor().buildCommand() || 'build'} failed</span>
                <Show when={editor().buildState()?.error}>
                  <span class="chip chip--warn">{editor().buildState()!.error}</span>
                </Show>
              </div>
              <pre class="pdf__logbody">{editor().buildOutput() || 'No output was captured.'}</pre>
            </div>
          </Match>
          <Match when={target()}>
            <div class="pdf__host" ref={mount} />
            <Show when={loadError()}>
              <div class="pdf__empty">
                <Icon name="alert" size={26} />
                <h3>Could not render PDF</h3>
                <p>{loadError()}</p>
              </div>
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/**
 * The viewer document, once its toolbar exists.
 *
 * `el.iframe` rather than a query: the element renders into an open shadow root,
 * so the iframe is not in its light DOM and `querySelector('iframe')` on the
 * element finds nothing. The element exposes it as a property for this reason.
 *
 * Polled rather than taken from `initPromise`: the promise says the application
 * is up, not that the iframe's document has parsed, and the difference is the
 * whole question here. Bounded, so a viewer that fails to load costs a delay
 * rather than a spinner that never resolves.
 */
function toolbarDocument(viewer: PdfjsViewerElement, deadlineMs: number): Promise<Document | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = () => {
      const doc = viewer.iframe?.contentDocument;
      if (doc?.querySelector('#toolbarViewerRight')) return resolve(doc);
      if (Date.now() - started >= deadlineMs) return resolve(null);
      setTimeout(attempt, 50);
    };
    attempt();
  });
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