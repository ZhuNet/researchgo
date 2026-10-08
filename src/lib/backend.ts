/**
 * Everything the UI needs from the host. Two implementations exist:
 * `tauriBackend` in the running desktop app, and a fake in tests, so the store
 * never touches `window.__TAURI__` directly.
 */

export interface DirEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
}

/**
 * One page of one directory, addressed by offset into a *stable sorted order*.
 *
 * `total` is the exact number of children the index knows about, which is what
 * lets the tree grow row by row as pages arrive instead of paying for a full
 * recursive scan up front. It is deliberately not used as the scroll height: the
 * height tracks rows that actually exist, so nothing below the reader ever moves.
 */
export interface DirPage {
  dir: string;
  offset: number;
  entries: DirEntry[];
  total: number;
  /** Of those children: files, and directories. */
  files: number;
  dirs: number;
  hasMore: boolean;
}

/**
 * Everything needed to decide *how* to show a file, obtained without reading its
 * content: the binary verdict comes from a bounded sniff and the size from one
 * `stat`, both off the UI thread.
 */
export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  binary: boolean;
  /** Whether the file is small enough to load whole and edit. */
  wholeReadable: boolean;
}

export interface ArtifactInfo {
  /** Project-relative, so it reads like a path in the tree. */
  path: string;
  /** Absolute, because the PDF engine needs something it can open directly. */
  absPath: string;
  size: number;
  builtMs: number;
}

/**
 * What Build would run for this project, without running it.
 *
 * The preview starts empty on purpose, so the empty state needs something honest
 * to say: this is the same detection the build itself uses.
 */
export interface BuildPlanInfo {
  buildable: boolean;
  command: string | null;
  reason: string | null;
  /** Project-relative path the artifact is expected at. */
  artifact: string | null;
  passes: number;
  detail: string | null;
}

export interface BuildOutcome {
  ok: boolean;
  command: string;
  code: number | null;
  output: string;
  durationMs: number;
  artifact: ArtifactInfo | null;
}

export interface OpenedFolder {
  path: string;
  name: string;
  page: DirPage;
}

export type ChangeKind = 'created' | 'removed' | 'changed' | 'renamed';

/**
 * A change on disk.
 *
 * `isDir` and `from` are filled in only where the event itself can answer them
 * without guessing: a create knows the type of what it created, and a rename
 * reports the old name when both ends share a parent. Anything else arrives as
 * `undefined` and the frontend re-reads that directory instead of patching it.
 */
export interface Change {
  dir: string;
  name: string;
  kind: ChangeKind;
  isDir?: boolean;
  from?: string;
}

/** Must match `DEFAULT_PAGE` on the Rust side. */
export const PAGE = 512;

export interface Backend {
  readonly kind: 'tauri' | 'fake';
  pickDirectory(): Promise<string | null>;
  openFolder(path: string, limit?: number): Promise<OpenedFolder>;
  listDirPage(path: string, offset: number, limit: number): Promise<DirPage>;
  pathKind(path: string): Promise<'dir' | 'file'>;
  invalidateDir(path: string): Promise<void>;
  clearDirIndex(): Promise<void>;
  readFile(path: string): Promise<string>;
  fileInfo(path: string): Promise<FileInfo>;
  buildProject(root: string): Promise<BuildOutcome>;
  buildPlan(root: string): Promise<BuildPlanInfo>;
  readArtifact(path: string): Promise<number[]>;
  writeFile(path: string, content: string): Promise<number>;
  createEntry(dir: string, name: string, kind: 'dir' | 'file'): Promise<void>;
  canWrite(path: string): Promise<boolean>;
  renameEntry(from: string, to: string): Promise<void>;
  removeEntry(path: string): Promise<void>;
  syncWatch(dirs: string[]): Promise<string[]>;
  onChange(handler: (change: Change) => void): () => void;
  /**
   * Fires when PATH changed on the host — a toolchain installed or removed
   * outside this window. The handler re-asks `buildPlan`.
   */
  onToolchainChange(handler: () => void): () => void;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (globalThis as Record<string, unknown>).__TAURI__ as
    | { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
    | undefined;
  if (!tauri) {
    return Promise.reject(new Error(`Tauri bridge unavailable (command: ${cmd})`));
  }
  return tauri.core.invoke(cmd, args) as Promise<T>;
}

/**
 * Subscribes to a backend event and hands back the unsubscribe.
 *
 * The unsubscribe has to work before `listen` has resolved: a component can tear
 * down in the same tick it subscribed in, so cancellation flips a flag the
 * resolution checks rather than only dropping a handle it may not hold yet.
 */
function listenTo<T>(event: string, handler: (payload: T) => void): () => void {
  const tauri = (globalThis as Record<string, unknown>).__TAURI__ as
    | {
        event: {
          listen: (
            e: string,
            cb: (message: { payload: T }) => void,
          ) => Promise<() => void>;
        };
      }
    | undefined;
  if (!tauri) return () => {};
  let dispose: (() => void) | undefined;
  let cancelled = false;
  void tauri.event.listen(event, (message) => {
    handler(message.payload);
  }).then((un) => {
    if (cancelled) un();
    else dispose = un;
  });
  return () => {
    cancelled = true;
    dispose?.();
  };
}

export const tauriBackend: Backend = {
  kind: 'tauri',
  pickDirectory: () => invoke<string | null>('pick_directory'),
  openFolder: (path, limit) =>
    invoke<OpenedFolder>('open_folder', { path, limit: limit ?? PAGE }),
  listDirPage: (path, offset, limit) =>
    invoke<DirPage>('list_dir_page', { path, offset, limit }),
  pathKind: (path) => invoke<'dir' | 'file'>('path_kind', { path }),
  invalidateDir: (path) => invoke<void>('invalidate_dir', { path }),
  clearDirIndex: () => invoke<void>('clear_dir_index'),
  readFile: (path) => invoke<string>('read_file', { path }),
  fileInfo: (path) => invoke<FileInfo>('file_info', { path }),
  buildProject: (root) => invoke<BuildOutcome>('build_project', { root }),
  buildPlan: (root) => invoke<BuildPlanInfo>('build_plan', { root }),
  readArtifact: (path) => invoke<number[]>('read_artifact', { path }),
  writeFile: (path, content) => invoke<number>('write_file', { path, content }),
  createEntry: (dir, name, kind) => invoke<void>('create_entry', { dir, name, kind }),
  canWrite: (path) => invoke<boolean>('can_write', { path }),
  renameEntry: (from, to) => invoke<void>('rename_entry', { from, to }),
  removeEntry: (path) => invoke<void>('remove_entry', { path }),
  syncWatch: (dirs) => invoke<string[]>('sync_watch', { dirs }),
  onChange(handler) {
    return listenTo<Change>('fs:change', handler);
  },
  onToolchainChange(handler) {
    // No payload to read: what is buildable depends on the open project's
    // documents as much as on PATH, so the event says only "look again" and the
    // frontend re-asks `buildPlan` rather than caching an answer here.
    return listenTo<null>('toolchain:change', () => handler());
  },
};

export function isDesktopHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The order the Rust index produces: directories first, then case-insensitively
 * by name, then by exact name. Patching a listing in place has to match it, or a
 * new row lands in the wrong slot until the next full read.
 */
export function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const al = a.name.toLowerCase();
  const bl = b.name.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** Insert position for an entry in a sorted listing, without a full re-sort. */
export function insertAt(sorted: readonly DirEntry[], entry: DirEntry): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareEntries(sorted[mid], entry) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}