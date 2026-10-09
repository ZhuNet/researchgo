/**
 * Where the reader was, across a rebuild.
 *
 * pdf.js resets page, zoom and scroll the moment a document is swapped —
 * `_resetView` puts the viewer back at page one with the default scale — so
 * "rebuild and keep reading where you were" needs the position taken *before*
 * `open` and put back *after* the new pages exist.
 *
 * The position is anchored to a page, not to the document: it stores how far
 * into the current page the reader is, and restoring re-adds that offset to
 * wherever the page landed in the rebuilt document. An absolute scrollTop
 * would drift by however much the edit moved everything above it; a page
 * anchor only drifts when the edit moves the reading spot itself.
 *
 * The sidebar goes with it, because a document swap resets that too: pdf.js's
 * own reset puts the active view back to thumbnails, and a PDF's /PageMode
 * entry can open the sidebar outright. What the reader had open — outline,
 * thumbnails, or nothing — is captured as one number and put back the same
 * way.
 */

/**
 * The slice of pdf.js's `PDFViewer` this module needs.
 *
 * Deliberately structural: the viewer lives inside the element's iframe and
 * the element's own types do not expose it, so the component casts the real
 * thing to this shape. Keeping the shape here — rather than reaching for
 * `any` in the component — is what lets these functions be tested against a
 * fake and what documents exactly which properties the restore depends on.
 */
export interface PdfViewerLike {
  /** 1-based. */
  currentPageNumber: number;
  /** `'page-width'`, `'auto'`, a numeric string — or null before any document. */
  currentScaleValue: string | null;
  readonly pagesCount: number;
  readonly container: { scrollTop: number; scrollLeft: number };
  getPageView(index: number): { div: { offsetTop: number; offsetLeft: number } } | undefined;
}

/** The reading spot: a page, a zoom, and how far into that page. */
export interface ViewerPosition {
  page: number;
  scale: string | null;
  /** Distance from the page's top edge, so it survives content shifting. */
  offsetTop: number;
  offsetLeft: number;
}

/**
 * Takes the position. Safe on a viewer with no document yet: it reports page
 * one, a null scale and a zero offset, which `applyViewerPosition` turns into
 * a no-op — so the caller does not need to know whether this is a first open
 * or a rebuild.
 */
export function captureViewerPosition(viewer: PdfViewerLike): ViewerPosition {
  const page = viewer.currentPageNumber;
  const view = viewer.getPageView(page - 1);
  return {
    page,
    scale: viewer.currentScaleValue,
    offsetTop: viewer.container.scrollTop - (view?.div.offsetTop ?? 0),
    offsetLeft: viewer.container.scrollLeft - (view?.div.offsetLeft ?? 0),
  };
}

/**
 * Puts the position back, against whatever pages exist now.
 *
 * Order matters: the zoom first, because changing it reflows the pages and
 * pdf.js scrolls while doing so; then the page number, which only updates
 * state (the toolbar's counter) rather than scrolling; then the scroll
 * itself, which lands on the page's new position plus the saved offset. The
 * browser clamps an offset that runs past the end.
 *
 * A null scale is left alone: it means "no zoom was ever chosen", and writing
 * null back would ask pdf.js to set a zoom it cannot name.
 */
export function applyViewerPosition(viewer: PdfViewerLike, position: ViewerPosition): void {
  // No pages laid out yet: there is nothing to position against, and writing
  // a page number into an empty viewer would only log an error.
  if (viewer.pagesCount < 1) return;
  const page = Math.max(1, Math.min(position.page, viewer.pagesCount));
  if (position.scale !== null) viewer.currentScaleValue = position.scale;
  viewer.currentPageNumber = page;
  const view = viewer.getPageView(page - 1);
  if (!view) return;
  viewer.container.scrollTop = view.div.offsetTop + position.offsetTop;
  viewer.container.scrollLeft = view.div.offsetLeft + position.offsetLeft;
}

/**
 * pdf.js's SidebarView, mirrored so the capture and the restore can speak in
 * names rather than magic numbers. `visibleView` only ever reports NONE or a
 * real view — never UNKNOWN — so UNKNOWN appears here only for completeness.
 */
export const SIDEBAR_VIEW = {
  UNKNOWN: -1,
  NONE: 0,
  THUMBS: 1,
  OUTLINE: 2,
  ATTACHMENTS: 3,
  LAYERS: 4,
} as const;

/**
 * The sidebar, in pdf.js 6's vocabulary: the "views manager".
 *
 * Structural for the same reason as `PdfViewerLike` — the real object lives
 * inside the element's iframe and is not in the element's own types. The
 * `visibleView` getter reports the open view, or NONE when the sidebar is
 * closed, which is exactly the state a rebuild loses.
 */
export interface ViewsManagerLike {
  readonly visibleView: number;
  switchView(view: number, forceOpen?: boolean): void;
  close(): void;
}

/**
 * Takes the sidebar's state: which view is showing, or NONE when it is
 * closed. One number, because that is all pdf.js needs to put it back.
 */
export function captureSidebarView(views: ViewsManagerLike): number {
  return views.visibleView;
}

/**
 * Puts the sidebar's state back.
 *
 * `forceOpen` is the whole trick: a saved view means the sidebar was open, so
 * restoring it must open the sidebar even if the rebuild left it closed. A
 * saved NONE means it was closed, and `close` is idempotent — closing an
 * already-closed sidebar is a no-op in pdf.js.
 *
 * A document whose outline vanished between builds degrades on its own:
 * pdf.js disables the outline button when an empty outline loads and falls
 * back to thumbnails, so the sidebar stays open on the view that still
 * exists rather than showing an empty pane.
 */
export function applySidebarView(views: ViewsManagerLike, view: number): void {
  if (view === SIDEBAR_VIEW.NONE) {
    views.close();
    return;
  }
  views.switchView(view, true);
}
