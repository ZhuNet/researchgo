import {
  compareEntries,
  type Backend,
  type BuildOutcome,
  type BuildPlanInfo,
  type Change,
  type DirEntry,
  type DirPage,
  type OpenedFolder,
} from '../src/lib/backend';

/** In-memory filesystem so the store can be tested without Rust or a browser. */
export class FakeFs {
  dirs = new Map<string, Map<string, DirEntry>>();
  files = new Map<string, string>();
  /** 模拟无写入权限的目录，例如 /usr 或只读挂载点 */
  readOnly = new Set<string>();
  watching: string[] = [];
  changeHandlers: ((change: Change) => void)[] = [];
  failList = new Set<string>();
  /** Paths whose content is not text, so the binary path can be exercised. */
  binaryFiles = new Set<string>();
  /** Files declared larger than the editor's in-memory limit. */
  oversized = new Set<string>();
  /** Whole-file reads, so "was this read at all" can be asserted. */
  readCalls: string[] = [];
  buildResults: BuildOutcome[] = [];
  buildCalls: { root: string }[] = [];
  pdfs = new Map<string, { body: string; builtMs: number }>();
  /** What the host reports a build would run. */
  plan: BuildPlanInfo | null = null;
  planError: string | null = null;
  artifactCalls: string[] = [];
  /** When set, `build_project` rejects with this message. */
  buildThrows: string | null = null;
  listCalls: string[] = [];
  /** `dir@offset`, so paging can be asserted without changing `listCalls`. */
  pageCalls: string[] = [];
  invalidated: string[] = [];
  clearCalls = 0;

  constructor(tree: Record<string, string[]> = {}) {
    for (const [dir, children] of Object.entries(tree)) this.mkdir(dir, children);
  }

  mkdir(dir: string, children: string[] = []): void {
    const map = new Map<string, DirEntry>();
    for (const name of children) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const isDir = !name.includes('.');
      map.set(name, {
        name,
        path,
        kind: isDir ? 'dir' : 'file',
      });
      if (isDir) this.dirs.set(path, this.dirs.get(path) ?? new Map());
      else this.files.set(path, 'placeholder\n');
    }
    this.dirs.set(dir, map);
    if (dir !== '/') {
      const parent = dir.slice(0, dir.lastIndexOf('/')) || '/';
      this.dirs.get(parent)?.set(dir.slice(dir.lastIndexOf('/') + 1), {
        name: dir.slice(dir.lastIndexOf('/') + 1),
        path: dir,
        kind: 'dir',
      });
    }
  }

  /** Same order the Rust index produces, so paging agrees with the real host. */
  entriesOf(dir: string): DirEntry[] {
    return [...(this.dirs.get(dir)?.values() ?? [])].sort(compareEntries);
  }

  pageOf(dir: string, offset: number, limit: number): DirPage {
    const all = this.entriesOf(dir);
    const from = Math.min(offset, all.length);
    const to = Math.min(from + limit, all.length);
    return {
      dir,
      offset: from,
      entries: all.slice(from, to),
      total: all.length,
      files: all.filter((e) => e.kind === 'file').length,
      dirs: all.filter((e) => e.kind === 'dir').length,
      hasMore: to < all.length,
    };
  }

  emit(change: Change): void {
    for (const handler of this.changeHandlers) handler(change);
  }

  addEntry(dir: string, name: string, kind: 'dir' | 'file'): string {
    const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
    this.dirs.get(dir)?.set(name, { name, path, kind });
    if (kind === 'dir') this.dirs.set(path, new Map());
    else this.files.set(path, 'new file\n');
    return path;
  }

  removeEntry(path: string): void {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    const name = path.slice(path.lastIndexOf('/') + 1);
    this.dirs.get(dir)?.delete(name);
    this.files.delete(path);
    this.dirs.delete(path);
  }

  rename(from: string, to: string): void {
    const fromDir = from.slice(0, from.lastIndexOf('/')) || '/';
    const toDir = to.slice(0, to.lastIndexOf('/')) || '/';
    const name = to.slice(to.lastIndexOf('/') + 1);
    const entry = this.dirs.get(fromDir)?.get(from.slice(from.lastIndexOf('/') + 1));
    if (!entry) return;
    this.dirs.get(fromDir)?.delete(from.slice(from.lastIndexOf('/') + 1));
    this.dirs.get(toDir)?.set(name, { ...entry, name, path: to });
    if (entry.kind === 'dir') {
      const children = this.dirs.get(from);
      this.dirs.delete(from);
      if (children) this.dirs.set(to, children);
    } else {
      const text = this.files.get(from) ?? '';
      this.files.delete(from);
      this.files.set(to, text);
    }
  }
}

export function fakeBackend(fs: FakeFs, picked: string | null = '/'): Backend {
  return {
    kind: 'fake',
    async pickDirectory() {
      return picked;
    },
    async openFolder(path: string, limit = 512): Promise<OpenedFolder> {
      if (!fs.dirs.has(path)) throw new Error(`no such folder: ${path}`);
      return {
        path,
        name: path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1),
        page: fs.pageOf(path, 0, limit),
      };
    },
    async listDirPage(path: string, offset: number, limit: number): Promise<DirPage> {
      fs.listCalls.push(path);
      fs.pageCalls.push(`${path}@${offset}`);
      if (fs.failList.has(path)) throw new Error(`list_dir_page failed for ${path}`);
      return fs.pageOf(path, offset, limit);
    },
    async pathKind(path: string) {
      if (fs.dirs.has(path)) return 'dir' as const;
      if (fs.files.has(path)) return 'file' as const;
      throw new Error(`no such path: ${path}`);
    },
    async invalidateDir(path: string) {
      fs.invalidated.push(path);
    },
    async clearDirIndex() {
      fs.clearCalls += 1;
    },
    async readFile(path: string) {
      fs.readCalls.push(path);
      if (fs.failList.has(path)) throw new Error(`read failed: ${path}`);
      // An oversized file is deliberately not readable whole: the store must not
      // try, and a test that expects the whole text to come back is testing the
      // wrong contract.
      if (fs.oversized.has(path)) {
        throw new Error(`file too large: ${path}`);
      }
      return fs.files.get(path) ?? '';
    },
    async fileInfo(path: string) {
      if (fs.failList.has(path)) throw new Error(`stat failed: ${path}`);
      const body = fs.files.get(path) ?? '';
      const binary = fs.binaryFiles.has(path);
      // The in-memory limit is 64 MiB; 4 GiB is past it by a wide margin.
      const size = fs.oversized.has(path) ? 4 * 1024 * 1024 * 1024 : body.length;
      return {
        path,
        size,
        mtimeMs: 1,
        binary,
        wholeReadable: !binary && !fs.oversized.has(path),
      };
    },
    async buildProject(root: string) {
      fs.buildCalls.push({ root });
      if (fs.buildThrows) throw new Error(fs.buildThrows);
      const next = fs.buildResults.shift();
      if (!next) {
        return { ok: true, command: 'xelatex', code: 0, output: '', durationMs: 5, artifact: null };
      }
      return next;
    },
    async readArtifact(path: string) {
      fs.artifactCalls.push(path);
      const body = fs.pdfs.get(path)?.body ?? fs.files.get(path);
      if (body === undefined) throw new Error(`no artifact: ${path}`);
      return [...new TextEncoder().encode(body)];
    },
    async buildPlan(root: string) {
      if (fs.planError) throw new Error(fs.planError);
      return (
        fs.plan ?? {
          buildable: true,
          command: 'xelatex -interaction=nonstopmode main.tex  (2 passes)',
          reason: 'XeLaTeX',
          artifact: '/.rg/build/main.pdf',
          passes: 2,
          detail: null,
        }
      );
    },
    async writeFile(path: string, content: string) {
      fs.files.set(path, content);
      return content.length;
    },
    async canWrite(path) {
      return !fs.readOnly.has(path);
    },

    async createEntry(dir, name, kind) {
      if (fs.readOnly.has(dir)) {
        throw new Error(`Permission denied (${dir})`);
      }
      fs.addEntry(dir, name, kind);
    },
    async renameEntry(from, to) {
      fs.rename(from, to);
    },
    async removeEntry(path) {
      fs.removeEntry(path);
    },
    async syncWatch(dirs) {
      fs.watching = dirs;
      return dirs;
    },
    onChange(handler) {
      fs.changeHandlers.push(handler);
      return () => {
        fs.changeHandlers = fs.changeHandlers.filter((h) => h !== handler);
      };
    },
  };
}

export const SAMPLE_TREE: Record<string, string[]> = {
  '/': ['src', 'docs', 'README.md'],
  '/src': ['main.rs', 'lib.rs', 'util'],
  '/src/util': ['helper.rs'],
  '/docs': ['guide.md'],
};