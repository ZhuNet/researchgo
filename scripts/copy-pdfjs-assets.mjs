/**
 * Puts pdf.js's own font resources where the preview can fetch them.
 *
 * A CID font without a ToUnicode table — which is what XeLaTeX produces for CJK —
 * can only be mapped to glyphs through the predefined CMaps that ship beside
 * pdf.js. Without them the engine reports `translateFont failed` and the CJK text
 * in the preview renders as garbage while Latin text, which carries ToUnicode,
 * keeps working.
 *
 * `public/` is the one directory Vite copies verbatim into the bundle, so the
 * files end up at a stable URL in dev and in the packaged app alike.
 */
import { cpSync, mkdirSync, statSync } from 'node:fs';
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
for (const dir of ['cmaps', 'standard_fonts']) {
  cpSync(resolve(from, dir), resolve(into, dir), { recursive: true, force: true });
}
console.log(`pdf.js assets ready in ${into}`);