export type NodeKind = 'dir' | 'file';
export type GitStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'conflict' | null;

export interface FsNode {
  kind: NodeKind;
  name: string;
  parent: string | null;
  children: string[];
  size: number;
  lang: string;
  status: GitStatus;
  content?: string;
  synthetic?: boolean;
}

export type FsMap = Record<string, FsNode>;

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  rs: 'rust',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  svg: 'xml',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'mdx',
  tex: 'latex',
  sty: 'latex',
  bib: 'bibtex',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  sh: 'bash',
  zsh: 'bash',
  bash: 'bash',
  sql: 'sql',
  pdf: 'pdf',
  txt: 'text',
  lock: 'text',
  env: 'dotenv',
  gitignore: 'text',
  dockerfile: 'docker',
  makefile: 'text',
};

const NAME_LANG: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'text',
  cargo: 'toml',
  'cargo.lock': 'text',
};

export function langOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text';
  return LANG_BY_EXT[name.slice(dot + 1)] ?? 'text';
}

export const ICON_BY_LANG: Record<string, string> = {
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  jsx: 'jsx',
  rust: 'rs',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  xml: 'xml',
  yaml: 'yaml',
  toml: 'toml',
  markdown: 'md',
  latex: 'tex',
  bibtex: 'bib',
  python: 'py',
  bash: 'sh',
  docker: 'docker',
  text: 'txt',
  dotenv: 'env',
  sql: 'sql',
  go: 'go',
  pdf: 'pdf',
};

export function fileIconLang(path: string): string {
  return ICON_BY_LANG[langOf(path)] ?? 'txt';
}

/**
 * A geometric glyph per file kind, keyed like `LANG_COLOR`.
 *
 * The two-letter labels these replace were text: they sat on the baseline
 * inside a line box that centers by font metrics, not by ink, and read a
 * pixel off next to the geometric icons. SVG glyphs have no baseline, so
 * they center exactly.
 */
export const GLYPH_BY_LANG: Record<string, string> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  rs: 'code',
  py: 'code',
  go: 'code',
  sql: 'code',
  sh: 'terminal',
  json: 'hash',
  yaml: 'hash',
  toml: 'hash',
  env: 'hash',
  xml: 'hash',
  css: 'layers',
  scss: 'layers',
  html: 'globe',
  md: 'fileText',
  txt: 'fileText',
  tex: 'fileText',
  bib: 'fileText',
  pdf: 'book',
  docker: 'cpu',
};

export function fileGlyphOf(path: string): string {
  return GLYPH_BY_LANG[fileIconLang(path)] ?? 'file';
}

export function isDir(path: string, map: FsMap): boolean {
  return map[path]?.kind === 'dir';
}

export function childPaths(map: FsMap, dir: string): string[] {
  const node = map[dir];
  if (!node || node.kind !== 'dir') return [];
  return node.children;
}

export function makeNode(
  path: string,
  kind: NodeKind,
  extra: Partial<FsNode> = {},
): FsNode {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const slash = path.lastIndexOf('/');
  return {
    kind,
    name,
    parent: slash <= 0 ? (kind === 'dir' && path === '/' ? null : '/') : path.slice(0, slash),
    children: [],
    size: 0,
    lang: kind === 'dir' ? 'dir' : langOf(path),
    status: null,
    ...extra,
  };
}

export function collect(map: FsMap, root: string, out: string[] = []): string[] {
  for (const p of childPaths(map, root)) {
    out.push(p);
    const n = map[p];
    if (n && n.kind === 'dir') collect(map, p, out);
  }
  return out;
}

export function countFiles(map: FsMap, root = '/'): number {
  let n = 0;
  const stack = [...childPaths(map, root)];
  while (stack.length) {
    const p = stack.pop()!;
    const node = map[p];
    if (!node) continue;
    if (node.kind === 'file') n++;
    else stack.push(...childPaths(map, p));
  }
  return n;
}

export function findFreeName(map: FsMap, dir: string, base: string): string {
  const taken = (n: string) => Boolean(map[dir === '/' ? `/${n}` : `${dir}/${n}`]);
  if (!taken(base)) return base;
  const dot = base.lastIndexOf('.');
  const head = dot > 0 ? base.slice(0, dot) : base;
  const tail = dot > 0 ? base.slice(dot) : '';
  for (let i = 2; i < 100000; i++) {
    const cand = `${head} ${i}${tail}`;
    if (!taken(cand)) return cand;
  }
  return `${head} ${Date.now()}${tail}`;
}
