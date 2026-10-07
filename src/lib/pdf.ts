export interface PdfPageMeta {
  width: number;
  height: number;
}

export interface PdfHandle {
  numPages: number;
  size: (n: number) => Promise<PdfPageMeta>;
  paint: (
    n: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
    cssHeight: number,
  ) => Promise<void>;
  destroy: () => void;
}

let engine: Promise<typeof import('pdfjs-dist')> | null = null;

function pdfjs() {
  if (!engine) {
    engine = (async () => {
      const lib = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    })();
  }
  return engine;
}

/**
 * Opens a PDF from bytes rather than a URL.
 *
 * A webview cannot fetch a filesystem path, so the document comes over the same
 * IPC channel as everything else in this app. Bytes rather than a blob URL keeps
 * the engine's own range requests out of the picture, which matters: it would
 * otherwise re-request the whole document for every range it wants.
 *
 * `cMapUrl` is what makes Chinese readable. XeLaTeX writes CJK text as an
 * Adobe-GB1 CID font with no ToUnicode table, so the only way from character
 * code to glyph is the predefined CMap that ships with pdf.js; without these
 * paths the engine gives up with `translateFont failed` and the CJK on the page
 * turns to noise while the Latin text, which does carry ToUnicode, renders
 * fine. `standardFontDataUrl` covers the standard 14 fonts for the same reason.
 */
export async function openPdf(data: Uint8Array): Promise<PdfHandle> {
  const lib = await pdfjs();
  const base = import.meta.env.BASE_URL;
  const doc = await lib.getDocument({
    data,
    isEvalSupported: false,
    cMapUrl: `${base}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}pdfjs/standard_fonts/`,
  }).promise;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

  return {
    numPages: doc.numPages,
    async size(n: number) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    },
    async paint(n, canvas, cssWidth, cssHeight) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const scale = Math.min(cssWidth / vp.width, cssHeight / vp.height) * dpr;
      const out = page.getViewport({ scale });
      canvas.width = Math.floor(out.width);
      canvas.height = Math.floor(out.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: out }).promise;
    },
    destroy() {
      void doc.destroy();
    },
  };
}
