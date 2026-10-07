import { batch, createEffect, createMemo, createSignal } from 'solid-js';

import {
  PAGE,
  tauriBackend,
  type Backend,
  type Change,
  type DirEntry,
} from '../lib/backend';
import {
  DirCache,
  DEFAULT_LIMITS,
  type DirCacheOptions,
  type DirListing,
} from '../lib/dircache';
import { createEditor, type EditorLimits } from './editor';
import { toast } from './ui';
import {
  ancestorsOf,
  basenameOf,
  joinPath,
  parentOf,
  RowIndex,
  type DirView,
  type Row,
} from '../lib/rowindex';

export type StageMode = 'code' | 'pdf' | 'split';

const ls = typeof localStorage !== 'undefined' ? localStorage : null;
/** Re-reading a stale listing never walks more than this many pages at once. */
const RELOAD_PAGES = 64;
/** Disk events are coalesced for this long before anything is re-read. */
const RECONCILE_DELAY_MS = 120;
/** A watcher event for a write we just made is ignored for this long. */
const SELF_WRITE_MS = 400;

interface Session {
  root: string | null;
  tabs: string[];
  active: string | null;
  stageMode: StageMode;
  expanded: string[];
}

function loadSession(): Partial<Session> {
  const raw = ls?.getItem('rg.session');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Session> = {};
    if (typeof parsed.root === 'string' || parsed.root === null) out.root = parsed.root as string | null;
    if (Array.isArray(parsed.tabs) && parsed.tabs.every((t) => typeof t === 'string')) {
      out.tabs = parsed.tabs as string[];
    }
    if (parsed.active === null || typeof parsed.active === 'string') {
      out.active = parsed.active as string | null;
    }
    if (parsed.stageMode === 'code' || parsed.stageMode === 'pdf' || parsed.stageMode === 'split') {
      out.stageMode = parsed.stageMode;
    }
    if (Array.isArray(parsed.expanded) && parsed.expanded.every((e) => typeof e === 'string')) {
      out.expanded = parsed.expanded as string[];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * `limits` exists so the eviction behaviour can be exercised against a small
 * ceiling; production always takes the defaults.
 */
export function createWorkspace(
  backend: Backend = tauriBackend,
  limits: Partial<DirCacheOptions> = {},
  editorLimits: Partial<EditorLimits> = {},
) {
  const cache = new DirCache({ ...DEFAULT_LIMITS, ...limits });
  const editor = createEditor(backend, editorLimits);
  const rowCache = new Map<string, Row>();
  const moreCache = new Map<string, Row>();
  const loading = new Map<string, Promise<void>>();
  const restored = loadSession();

  const [root, setRoot] = createSignal<string | null>(restored.root ?? null);
  const [rootName, setRootName] = createSignal<string>('');
  const [expanded, setExpandedRaw] = createSignal<ReadonlySet<string>>(
    new Set(restored.expanded ?? []),
  );
  const [tabs, setTabs] = createSignal<string[]>(restored.tabs ?? []);
  const [active, setActive] = createSignal<string | null>(restored.active ?? null);
  const [stageMode, setStageModeRaw] = createSignal<StageMode>(restored.stageMode ?? 'code');
  const [selected, setSelected] = createSignal<string[]>([]);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal<{ dir: string; kind: 'file' | 'dir' } | null>(null);
  const [dirty, setDirty] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [version, setVersion] = createSignal(0);
  const [fileCount, setFileCount] = createSignal<number | null>(null);
  const [countTruncated, setCountTruncated] = createSignal(false);
  const [busyDirs, setBusyDirs] = createSignal<ReadonlySet<string>>(new Set());
  /**
   * Directories on screen whose entries are not resident, and those whose load
   * failed outright. The UI reads these instead of a flag on a recycled row
   * object: a plain field on a shared row is invisible to Solid, and the symptom
   * was a directory that had already loaded still saying "loading…" forever.
   */
  const [missing, setMissing] = createSignal<ReadonlySet<string>>(new Set());
  const [unreadable, setUnreadable] = createSignal<ReadonlySet<string>>(new Set());
  /** On-screen directories whose next page is reachable, i.e. what to extend. */
  const [pageable, setPageable] = createSignal<ReadonlySet<string>>(new Set());
  /**
   * Authoritative failure list, kept out of the signals on purpose: the window
   * pass publishes these sets, and a pass that both read and wrote one of them
   * would depend on its own output. Plain fields also mean the comparison below
   * needs no signal read at all.
   */
  const failedDirs = new Map<string, string>();
  /** Last window the tree handed us, so a failure can republish without a scan. */
  let windowRange = { start: 0, end: 0 };
  let publishedMissing = '';
  let publishedFailed = '';
  let publishedMore = '';

  const bump = () => setVersion((v) => v + 1);

  /**
   * The file on screen and anything unsaved are kept out of content eviction.
   *
   * Driven by an effect rather than by each call site that changes the active tab
   * or marks a buffer dirty: a missed call here does not fail loudly, it leaves a
   * buffer pinned forever, or drops an edit the next time a large file lands.
   */
  createEffect(() => {
    editor.syncPins(active(), dirty());
  });

  const viewOf = (dir: string): DirView | undefined => {
    const listing = cache.listing(dir);
    if (!listing) return undefined;
    return { entries: listing.entries, total: listing.total, complete: listing.complete };
  };

  const index = createMemo(() => {
    const base = root();
    if (!base) return null;
    version();
    expanded();
    return new RowIndex(base, expanded(), viewOf, rowCache, moreCache);
  });

  const rowCount = createMemo(() => index()?.length ?? 0);

  function sliceRows(start: number, end: number): Row[] {
    return index()?.slice(start, end) ?? [];
  }

  function rowAt(i: number): Row | undefined {
    return index()?.rowAt(i);
  }

  function indexOf(path: string): number {
    return index()?.indexOf(path) ?? -1;
  }

  /**
   * Directories that must not be evicted: the rows on screen, the root, and the
   * ancestors of the file being read. Everything else is fair game in insertion
   * order, expanded or not — that is what makes the ceiling a ceiling.
   */
  function protectedDirs(start: number, end: number): Set<string> {
    const base = root();
    const idx = index();
    const keep = new Set<string>();
    if (!base || !idx) return keep;
    for (let i = start; i < end; i++) {
      const row = idx.rowAt(i);
      if (!row) continue;
      if (row.more) {
        keep.add(row.path);
        continue;
      }
      const parent = parentOf(row.path, base);
      if (parent) keep.add(parent);
      if (row.kind === 'dir') keep.add(row.path);
    }
    keep.add(base);
    const activePath = active();
    if (activePath) {
      for (const ancestor of ancestorsOf(activePath, base)) keep.add(ancestor);
    }
    return keep;
  }

  function protectWindow(start: number, end: number): void {
    cache.protect(protectedDirs(start, end));
    // Recomputed here, from rows this call has just re-read, so what the UI shows
    // is never a frame behind what the store knows.
    const gaps: string[] = [];
    const failed: string[] = [];
    const more: string[] = [];
    const idx = index();
    const base = root();
    windowRange = { start, end };
    if (idx && base) {
      for (let i = start; i < end; i++) {
        const row = idx.rowAt(i);
        if (!row) continue;
        if (row.more) {
          more.push(row.path);
          continue;
        }
        if (row.kind !== 'dir' || !row.expanded) continue;
        if (failedDirs.has(row.path)) failed.push(row.path);
        else if (!cache.has(row.path)) gaps.push(row.path);
      }
    }
    publishWindowState(gaps, failed, more);
  }

  /** Republishes only what actually changed: an identical set must not wake rows. */
  function publishWindowState(gaps: string[], failed: string[], more: string[]): void {
    const gapKey = gaps.join('\u0000');
    if (gapKey !== publishedMissing) {
      publishedMissing = gapKey;
      setMissing(new Set(gaps));
    }
    const failedKey = failed.join('\u0000');
    if (failedKey !== publishedFailed) {
      publishedFailed = failedKey;
      setUnreadable(new Set(failed));
    }
    const moreKey = more.join('\u0000');
    if (moreKey !== publishedMore) {
      publishedMore = moreKey;
      setPageable(new Set(more));
    }
  }

  function forgetUnreadable(dir: string): void {
    if (failedDirs.delete(dir)) republishFailed();
  }

  /**
   * Records why a directory could not be listed, and says it out loud exactly
   * once. The reason matters: a bare "cannot read" hides the three very different
   * causes — the host command missing because the binary is older than the
   * frontend, a permission problem, or a path that is not a directory any more —
   * and guessing between them is how this gets misdiagnosed twice.
   */
  function markUnreadable(dir: string, reason: string, quiet = false): void {
    if (failedDirs.has(dir)) return;
    failedDirs.set(dir, reason);
    console.warn(`[tree] cannot list ${dir}: ${reason}`);
    if (!quiet) toast('error', 'Cannot read directory', `${dir} — ${reason}`);
    republishFailed();
  }

  function reasonOf(dir: string): string | undefined {
    return failedDirs.get(dir);
  }

  /**
   * A failure has to reach the reader immediately, not on the next window pass:
   * the row is on screen right now and must stop claiming to be loading.
   */
  function republishFailed(): void {
    const visible: string[] = [];
    const idx = index();
    if (idx) {
      const { start, end } = windowRange;
      for (let i = start; i < end; i++) {
        const row = idx.rowAt(i);
        if (row && row.kind === 'dir' && failedDirs.has(row.path)) visible.push(row.path);
      }
    }
    publishedFailed = visible.join('\u0000');
    setUnreadable(new Set(visible));
  }

  /**
   * Files known to be in the directories we have listed. Nothing walks the tree to
   * produce it: it is a sum over resident listings, so opening a folder costs no
   * recursive scan and a directory with a million children does not turn into a
   * million iterations per keystroke.
   */
  function recount(): void {
    let files = 0;
    let truncated = false;
    for (const listing of cache.resident()) {
      files += listing.files;
      if (!listing.complete) truncated = true;
    }
    setFileCount(files);
    setCountTruncated(truncated);
  }

  /**
   * Cached per directory: the context menu needs it on every open, and the answer
   * only changes when the folder is remounted or its permissions change.
   */
  const writeAccess = new Map<string, boolean>();

  async function canWrite(dir: string): Promise<boolean> {
    const hit = writeAccess.get(dir);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      ok = await backend.canWrite(dir);
    } catch {
      ok = false;
    }
    writeAccess.set(dir, ok);
    return ok;
  }

  function forgetWriteAccess(dir: string): void {
    writeAccess.delete(dir);
  }

  /** Resident entries — the prefix of the listing that is currently in memory. */
  function entriesOf(dir: string): DirEntry[] {
    return cache.get(dir) ?? [];
  }

  function listingOf(dir: string): DirListing | undefined {
    return cache.listing(dir);
  }

  function entryOf(path: string): DirEntry | undefined {
    const base = root();
    if (!base) return undefined;
    if (path === base) return undefined;
    const parent = parentOf(path, base);
    if (!parent) return undefined;
    return cache.get(parent)?.find((e) => e.path === path);
  }

  function exists(path: string): boolean {
    return entryOf(path) !== undefined;
  }

  function isDir(path: string): boolean {
    return entryOf(path)?.kind === 'dir';
  }

  function trackBusy<T>(dir: string, work: () => Promise<T>): Promise<T> {
    setBusyDirs((prev) => new Set(prev).add(dir));
    return work().finally(() => {
      setBusyDirs((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    });
  }

  /** Page 0 of a directory. One request per directory, ever, unless it goes stale. */
  function loadPage0(dir: string): Promise<void> {
    const inFlight = loading.get(`${dir}@0`);
    if (inFlight) return inFlight;
    const work = trackBusy(dir, async () => {
      const page = await backend.listDirPage(dir, 0, PAGE);
      cache.seed(dir, page);
      forgetUnreadable(dir);
      if (root() && dir === root()) setRootName(basenameOf(dir, dir));
      recount();
      bump();
    }).finally(() => loading.delete(`${dir}@0`));
    loading.set(`${dir}@0`, work);
    return work;
  }

  /**
   * Warms a directory's first page without expanding it.
   *
   * Expanding applies the expanded state before its data can arrive, so a
   * directory that has never been listed shows a "loading…" row for as long as
   * the round trip takes. Resting the pointer on a folder is intent, and using it
   * means the click that follows expands instantly instead.
   */
  async function prefetch(dir: string): Promise<void> {
    const listing = cache.listing(dir);
    if (listing && !listing.stale) return;
    if (failedDirs.has(dir)) return;
    try {
      await loadPage0(dir);
    } catch (err) {
      // Quiet on purpose: nobody asked for this directory, so nobody gets a toast
      // for it. The failure is remembered all the same.
      markUnreadable(dir, String((err as Error)?.message ?? err), true);
    }
  }

  /**
   * Re-reads a listing the disk has moved past, *without* taking its rows away.
   *
   * A directory that is resident but stale is the common case just after an
   * external edit. Expanding it should show what we have and quietly catch up
   * behind it, not blank the subtree while a re-read runs.
   */
  function refreshStale(dir: string): void {
    const key = `${dir}@stale`;
    if (loading.has(key)) return;
    const work = trackBusy(dir, async () => {
      await reload(dir);
    })
      .catch(() => {
        /* keep showing the rows we already have */
      })
      .finally(() => loading.delete(key));
    loading.set(key, work);
  }

  /**
   * The lazy path. A directory that cannot be read is remembered as such and not
   * retried on every scroll — otherwise one permission-denied folder turns into an
   * endless loop of requests, which is worse than showing the failure. A disk
   * event or an explicit refresh clears the mark and tries again.
   */
  async function ensureLoaded(dir: string): Promise<void> {
    const listing = cache.listing(dir);
    if (listing && !listing.stale) return;
    if (failedDirs.has(dir)) return;
    if (listing) {
      refreshStale(dir);
      return;
    }
    try {
      await loadPage0(dir);
    } catch (err) {
      markUnreadable(dir, String((err as Error)?.message ?? err));
      bump();
    }
  }

  /**
   * The next page of an expanded directory. Appends *below* everything already
   * drawn, so the reader's rows — and their indices — do not move.
   */
  async function loadMore(dir: string): Promise<void> {
    const listing = cache.listing(dir);
    if (!listing) return;
    // A stale listing cannot be extended: its offsets are about a directory that
    // no longer looks like this. Re-read what is resident first — that keeps the
    // reader's rows where they were and makes the next page request meaningful.
    if (listing.stale) {
      await reload(dir);
      return;
    }
    if (listing.complete) return;
    const offset = listing.entries.length;
    const key = `${dir}@${offset}`;
    const inFlight = loading.get(key);
    if (inFlight) return inFlight;
    const work = trackBusy(dir, async () => {
      const page = await backend.listDirPage(dir, offset, PAGE);
      cache.append(dir, page);
      forgetUnreadable(dir);
      recount();
      bump();
    }).finally(() => loading.delete(key));
    loading.set(key, work);
    return work;
  }

  /**
   * Re-reads exactly the pages that are resident. Re-seeding with page 0 alone
   * would drop everything below it and yank rows out from under the reader.
   */
  async function reload(dir: string): Promise<void> {
    const resident = cache.listing(dir)?.entries.length ?? 0;
    if (!cache.has(dir)) return;
    const page = await backend.listDirPage(dir, 0, PAGE);
    cache.reseed(dir, page);
    if (root() && dir === root()) setRootName(basenameOf(dir, dir));
    let loaded = page.offset + page.entries.length;
    let pages = 1;
    while (loaded < resident && pages < RELOAD_PAGES) {
      const next = await backend.listDirPage(dir, loaded, PAGE);
      cache.append(dir, next);
      loaded = next.offset + next.entries.length;
      pages += 1;
      if (next.entries.length === 0) break;
    }
    recount();
    bump();
  }

  let watchQueued = false;
  let lastWatched = '';

  function syncWatch(): void {
    if (watchQueued) return;
    watchQueued = true;
    queueMicrotask(() => {
      watchQueued = false;
      const dirs = index()?.expandedDirs() ?? [];
      const key = dirs.join('\u0000');
      if (key === lastWatched) return;
      lastWatched = key;
      void backend.syncWatch(dirs).catch(() => {
        /* watching is best effort */
      });
    });
  }

  function setExpanded(path: string, open: boolean): void {
    setExpandedRaw((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
    if (open) void ensureLoaded(path).then(syncWatch);
    else syncWatch();
  }

  function toggle(path: string): void {
    setExpanded(path, !expanded().has(path));
  }

  /**
   * Expanding needs the directory's first page, so the load has to happen first.
   * The desired state is captured *before* awaiting: two rapid clicks would
   * otherwise both read the stale value and end up where they started, which
   * looks like the tree flickering open and shut.
   */
  async function toggleDir(path: string): Promise<void> {
    const wantOpen = !expanded().has(path);
    setExpanded(path, wantOpen);
    if (wantOpen) await ensureLoaded(path);
  }

  async function revealPath(path: string): Promise<void> {
    const base = root();
    if (!base) return;
    for (const dir of ancestorsOf(path, base).reverse()) {
      await ensureLoaded(dir);
    }
    setExpandedRaw((prev) => {
      const next = new Set(prev);
      for (const dir of ancestorsOf(path, base)) next.add(dir);
      return next;
    });
    bump();
    syncWatch();
  }

  async function openFile(path: string, mode?: StageMode): Promise<void> {
    const base = root();
    if (!base) return;
    if (path === base) return;
    let kind: 'dir' | 'file' | null = isDir(path) ? 'dir' : exists(path) ? 'file' : null;
    if (kind === null) {
      const parent = parentOf(path, base);
      if (parent) {
        await ensureLoaded(parent);
        kind = exists(path) ? 'file' : null;
      }
      // Past the resident page the listing simply does not know this path, and a
      // local guess would be worse than one stat.
      if (kind === null) {
        try {
          kind = await backend.pathKind(path);
        } catch {
          return;
        }
      }
    }
    if (kind === 'dir') {
      await revealPath(path);
      await ensureLoaded(path);
      return;
    }
    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActive(path);
    if (mode) setStageMode(mode);
    // Opening a file never changes what the stage shows: a PDF is a binary file
    // that says so, not a switch to the preview. The preview is reached on purpose.
    await loadText(path);
  }

  /**
   * Reads a file into the editor, which is what decides whether it can be held
   * whole at all: a large or binary file comes back as a mode rather than as text.
   */
  async function loadText(path: string, force = false): Promise<string | undefined> {
    if (force) editor.invalidate(path);
    const mode = await editor.open(path);
    return mode === 'text' ? editor.contentOf(path) : undefined;
  }

  /** Resident content, or empty while it is still on its way. */
  function contentOf(path: string): string {
    return editor.contentOf(path) ?? '';
  }

  function isLoaded(path: string): boolean {
    return editor.isResident(path);
  }

  /**
   * Writes this app made, and when, so the watcher's echo of them is not read back.
   *
   * Saving a file produces a disk event for that very file a moment later. Without
   * this the editor would re-read what it just wrote — a redundant scan, and back
   * when a reload blanked the buffer, a visible flicker.
   */
  const selfWrites = new Map<string, number>();

  function isSelfWrite(path: string): boolean {
    const at = selfWrites.get(path);
    if (at === undefined) return false;
    if (Date.now() - at > SELF_WRITE_MS) {
      selfWrites.delete(path);
      return false;
    }
    return true;
  }

  async function saveFile(path: string, content: string): Promise<void> {
    await backend.writeFile(path, content);
    // The buffer already holds exactly these bytes, so there is nothing to re-read;
    // record them and note the time so the watcher's echo is not read back either.
    editor.setContent(path, content);
    selfWrites.set(path, Date.now());
    setDirty((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }

  function closeTab(path: string): void {
    setTabs((prev) => {
      const next = prev.filter((p) => p !== path);
      if (active() === path) setActive(next.length ? next[next.length - 1] : null);
      return next;
    });
  }

  function closeTabs(paths: Iterable<string>): void {
    const doomed = new Set(paths);
    setTabs((prev) => {
      const next = prev.filter((p) => !doomed.has(p));
      if (active() && doomed.has(active() as string)) {
        setActive(next.length ? next[next.length - 1] : null);
      }
      return next;
    });
  }

  function moveBy(path: string, delta: number): void {
    setTabs((prev) => {
      const idx = prev.indexOf(path);
      if (idx < 0) return prev;
      const next = Math.max(0, Math.min(prev.length - 1, idx + delta));
      const arr = [...prev];
      const [item] = arr.splice(idx, 1);
      arr.splice(next, 0, item);
      return arr;
    });
  }

  function reorderTabs(path: string, to: number): void {
    setTabs((prev) => {
      const idx = prev.indexOf(path);
      if (idx < 0) return prev;
      const arr = [...prev];
      const [item] = arr.splice(idx, 1);
      arr.splice(Math.max(0, Math.min(arr.length, to)), 0, item);
      return arr;
    });
    setActive(path);
  }

  async function createEntry(dir: string, name: string, kind: 'file' | 'dir'): Promise<string | null> {
    const base = root();
    if (!base) return null;
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
      throw new Error(`invalid name: ${name}`);
    }
    const path = joinPath(dir, name);
    if (exists(path)) throw new Error(`${name} already exists in ${dir}`);
    await backend.createEntry(dir, name, kind);
    await refresh(dir);
    setExpanded(dir, true);
    return path;
  }

  async function renameEntry(path: string, name: string): Promise<string | null> {
    const base = root();
    if (!base) return null;
    const clean = name.trim().replace(/^\/+/, '');
    if (!clean) return null;
    if (clean === basenameOf(path, base)) return path;
    const parent = parentOf(path, base);
    if (!parent) return null;
    const target = joinPath(parent, clean);
    if (exists(target)) return null;
    await backend.renameEntry(path, target);
    batch(() => {
      editor.moveBuffer(path, target);
      remap(path, target);
      cache.delete(path);
    });
    await refresh(parent);
    setActive(target);
    return target;
  }

  async function removeEntry(path: string): Promise<void> {
    const base = root();
    if (!base) return;
    const parent = parentOf(path, base);
    const doomed = new Set<string>([path, ...(isDir(path) ? descendants(path) : [])]);
    await backend.removeEntry(path);
    batch(() => {
      for (const p of doomed) {
        cache.delete(p);
        editor.invalidate(p);
      }
      closeTabs(doomed);
      if (active() && doomed.has(active() as string)) setActive(null);
      setExpandedRaw((prev) => {
        const next = new Set<string>();
        for (const dir of prev) {
          if (doomed.has(dir) || [...doomed].some((d) => dir.startsWith(`${d}/`))) continue;
          next.add(dir);
        }
        return next;
      });
    });
    if (parent) await refresh(parent);
    recount();
  }

  async function removeEntries(paths: Iterable<string>): Promise<void> {
    for (const p of paths) await removeEntry(p);
  }

  async function move(from: string, destDir: string): Promise<string | null> {
    const base = root();
    if (!base) return null;
    const target = joinPath(destDir, basenameOf(from, base));
    if (target === from) return from;
    if (parentOf(from, base) === destDir) return from;
    if (exists(target)) return null;
    const fromParent = parentOf(from, base);
    await backend.renameEntry(from, target);
    batch(() => {
      remap(from, target);
      cache.delete(from);
    });
    // A move crosses directories, and a watcher only reports the destination, so
    // the source listing has to be told explicitly.
    if (fromParent) await refresh(fromParent);
    await refresh(destDir);
    void backend.invalidateDir(from).catch(() => {});
    return target;
  }

  function descendants(path: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of cache.get(dir) ?? []) {
        if (entry.kind !== 'dir') continue;
        out.push(entry.path);
        if (out.length < 5000) walk(entry.path);
      }
    };
    walk(path);
    return out;
  }

  function remap(from: string, to: string): void {
    const apply = (p: string) =>
      p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p;
    setTabs((prev) => prev.map(apply));
    setActive((prev) => (prev ? apply(prev) : prev));
    setExpandedRaw((prev) => new Set([...prev].map(apply)));
    setDirty((prev) => new Set([...prev].map(apply)));
    setSelected((prev) => prev.map(apply));
  }

  async function refresh(dir: string): Promise<void> {
    cache.markStale(dir);
    forgetWriteAccess(dir);
    forgetUnreadable(dir);
    // A directory that was never resident is not "stale", it is unknown: load it,
    // so the result of a create/rename/delete is visible without another click.
    if (!cache.has(dir)) {
      await loadPage0(dir);
      return;
    }
    await reload(dir);
  }

  async function openFolder(path: string): Promise<void> {
    // Drop the host's pages first: the folder we are about to open may share paths
    // with the one being closed, and it must not be served a stale listing.
    await backend.clearDirIndex().catch(() => {});
    const opened = await backend.openFolder(path);
    batch(() => {
      cache.clear();
      editor.clearAll();
      rowCache.clear();
      moreCache.clear();
      lastWatched = '';
      failedDirs.clear();
      setRoot(opened.path);
      setRootName(opened.name);
      // The root backs every top-level row, so it is protected until the tree
      // recomputes the on-screen set.
      cache.protect([opened.path]);
      cache.seed(opened.path, opened.page);
      setExpandedRaw(new Set([opened.path]));
      setTabs([]);
      setActive(null);
      setSelected([]);
      setDirty(new Set<string>());
      recount();
      bump();
    });
    syncWatch();
  }

  async function pickFolder(): Promise<boolean> {
    const picked = await backend.pickDirectory();
    if (!picked) return false;
    await openFolder(picked);
    return true;
  }

  function closeFolder(): void {
    batch(() => {
      cache.clear();
      rowCache.clear();
      moreCache.clear();
      editor.clearAll();
      lastWatched = '';
      failedDirs.clear();
      setRoot(null);
      setRootName('');
      setExpandedRaw(new Set<string>());
      setTabs([]);
      setActive(null);
      recount();
      bump();
    });
    void backend.clearDirIndex().catch(() => {});
  }

  const stopWatch = backend.onChange((change: Change) => onDiskChange(change));

  /**
   * A restored session has a root and a set of open tabs but nothing resident, so
   * the tree used to come back empty until the folder was picked again.
   *
   * Only the root's first page is read here. The directories that were open last
   * time stay *unread* on purpose: filling them all in one burst means dozens of
   * concurrent directory sorts on the host while the window is already up, and a
   * screen full of "loading…" is what that looks like. Left alone they behave
   * exactly like a freshly opened tree — pending rows that fill as they scroll
   * into view — which is the whole point of this component.
   */
  async function bootstrap(): Promise<void> {
    const base = root();
    if (!base) return;
    try {
      const opened = await backend.openFolder(base);
      // The reader may have picked a different folder while this was in flight.
      // Seeding now would leave the tree drawing the old project's rows.
      if (root() !== base) return;
      batch(() => {
        cache.protect([opened.path]);
        cache.seed(opened.path, opened.page);
        recount();
        bump();
      });
      syncWatch();
      // Restored tabs hold no buffers yet; read the ones the reader will see.
      for (const path of tabs().slice(0, 16)) void loadText(path);
    } catch {
      closeFolder();
    }
  }
  void bootstrap();

  /**
   * Disk events are applied, not reacted to.
   *
   * A build tool writing a thousand files produces a thousand events, and each one
   * used to trigger a full re-read of its directory: the tree did a thousand
   * listings and repainted between them. So each event now does two very cheap
   * things — it patches the resident listing in memory, and it leaves a note for a
   * later reconciliation. Rows appear the moment the event arrives, and the
   * directories that genuinely need re-reading are read once, after a short quiet
   * period, instead of once per event.
   */
  const queued: Map<string, Change[]> = new Map();
  let repaintQueued = false;
  let reconcileQueued = false;

  function onDiskChange(change: Change): void {
    const base = root();
    if (!base || !change.dir.startsWith(base)) return;
    // Nothing resident for that directory: no rows to fix, nothing to re-read.
    if (!cache.has(change.dir)) return;
    const list = queued.get(change.dir);
    if (list) list.push(change);
    else queued.set(change.dir, [change]);
    applyChange(change);
    scheduleReconcile();
  }

  /** In-memory only: no I/O, no await, so the row is right in the same frame. */
  function applyChange(change: Change): void {
    const touched = joinPath(change.dir, change.name);
    switch (change.kind) {
      case 'created':
        if (change.isDir === undefined) break;
        cache.patchCreate(change.dir, change.name, change.isDir ? 'dir' : 'file');
        scheduleRepaint();
        return;
      case 'removed':
        cache.patchRemove(change.dir, change.name);
        scheduleRepaint();
        return;
      case 'renamed':
        if (change.from === undefined || change.isDir === undefined) break;
        cache.patchRename(change.dir, change.from, {
          name: change.name,
          path: touched,
          kind: change.isDir ? 'dir' : 'file',
        });
        scheduleRepaint();
        return;
      case 'changed':
        // Content only: the listing is unaffected, only an open buffer is. A change
        // we just made ourselves is not re-read.
        if (!isSelfWrite(touched) && editor.isResident(touched)) void reloadText(touched);
        return;
    }
    // The event could not be expressed as a patch (an atomic save looks exactly
    // like a rename). Note the directory and let the quiet-period read settle it.
    cache.markStale(change.dir);
    scheduleRepaint();
  }

  function scheduleRepaint(): void {
    if (repaintQueued) return;
    repaintQueued = true;
    queueMicrotask(() => {
      repaintQueued = false;
      recount();
      bump();
    });
  }

  function scheduleReconcile(): void {
    if (reconcileQueued) return;
    reconcileQueued = true;
    setTimeout(() => {
      reconcileQueued = false;
      void reconcile();
    }, RECONCILE_DELAY_MS);
  }

  async function reloadText(path: string): Promise<void> {
    const fresh = await loadText(path, true);
    if (fresh !== undefined) bump();
  }

  async function reconcile(): Promise<void> {
    const batched = [...queued.entries()];
    queued.clear();
    // Content changes are already applied the moment the event arrives, so this
    // pass only settles the listing questions a patch could not answer.
    const recheck = new Set<string>();
    for (const [dir, changes] of batched) {
      if (!cache.has(dir)) continue;
      for (const change of changes) {
        if (change.kind === 'created' && change.isDir === undefined) recheck.add(dir);
        else if (change.kind === 'renamed' && (change.from === undefined || change.isDir === undefined)) {
          recheck.add(dir);
        }
      }
    }
    for (const dir of recheck) {
      if (cache.listing(dir)?.stale) await reload(dir);
    }
    if (recheck.size) syncWatch();
  }

  function setStageMode(next: StageMode): void {
    setStageModeRaw(next);
  }

  createEffect(() => {
    const session: Session = {
      root: root(),
      tabs: tabs(),
      active: active(),
      stageMode: stageMode(),
      expanded: [...expanded()],
    };
    ls?.setItem('rg.session', JSON.stringify(session));
  });

  return {
    backend,
    root,
    rootName,
    expanded,
    tabs,
    active,
    stageMode,
    setStageMode,
    selected,
    setSelected,
    renaming,
    setRenaming,
    creating,
    setCreating,
    dirty,
    setDirty,
    fileCount,
    countTruncated,
    busyDirs,
    missing,
    unreadable,
    pageable,
    reasonOf,
    /** Bumped on every change to the row space; lets effects depend on "anything
     *  about the tree changed" without watching a dozen signals. */
    revision: version,
    rowCount,
    sliceRows,
    rowAt,
    indexOf,
    entriesOf,
    listingOf,
    entryOf,
    exists,
    isDir,
    ensureLoaded,
    prefetch,
    loadMore,
    reload,
    setExpanded,
    toggle,
    toggleDir,
    protectWindow,
    canWrite,
    forgetWriteAccess,
    revealPath,
    openFile,
    closeTab,
    closeTabs,
    moveBy,
    reorderTabs,
    createEntry,
    renameEntry,
    removeEntry,
    removeEntries,
    move,
    contentOf,
    editor,
    isLoaded,
    loadText,
    saveFile,
    openFolder,
    pickFolder,
    closeFolder,
    refresh,
    stats: () => cache.stats(),
    dispose: stopWatch,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;