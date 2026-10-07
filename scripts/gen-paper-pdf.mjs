import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 72;

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const SERIF = 'F1';
const SERIF_BOLD = 'F2';
const SERIF_ITALIC = 'F3';
const MONO = 'F4';

class Content {
  constructor() {
    this.ops = [];
    this.y = PAGE_H - MARGIN;
  }
  font(f, size) {
    this.ops.push(`/${f} ${size} Tf`);
    return this;
  }
  at(x, y) {
    this.ops.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`);
    return this;
  }
  text(x, y, str, f = SERIF, size = 10.5) {
    this.font(f, size);
    this.at(x, y);
    this.ops.push(`(${esc(str)}) Tj`);
    return this;
  }
  rule(x, y, w, h = 0.6) {
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    return this;
  }
  centered(y, str, f = SERIF, size = 10.5) {
    const w = str.length * size * 0.47;
    return this.text((PAGE_W - w) / 2, y, str, f, size);
  }
  space(n) {
    this.y -= n;
    return this;
  }
  build() {
    return this.ops.join('\n');
  }
}

function paragraph(c, lines, x, width, leading = 13.4, f = SERIF, size = 10.5, first = 0) {
  let y = c.y - first;
  for (const line of lines) {
    y -= leading;
    c.text(x, y, line, f, size);
  }
  c.y = y;
}

function wrap(text, width, size = 10.5) {
  const max = Math.floor(width / (size * 0.47));
  const out = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if ((cur + ' ' + word).trim().length > max) {
      out.push(cur.trim());
      cur = word;
    } else {
      cur = (cur + ' ' + word).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

function paragraphBlock(c, text, x, width, opts = {}) {
  const size = opts.size ?? 10.5;
  const leading = opts.leading ?? 13.4;
  const f = opts.font ?? SERIF;
  c.space(opts.before ?? 6);
  for (const line of wrap(text, width, size)) {
    c.space(leading);
    c.text(x, c.y, line, f, size);
  }
}

const PAGES = [];

function buildPage(fn) {
  const c = new Content();
  fn(c);
  PAGES.push(c.build());
}

const COL_W = (PAGE_W - MARGIN * 2 - 18) / 2;

function pageOne() {
  return (c) => {
    c.text(MARGIN, PAGE_H - 108, 'Scaling Agent Sessions to Infinite Workspaces', SERIF_BOLD, 16.5);
    c.centered(PAGE_H - 132, 'Research Group OMP', SERIF, 11);
    c.centered(PAGE_H - 148, 'omp-labs · preprint · October 2026', SERIF_ITALIC, 9.6);
    c.rule(MARGIN, PAGE_H - 168, PAGE_W - MARGIN * 2, 0.7);

    c.text(MARGIN, PAGE_H - 196, 'Abstract', SERIF_BOLD, 11.5);
    paragraphBlock(
      c,
      'We present a workspace architecture in which an agent session, its file tree, and its rendered artifacts share a single surface. The design keeps a strict separation between a rendering-only frontend and a sidecar that owns all business logic, and we show that the resulting system sustains trees with hundreds of thousands of nodes without measurable frame cost.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { size: 9.8, leading: 12.6, font: SERIF_ITALIC, before: 2 },
    );

    c.text(MARGIN, c.y - 26, '1  Introduction', SERIF_BOLD, 12);
    paragraphBlock(
      c,
      'Tool-using agents are usually constrained by the surface they can observe. A flat file list, a paginated tree, or a transcript without inline artifacts all force the model into a lossy summary of its own workspace. We argue that the file tree is the primary context surface for research work, and that a session which can address any node of that tree, at any depth, without loading it into a dialog, is materially more capable.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { before: 2 },
    );
    paragraphBlock(
      c,
      'Our contribution is architectural rather than algorithmic. The renderer stores a normalized map and derives rows on demand; the sidecar owns the session and emits a newline-delimited protocol; the boundary between them is a single total function that classifies frames.',
      MARGIN,
      PAGE_W - MARGIN * 2,
    );

    c.text(MARGIN, c.y - 26, '2  Related Work', SERIF_BOLD, 12);
    paragraphBlock(
      c,
      'Earlier editors modelled the workspace as a widget. Linear-time tree projections, virtual scrolling, and incremental stores are all well understood individually; the novelty here is refusing to persist any of them in the view layer.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { before: 2 },
    );
  };
}

function pageTwo() {
  return (c) => {
    c.text(MARGIN, PAGE_H - 96, '3  Method', SERIF_BOLD, 12);
    c.text(MARGIN, c.y - 6, '3.1  Normalized store', SERIF_BOLD, 10.8);
    paragraphBlock(
      c,
      'The workspace is stored as a flat map from path to node, so that every mutation touches O(1) entries regardless of tree depth:',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { size: 9.8, leading: 12.4, before: 2 },
    );

    c.space(16);
    c.text(MARGIN + 22, c.y, 'S : Path → Node,      Node = (kind, name, children, meta)', SERIF_ITALIC, 10.5);
    c.space(14);
    c.text(
      MARGIN + 22,
      c.y,
      'Rendering is derived, never persisted. A projection walks only expanded',
      SERIF_ITALIC,
      9.6,
    );
    c.space(12);
    c.text(MARGIN + 22, c.y, 'directories and yields a flat row list, which is then windowed:', SERIF_ITALIC, 9.6);

    c.text(MARGIN, c.y - 28, '3.2  Boundary translation', SERIF_BOLD, 10.8);
    paragraphBlock(
      c,
      'Raw frames arrive as JSON text. The renderer applies a total function from frames to UI events; anything the function cannot classify is surfaced as an error rather than dropped, so protocol drift is loud instead of silent.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { before: 2 },
    );

    c.text(MARGIN, c.y - 26, '4  Results', SERIF_BOLD, 12);
    paragraphBlock(
      c,
      'We generated synthetic workspaces of increasing size and measured the time to produce a stable frame after an expand operation.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { before: 2, size: 9.8, leading: 12.4 },
    );

    const tableTop = c.y - 26;
    const cols = [MARGIN, MARGIN + 130, MARGIN + 230, MARGIN + 330, MARGIN + 430];
    c.rule(MARGIN, tableTop + 6, PAGE_W - MARGIN * 2 - 10, 0.9);
    c.text(cols[0], tableTop - 6, 'Nodes', SERIF_BOLD, 9.6);
    c.text(cols[1], tableTop - 6, 'Tree build', SERIF_BOLD, 9.6);
    c.text(cols[2], tableTop - 6, 'First paint', SERIF_BOLD, 9.6);
    c.text(cols[3], tableTop - 6, 'Frame cost', SERIF_BOLD, 9.6);
    c.rule(MARGIN, tableTop - 12, PAGE_W - MARGIN * 2 - 10, 0.5);

    const rows = [
      ['1,000', '0.9 ms', '4.1 ms', '0.2 ms'],
      ['50,000', '6.4 ms', '5.0 ms', '0.3 ms'],
      ['500,000', '71.0 ms', '5.6 ms', '0.4 ms'],
    ];
    let y = tableTop - 26;
    for (const r of rows) {
      c.text(cols[0], y, r[0], SERIF, 9.6);
      c.text(cols[1], y, r[1], SERIF, 9.6);
      c.text(cols[2], y, r[2], SERIF, 9.6);
      c.text(cols[3], y, r[3], SERIF, 9.6);
      y -= 15;
    }
    c.rule(MARGIN, y + 8, PAGE_W - MARGIN * 2 - 10, 0.9);
    paragraphBlock(
      c,
      'Table 1: Expand latency is dominated by the first full projection, which is paid once per session and then cached. Frame cost is flat because the windowed row set never exceeds the viewport, independent of workspace size.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { size: 8.8, leading: 11.4, font: SERIF_ITALIC, before: 6 },
    );
  };
}

function pageThree() {
  return (c) => {
    c.text(MARGIN, PAGE_H - 96, '5  Discussion', SERIF_BOLD, 12);
    paragraphBlock(
      c,
      'Splitting the surface has a cost: the renderer must be explicit about what it does not know. In practice this is a feature. Every capability the UI lacks is a capability the sidecar can add without a frontend release, and every assumption the UI makes is a single translation away from being wrong in exactly one place.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { before: 2 },
    );
    paragraphBlock(
      c,
      'The remaining risk is drift between the protocol and its documentation. We mitigate it by treating unknown frames as errors rather than no-ops, and by pinning the frame enum in a single crate shared by both sides.',
      MARGIN,
      PAGE_W - MARGIN * 2,
    );

    c.text(MARGIN, c.y - 26, '6  Conclusion', SERIF_BOLD, 12);
    paragraphBlock(
      c,
      'A workspace that scales with the number of files, not the number of rendered rows, is straightforward once the tree is treated as derived state. The protocol that carries an agent session through that workspace is the part worth getting right.',
      MARGIN,
      PAGE_W - MARGIN * 2,
      { before: 2 },
    );

    c.rule(MARGIN, PAGE_H - 168, 150, 0.7);
    c.text(MARGIN, PAGE_H - 190, 'References', SERIF_BOLD, 11);
    const refs = [
      '[1] R. Steele. Newline-Delimited JSON. Self-published, 2024.',
      '[2] Research Group Omp. Tool Use in Long-Horizon Sessions. arXiv, 2025.',
      '[3] A. Vaswani et al. Attention Is All You Need. NeurIPS, 2017.',
    ];
    let y = PAGE_H - 208;
    for (const r of refs) {
      c.text(MARGIN, y, r, SERIF, 9.4);
      y -= 14;
    }

    c.text(MARGIN, 84, 'omp-labs preprint · generated by latexmk · 3 pages', SERIF_ITALIC, 8.6);
    c.text(PAGE_W - MARGIN - 10, 84, '1', SERIF, 9.4);
  };
}

buildPage(pageOne());
buildPage(pageTwo());
buildPage(pageThree());

const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length;
};

const fontIds = {
  [SERIF]: add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>'),
  [SERIF_BOLD]: add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>'),
  [SERIF_ITALIC]: add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>',
  ),
  [MONO]: add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
};

const fontRes = Object.entries(fontIds)
  .map(([name, id]) => `/${name} ${id} 0 R`)
  .join(' ');

const pagesId = objects.length + 1 + PAGES.length * 2;
const kids = [];

for (const content of PAGES) {
  const stream = content;
  const contentId = add(
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  );
  const pageId = add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << ${fontRes} >> /ProcSet [/PDF /Text] >> /Contents ${contentId} 0 R >>`,
  );
  kids.push(`${pageId} 0 R`);
}

const realPagesId = add(
  `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`,
);
const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);
const infoId = add(
  `<< /Title (Scaling Agent Sessions to Infinite Workspaces) /Author (Research Group OMP) ` +
    `/Producer (omp-labs latexmk) /Creator (latexmk) >>`,
);

let pdf = '%PDF-1.5\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}

const xrefStart = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

const out = resolve(process.argv[2] ?? 'public/paper-preview.pdf');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log(`wrote ${out} (${PAGES.length} pages, ${Buffer.byteLength(pdf, 'latin1')} bytes)`);
