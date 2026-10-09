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
import type { PdfViewerApplication } from 'pdfjs-viewer-element';

import { Icon } from '../Icon';
import {
  applySidebarView,
  applyViewerPosition,
  captureSidebarView,
  captureViewerPosition,
  type PdfViewerLike,
  type ViewsManagerLike,
} from '../../lib/pdfposition';
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

    // Injected rather than styled from here: the button lives in the viewer's own
    // document, and pdf.js 6 drives its palette through custom properties on that
    // document's root. Reading `--main-color` instead of picking a colour is what
    // keeps the button in step with whichever theme is active, with no second
    // palette to maintain here.
    //
    // No background, deliberately. It is a text action sitting among icon
    // buttons, and the chrome that makes a button look like a button is what made
    // it read as a foreign object pasted onto the toolbar.
    void el.injectViewerStyles?.(`
      #toolbarViewerRight .rg-build {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        height: 100%;
        flex: none;
        padding: 0 6px;
        background: none;
        border: 0;
        border-radius: 2px;
        color: var(--main-color);
        font: message-box;
        font-size: 11px;
        cursor: pointer;
      }
      #toolbarViewerRight .rg-build:hover:not(:disabled) {
        filter: var(--hover-filter);
      }
      #toolbarViewerRight .rg-build:disabled {
        opacity: 0.45;
        cursor: default;
      }
      #toolbarViewerRight .rg-build svg {
        width: 14px;
        height: 14px;
      }

      /*
       * The scrollbar is the one part of the viewer the browser draws, so it
       * arrives as a light-mode system scrollbar in a dark pane. light-dark()
       * follows the \`color-scheme\` the viewer sets on its own root when the
       * theme changes, so one rule covers both themes and keeps following them.
       */
      #viewerContainer {
        scrollbar-width: thin;
        scrollbar-color: light-dark(rgba(9, 10, 20, 0.3), rgba(255, 255, 255, 0.26)) transparent;
      }
      #viewerContainer::-webkit-scrollbar {
        width: 12px;
        height: 12px;
      }
      #viewerContainer::-webkit-scrollbar-track {
        background: transparent;
      }
      #viewerContainer::-webkit-scrollbar-thumb {
        background: light-dark(rgba(9, 10, 20, 0.26), rgba(255, 255, 255, 0.22));
        background-clip: content-box;
        border: 3px solid transparent;
        border-radius: 6px;
      }
      #viewerContainer::-webkit-scrollbar-thumb:hover {
        background: light-dark(rgba(9, 10, 20, 0.42), rgba(255, 255, 255, 0.34));
        background-clip: content-box;
      }

      /* The canvas behind the pages, matched to the app's own page colour. */
      #viewerContainer,
      #outerContainer {
        background-color: light-dark(#f4f5f7, #07080a);
      }

      /*
       * Suspends the sidebar's slide animation while the reader's state is
       * put back after a rebuild. A preset zoom ("page-width", "auto") is
       * computed from the container's width, and the container's width
       * depends on whether the sidebar is open — so the restore must see the
       * sidebar's final position, not a width animating toward it. Canceling
       * a running transition this way snaps the layout to where the
       * animation would have ended, and removing the class afterwards cannot
       * jump anything, because the layout is already there.
       */
      :root.rg-restoring #viewerContainer,
      :root.rg-restoring #viewsManager,
      :root.rg-restoring #sidebarContainer,
      :root.rg-restoring #toolbarContainer {
        transition: none !important;
      }
    `);

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
   *
   * The artifact signal is the refresh trigger, and it is read whole rather
   * than reduced to a path: every successful build sets a *fresh* ArtifactInfo
   * object, so this effect re-runs on each one and re-reads the bytes
   * unconditionally — a rebuild whose output is byte-identical still reopens,
   * because "the build succeeded" is the only evidence the preview needs.
   * Reducing the signal to its path is exactly how the preview ended up
   * showing a document older than the sources it claims to reflect: the path
   * is the same on every rebuild, so nothing ever re-ran.
   *
   * pdf.js resets page, zoom, scroll and the sidebar when a document is
   * swapped, so the reading position and the sidebar's view are taken before
   * `open` and put back once the new pages exist — a rebuild that shifts the
   * content still lands the reader on the same spot on the same page, with
   * the sidebar open where it was, not back at the top of page one. The
   * sidebar is put back before the zoom, because a preset zoom is computed
   * from the container's width and the container's width depends on the
   * sidebar — restoring them the other way round computes the zoom against
   * the wrong width.
   */
  createEffect(() => {
    const el = viewer();
    const abs = editor().artifact()?.absPath;
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
        const pv = pdfViewerOf(viewerApp);
        const vm = viewsManagerOf(viewerApp);
        // Before the swap: after it, the old document's positions are gone.
        const position = pv ? captureViewerPosition(pv) : null;
        const sidebar = vm ? captureSidebarView(vm) : null;
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
        if (!alive) return;
        if (pv && position) {
          try {
            // Two gates before the reader's state goes back. The pages must
            // exist for the position to anchor to, and the app's own initial
            // view must have run — a PDF with /PageMode opens the sidebar on
            // its own, and restoring before that would only be overridden.
            await Promise.all([afterDocumentInit(viewerApp, 2_000), pv.pagesPromise]);
            if (!alive) return;
            // The sidebar goes back first, with its slide animation
            // suspended: a preset zoom ("page-width", "auto") is computed
            // from the container's width, and the container's width depends
            // on whether the sidebar is open — so the zoom must be computed
            // against the sidebar's final position, not against a width
            // still animating toward it or away from it. One microtask lets
            // `open` land the class change it queues; with the animation
            // off, the layout is final the moment it lands.
            const doc = el.iframe?.contentDocument;
            doc?.documentElement.classList.add('rg-restoring');
            try {
              if (vm && sidebar !== null) applySidebarView(vm, sidebar);
              await null;
              if (!alive) return;
              applyViewerPosition(pv, position);
            } finally {
              doc?.documentElement.classList.remove('rg-restoring');
            }
          } catch {
            // The document is open and correct; the position and the sidebar
            // are best-effort and must never be reported as a rendering
            // failure.
          }
        }
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
        button.className = 'rg-build';
        button.title = 'Compile the project and show the result here';
        // The app's own lightning bolt, drawn rather than imported: this is
        // another document, and an icon that does not match the one on the empty
        // state's button would be two Rebuild buttons that look like two actions.
        button.innerHTML = ZAP_ICON;
        const label = doc.createElement('span');
        label.textContent = 'Rebuild';
        button.appendChild(label);
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
   * The button's own disabled state.
   *
   * The label does not change: pdf.js's toolbar is dense and a button that grows
   * and shrinks its own text reflows everything to its left. The spinner in the
   * app's own button covers the same ground.
   *
   * The button lives in another document, so Solid does not own it; this is what
   * keeps it honest after the injection effect has run once.
   */
  createEffect(() => {
    const button = buildButton();
    const busy = building();
    if (!button) return;
    button.disabled = busy || !root();
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
          <Match when={editor().artifact()}>
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
 * The app's lightning bolt, for the viewer's toolbar.
 *
 * Copied rather than imported because it has to end up inside another document,
 * where the app's `Icon` component cannot reach. The stroke attributes are the
 * ones `Icon` renders with, so the two match exactly.
 */
const ZAP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M13.5 2.5 5 13.5h6l-.5 8 8.5-11h-6z"/></svg>';

/**
 * The viewer application as this component uses it.
 *
 * pdfjs-viewer-element's types stop at `open` and `eventBus`, but the object
 * it hands over is pdf.js's own application, which carries the `pdfViewer`
 * and the `viewsManager` (pdf.js 6's sidebar) that the restore needs. The
 * cast is confined to this shape — the same structural contracts
 * `pdfposition` is tested against, plus the promise that says when the new
 * pages exist.
 */
interface ViewerApp extends PdfViewerApplication {
  pdfViewer?: PdfViewerLike & { pagesPromise: Promise<void> | null };
  viewsManager?: ViewsManagerLike;
}

/** The pdf.js viewer inside the application, or undefined if not there yet. */
function pdfViewerOf(app: PdfViewerApplication | undefined): ViewerApp['pdfViewer'] {
  return (app as ViewerApp | undefined)?.pdfViewer;
}

/** The sidebar inside the application, or undefined if not there yet. */
function viewsManagerOf(app: PdfViewerApplication | undefined): ViewerApp['viewsManager'] {
  return (app as ViewerApp | undefined)?.viewsManager;
}

/**
 * Resolves once the app has applied its own initial view for the document it
 * just loaded — or once the deadline passes, because a viewer that never
 * gets there should not keep the restore waiting on it.
 *
 * `open` resolving only means the document is loaded; the app then applies a
 * "setInitialView" of its own once the first page is ready, and that view can
 * move the reader — a PDF's /PageMode opens the sidebar, a default zoom is
 * set. The "documentinit" event is dispatched immediately after it, so
 * waiting for it is waiting for the app to be done before the reader's own
 * state is put back over it.
 */
function afterDocumentInit(app: PdfViewerApplication | undefined, deadlineMs: number): Promise<void> {
  const bus = app?.eventBus;
  if (!bus) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bus.off('documentinit', listener);
      resolve();
    };
    const listener = () => settle();
    const timer = setTimeout(settle, deadlineMs);
    bus.on('documentinit', listener);
  });
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