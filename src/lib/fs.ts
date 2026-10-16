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
