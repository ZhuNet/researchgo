/**
 * Puts pdf.js's own runtime resources where the viewer can fetch them.
 *
 * The element loads `pdf.mjs` and the worker out of its own `dist/` folder, but
 * it ships none of the auxiliary data directories, so they are served from here.
 *
 * A CID font without a ToUnicode table — which is what XeLaTeX produces for CJK —
 * can only be mapped to glyphs through the predefined CMaps that ship beside
 * pdf.js. Without them the engine reports `translateFont failed` and the CJK text
 * in the preview renders as garbage while Latin text, which carries ToUnicode,
 * keeps working. `standard_fonts` covers the standard 14 for the same reason.
 *
 * `wasm` and `iccs` are for pdf.js 5 and later: JPEG2000 images and colour
 * management moved from hand-written decoders into WebAssembly, and the ICC
 * profiles they need ship alongside. Missing them does not break an ordinary
 * LaTeX PDF, it breaks only the documents that happen to use those features —
 * which is the harder kind of bug to recognise later.
 *
 * `public/` is the one directory Vite copies verbatim into the bundle, so the
 * files end up at a stable URL in dev and in the packaged app alike.
 */
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/pdfjs-dist');
const into = resolve(root, 'public/pdfjs');

if (!statSync(from, { throwIfNoEntry: false })) {
  console.error('pdfjs-dist is not installed; run npm install first');
  process.exit(1);
}

mkdirSync(into, { recursive: true });
// `wasm` and `iccs` only exist from pdf.js 5 on; a resolution that predates them
// is still a working install for everything else, so they are not fatal here.
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const source = resolve(from, dir);
  if (!existsSync(source)) {
    console.warn(`pdfjs-dist has no ${dir}/, skipping`);
    continue;
  }
  cpSync(source, resolve(into, dir), { recursive: true, force: true });
}

/*
 * The annotation icons are the one thing no bundler can emit: the viewer builds
 * the name at runtime as `imageResourcesPath + 'annotation-' + name + '.svg'`, so
 * there is no literal to discover. Without them the annotation toolbar's buttons
 * render as blank squares — which is the kind of breakage that reads as "this
 * viewer looks half-finished" rather than as a missing asset.
 */
const images = resolve(root, 'node_modules/pdfjs-viewer-element/dist/images');
if (existsSync(images)) {
  cpSync(images, resolve(into, 'images'), { recursive: true, force: true });
} else {
  console.warn('pdfjs-viewer-element has no dist/images/, annotation icons will be blank');
}

console.log(`pdf.js assets ready in ${into}`);