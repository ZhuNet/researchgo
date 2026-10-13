import { batch, createEffect, createMemo, createSignal, untrack } from 'solid-js';

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
  const editor = createEditor(backend, editorLimits, (path) => {
    // The text cache and tab list are one lifecycle for editable, unprotected
    // files. A budget eviction must not leave an empty tab or an orphaned model.
    if (!tabs().includes(path)) return;
    if (active() === path || dirty().has(path) || missingTabs().has(path)) {
      console.warn(`[tabs] protected buffer evicted: ${path}`);
      return;
    }
    closeTab(path);
  });
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
  // The host resolves file versus directory and validates the direct TeX children.
  createEffect(() => {
    const base = root();
    const selection = base ? (selected().at(-1) ?? active() ?? base) : null;
    untrack(() => { void editor.loadPlan(selection); });
  });
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal<{ dir: string; kind: 'file' | 'dir' } | null>(null);
  const [dirty, setDirty] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [missingTabs, setMissingTabs] = createSignal<ReadonlySet<string>>(new Set());
  let visibleTabs = new Set<string>();
  let treeWindowKnown = false;
  let disposed = false;
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
   * The file on screen, anything unsaved and struck-through tabs are kept out
   * of content eviction.
   *
   * Driven by an effect rather than by each call site that changes the active tab
   * or marks a buffer dirty: a missed call here does not fail loudly, it leaves a
   * buffer pinned forever, or drops an edit the next time a large file lands.
   */
  createEffect(() => {
    editor.syncPins(active(), dirty(), missingTabs());
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
    treeWindowKnown = true;
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
        // Resident but stale (its ancestor was collapsed while open, so the
        // watcher dropped it and the disk moved underneath): treat it like a
        // gap so the effect re-reads it in the background, keeping the rows we
        // already have on screen instead of waiting for a second click.
        else if (cache.listing(row.path)?.stale) gaps.push(row.path);
      }
    }
    publishWindowState(gaps, failed, more);
    syncWatch();
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
  let watchedTree = new Set<string>();
  let syncingWatch = false;

  function visibleTreeDirs(): Set<string> {
    const dirs = new Set<string>();
    const base = root();
    const idx = index();
    if (!base || !idx) return dirs;
    dirs.add(base);
    if (!treeWindowKnown) {
      for (const dir of idx.expandedDirs()) if (cache.has(dir)) dirs.add(dir);
      return dirs;
    }
    for (let i = windowRange.start; i < windowRange.end; i++) {
      const row = idx.rowAt(i);
      if (!row) break;
      const parent = parentOf(row.path, base);
      if (parent) for (const dir of [parent, ...ancestorsOf(parent, base)]) dirs.add(dir);
      if (row.kind === 'dir' && row.expanded && cache.has(row.path)) dirs.add(row.path);
    }
    return dirs;
  }

  function monitoredTabs(): Set<string> {
    const paths = new Set([...visibleTabs].filter((path) => tabs().includes(path)));
    const path = active();
    if (path) paths.add(path);
    return paths;
  }

  function protectTabs(paths: string[]): void {
    const previous = visibleTabs;
    visibleTabs = new Set(paths);
    for (const path of monitoredTabs()) if (!previous.has(path)) void checkTab(path, true);
    syncWatch();
  }

  function syncWatch(): void {
    if (watchQueued || disposed) return;
    watchQueued = true;
    queueMicrotask(() => {
      watchQueued = false;
      if (disposed || syncingWatch) return;
      const tree = visibleTreeDirs();
      const entering = [...tree].filter((dir) => !watchedTree.has(dir));
      for (const dir of watchedTree) if (!tree.has(dir)) cache.markStale(dir);
      watchedTree = tree;
      const wanted = new Set(tree);
      const base = root();
      if (base) for (const path of monitoredTabs()) {
        for (const dir of ancestorsOf(path, base)) wanted.add(dir);
      }
      const dirs = [...wanted].sort();
      const key = dirs.join('\u0000');
      if (key === lastWatched) return;
      syncingWatch = true;
      void backend.syncWatch(dirs).then((installed) => {
        lastWatched = [...installed].sort().join('\u0000');
        for (const dir of entering) if (cache.listing(dir)?.stale) {
          void backend.invalidateDir(dir).then(() => refreshStale(dir));
        }
      }).catch((err) => console.warn('[watch]', err)).finally(() => {
        syncingWatch = false;
        if (lastWatched === key) syncWatch();
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
    if (open) {
      void ensureLoaded(path).then(syncWatch);
    } else {
      // A resident listing stops being watched the moment its directory
      // collapses: files that land from here on produce no event, so the
      // next expand must re-ask the host instead of trusting the cache.
      // The host's mtime check keeps the unchanged case cheap, and a
      // listing warmed by prefetch (never watched, expanded within a
      // heartbeat) stays zero-read by design.
      //
      // The same loss of coverage hits every *expanded descendant*: the watch
      // set is built from reachable spans, so collapsing this folder unwatches
      // its open subfolders too. Their rows stay resident and their expanded
      // flag stays set; without this they reappear with stale children until
      // the reader collapses and re-expands the subfolder itself.
      for (const d of expanded()) {
        if (d !== path && d.startsWith(`${path}/`)) cache.markStale(d);
      }
      if (cache.has(path)) cache.markStale(path);
      syncWatch();
    }
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

  async function openFile(path: string): Promise<void> {
    const base = root();
    if (!base) return;
    if (path === base) return;
    if (tabs().includes(path)) {
      setActive(path);
      setStageMode('code');
      await checkTab(path, !missingTabs().has(path));
      syncWatch();
      return;
    }
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
    // Opening a file is a request to read source, so the stage follows it there.
    // Without this a reader who was in the preview has to notice that the editor
    // they just asked for is hidden behind another pane, and click their way back.
    setStageMode('code');
    await loadText(path);
    if (!tabs().includes(path) || root() !== base) return;
    await checkTab(path, false);
    syncWatch();
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

  async function saveFile(path: string, content: string): Promise<void> {
    await backend.writeFile(path, content);
    if (disposed || !tabs().includes(path)) return;
    // Record the bytes written; the watcher can still report a subsequent change.
    editor.setContent(path, content);
    setMissingTabs((prev) => { const next = new Set(prev); next.delete(path); return next; });
    setDirty((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    await checkTab(path, true);
    const base = root();
    if (base) for (const dir of ancestorsOf(path, base)) {
      if (cache.has(dir)) await refresh(dir);
    }
    syncWatch();
  }

  function closeTab(path: string): void {
    closeTabs([path]);
  }

  function closeTabs(paths: Iterable<string>): void {
    const doomed = new Set(paths);
    if (!doomed.size) return;
    batch(() => {
      setTabs((prev) => {
        const next = prev.filter((p) => !doomed.has(p));
        if (active() && doomed.has(active() as string)) {
          setActive(next.length ? next[next.length - 1] : null);
        }
        return next;
      });
      setDirty((prev) => new Set([...prev].filter((p) => !doomed.has(p))));
      setMissingTabs((prev) => new Set([...prev].filter((p) => !doomed.has(p))));
      for (const path of doomed) {
        editor.forget(path);
        tabStamps.delete(path);
        visibleTabs.delete(path);
      }
    });
    syncWatch();
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
      }
      setMissingTabs((prev) => {
        const next = new Set(prev);
        for (const p of tabs()) if (p === path || p.startsWith(`${path}/`)) next.add(p);
        return next;
      });
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
    syncWatch();
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

  /**
   * Copies files or folders dragged in from the host into a directory of the
   * open workspace. The backend resolves name collisions; the listing is
   * re-read here so the copies become rows immediately, even in a folder the
   * watcher is not watching.
   */
  async function importInto(destDir: string, sources: string[]): Promise<string[]> {
    const base = root();
    if (!base) return [];
    const copied = await backend.copyInto(destDir, sources);
    await refresh(destDir);
    return copied;
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
    for (const path of tabs()) if (apply(path) !== path) editor.moveBuffer(path, apply(path));
    setMissingTabs((prev) => new Set([...prev].map(apply)));
    visibleTabs = new Set([...visibleTabs].map(apply));
    setTabs((prev) => prev.map(apply));
    setActive((prev) => (prev ? apply(prev) : prev));
    setExpandedRaw((prev) => new Set([...prev].map(apply)));
    setDirty((prev) => new Set([...prev].map(apply)));
    setSelected((prev) => prev.map(apply));
    syncWatch();
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
      watchedTree.clear();
      visibleTabs.clear();
      tabStamps.clear();
      setMissingTabs(new Set<string>());
      treeWindowKnown = false;
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
      watchedTree.clear();
      visibleTabs.clear();
      tabStamps.clear();
      setMissingTabs(new Set<string>());
      treeWindowKnown = false;
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
    syncWatch();
  }

  const stopWatch = backend.onChange((change: Change) => onDiskChange(change));

  /**
   * A toolchain is installed from a terminal, not from this window, so PATH can
   * go from "no xelatex" to "xelatex" while the app sits open. The build plan is
   * refreshed on selection changes, so without this the preview goes on
   * reporting a toolchain that is now installed, and leaves Build disabled on a
   * machine where the command runs fine.
   *
   * Subscribed here rather than in the preview because the answer is not the
   * preview's: it is a property of the host, and it goes stale whether or not
   * that pane happens to be showing.
   */
  const stopToolchainWatch = backend.onToolchainChange(() => {
    const dir = editor.buildTarget();
    if (dir) void editor.loadPlan(dir);
  });

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
    if (!base || (change.dir !== base && !change.dir.startsWith(base === '/' ? '/' : `${base}/`))) return;
    const touched = joinPath(change.dir, change.name);
    const old = change.from ? joinPath(change.dir, change.from) : touched;
    const target = editor.buildTarget();
    if (target && change.kind !== 'changed' &&
        (change.name.toLowerCase().endsWith('.tex') || change.from?.toLowerCase().endsWith('.tex') ||
         target === touched || target.startsWith(`${touched}/`) || target === old || target.startsWith(`${old}/`))) {
      void editor.loadPlan(target);
    }
    for (const path of monitoredTabs()) {
      if (path === touched || path.startsWith(`${touched}/`) || path === old || path.startsWith(`${old}/`)) {
        void checkTab(path, true);
      }
    }
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
        // Content only: open buffers are checked above; only an unopened
        // cached probe needs to be discarded here.
        if (!tabs().includes(touched)) editor.invalidate(touched);
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
      void reconcile().catch((err) => console.warn('[watch] reconciliation failed', err));
    }, RECONCILE_DELAY_MS);
  }

  async function reloadText(path: string): Promise<void> {
    await editor.refresh(path);
    bump();
  }

  const checkingTabs = new Map<string, Promise<void>>();
  const tabAgain = new Set<string>();
  const tabStamps = new Map<string, string>();
  async function checkTab(path: string, content: boolean): Promise<void> {
    const pending = checkingTabs.get(path);
    if (pending) { if (content) tabAgain.add(path); return pending; }
    const work = (async () => {
      do {
        tabAgain.delete(path);
        let present = false;
        try { present = await backend.pathKind(path) === 'file'; } catch { /* gone */ }
        if (disposed || !tabs().includes(path)) return;
        const wasMissing = missingTabs().has(path);
        if (present) {
          try {
            const info = await backend.fileInfo(path);
            if (disposed || !tabs().includes(path)) return;
            const stamp = `${info.size}:${info.mtimeMs}:${info.binary}`;
            const previous = tabStamps.get(path);
            if (previous !== undefined && previous !== stamp) content = true;
            tabStamps.set(path, stamp);
          } catch { /* Keep existence separate from read permission. */ }
        } else tabStamps.delete(path);
        if (disposed || !tabs().includes(path)) return;
        setMissingTabs((prev) => {
          if (prev.has(path) === !present) return prev;
          const next = new Set(prev);
          if (present) next.delete(path); else next.add(path);
          return next;
        });
        if (present && (content || wasMissing)) {
          if (editor.isResident(path) || active() === path) {
            await reloadText(path);
            if (disposed || !tabs().includes(path)) return;
            if (editor.modeOf(path) !== 'missing') {
              setDirty((prev) => { const next = new Set(prev); next.delete(path); return next; });
            }
          } else editor.invalidate(path);
        }
        // Do not probe an absent path in the editor: its resident text is now
        // the only copy from which a struck-through tab can be restored.
        content = true;
      } while (tabAgain.has(path));
    })().finally(() => checkingTabs.delete(path));
    checkingTabs.set(path, work);
    return work;
  }

  // Native events are hints; this bounded pass also repairs missed events and
  // watches lost when an ancestor was moved. It never loads an invisible tree.
  let auditing = false;
  const auditTimer = setInterval(() => {
    if (disposed || auditing || !root()) return;
    auditing = true;
    syncWatch();
    void (async () => {
      for (const dir of visibleTreeDirs()) {
        if (!cache.has(dir)) continue;
        try {
          await reload(dir);
        } catch { cache.markStale(dir); }
      }
      for (const path of monitoredTabs()) await checkTab(path, false);
    })().finally(() => { auditing = false; });
  }, 2000);

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
      if (!watchedTree.has(dir)) continue;
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
    missingTabs,
    protectTabs,
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
    importInto,
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
    dispose: () => {
      disposed = true;
      clearInterval(auditTimer);
      void backend.syncWatch([]).catch(() => {});
      stopWatch();
      stopToolchainWatch();
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
