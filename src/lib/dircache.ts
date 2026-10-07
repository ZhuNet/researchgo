import { insertAt, type DirEntry, type DirPage } from './backend';

export interface DirListing {
  dir: string;
  /**
   * Insertion serial of this listing. The eviction queue holds the same serial,
   * and a slot whose serial no longer matches belongs to a listing that was
   * dropped and re-added — acting on it would evict the live one out of turn.
   */
  seq: number;
  /** Resident prefix of the sorted listing. Never a partial window into the
   *  middle: pages arrive in order and are dropped from the tail. */
  entries: DirEntry[];
  /** Exact child count from the index, so "how much is left" is never guessed. */
  total: number;
  files: number;
  dirs: number;
  /** Every child is resident — nothing more to fetch for this directory. */
  complete: boolean;
  /** The disk moved under this listing; re-read before trusting it. */
  stale: boolean;
}

export interface DirCacheOptions {
  maxDirs: number;
  maxEntries: number;
}

export const DEFAULT_LIMITS: DirCacheOptions = {
  maxDirs: 2000,
  maxEntries: 200_000,
};

/**
 * Resident directory listings under a hard ceiling, evicted in insertion order.
 *
 * FIFO rather than LRU on purpose. Under LRU, a directory the reader keeps
 * touching never leaves, so a long session grows with everything ever opened —
 * the opposite of what a large repository needs. Here the resident set is a
 * sliding window over what the tree has asked for: what entered first leaves
 * first, and coming back costs exactly one page request.
 *
 * The ceiling has no back door. An expanded directory that gets evicted keeps its
 * expanded flag and collapses to a single pending row, which repopulates when it
 * scrolls back into view. `protect` is not an exemption from the ceiling either —
 * it is the window itself, plus whatever the caller has pinned, and the next
 * insert past the cap evicts the oldest unprotected listing regardless.
 *
 * Nothing here is reactive on purpose: it is a plain data structure owned by the
 * store, which bumps a version counter to invalidate memos.
 */
export class DirCache {
  private listings = new Map<string, DirListing>();
  /**
   * Insertion order as `(dir, serial)` pairs. Re-reading a page does not move a
   * directory: "first in, first out" is the whole point, and access order is
   * exactly what would make the ceiling grow without bound.
   */
  private order: { dir: string; seq: number }[] = [];
  private head = 0;
  private serial = 0;
  private protectedDirs = new Set<string>();
  private readonly maxDirs: number;
  private readonly maxEntries: number;
  private total = 0;

  constructor(options: Partial<DirCacheOptions> = {}) {
    this.maxDirs = options.maxDirs ?? DEFAULT_LIMITS.maxDirs;
    this.maxEntries = options.maxEntries ?? DEFAULT_LIMITS.maxEntries;
  }

  get size(): number {
    return this.listings.size;
  }

  get entryCount(): number {
    return this.total;
  }

  get protectedCount(): number {
    return this.protectedDirs.size;
  }

  has(dir: string): boolean {
    return this.listings.has(dir);
  }

  /** Resident entries — the prefix the tree can currently draw rows from. */
  get(dir: string): DirEntry[] | undefined {
    return this.listings.get(dir)?.entries;
  }

  listing(dir: string): DirListing | undefined {
    return this.listings.get(dir);
  }

  /** Every resident listing, for the O(dirs) summaries the store publishes. */
  *resident(): IterableIterator<DirListing> {
    yield* this.listings.values();
  }

  /** Installs page 0, the way `open_folder` hands one over. */
  seed(dir: string, page: DirPage): void {
    this.install(dir, page.entries, page.total, page.files, page.dirs);
  }

  /**
   * Replaces the resident prefix from page 0 after the disk moved, keeping the
   * directory's place in the eviction queue — re-reading something is not the
   * same as discovering it, and a reload must not make an old directory look new.
   */
  reseed(dir: string, page: DirPage): void {
    if (!this.listings.has(dir)) {
      this.seed(dir, page);
      return;
    }
    this.install(dir, page.entries, page.total, page.files, page.dirs, 0, false);
  }

  /**
   * Adds the next page. Pages that do not line up with the resident prefix (a
   * reload raced us, or the listing was evicted mid-flight) replace it instead of
   * splicing into the wrong slot.
   */
  append(dir: string, page: DirPage): void {
    const current = this.listings.get(dir);
    if (!current) return;
    if (page.offset !== current.entries.length) {
      this.install(dir, page.entries, page.total, page.files, page.dirs, page.offset);
      return;
    }
    current.entries.push(...page.entries);
    this.total += page.entries.length;
    current.total = page.total;
    current.files = page.files;
    current.dirs = page.dirs;
    current.complete = current.entries.length >= page.total;
    current.stale = false;
    this.evict();
  }

  /** Full listing in one piece. Used by tests and by any caller that has one. */
  set(dir: string, list: DirEntry[]): void {
    const dirs = list.filter((e) => e.kind === 'dir').length;
    this.install(dir, list, list.length, list.length - dirs, dirs);
  }

  /**
   * Applies one entry that appeared on disk, keeping the listing sorted.
   *
   * The listing is a *prefix* of the sorted order, so an entry that sorts past
   * the resident end only bumps the total: it belongs to a page nobody has asked
   * for yet, and splicing it in here would put a row at the wrong index.
   */
  patchCreate(dir: string, name: string, kind: 'dir' | 'file'): void {
    const listing = this.listings.get(dir);
    if (!listing) return;
    if (listing.entries.some((e) => e.name === name)) return;
    listing.total += 1;
    if (kind === 'dir') listing.dirs += 1;
    else listing.files += 1;
    const entry: DirEntry = {
      name,
      path: dir === '/' ? `/${name}` : `${dir}/${name}`,
      kind,
    };
    const at = insertAt(listing.entries, entry);
    if (listing.complete || at < listing.entries.length) {
      listing.entries.splice(at, 0, entry);
      this.total += 1;
    }
    listing.complete = listing.entries.length >= listing.total;
    this.evict();
  }

  /** Applies one entry that vanished from disk. */
  patchRemove(dir: string, name: string): void {
    const listing = this.listings.get(dir);
    if (!listing) return;
    listing.total = Math.max(0, listing.total - 1);
    const at = listing.entries.findIndex((e) => e.name === name);
    if (at >= 0) {
      const [gone] = listing.entries.splice(at, 1);
      this.total -= 1;
      if (gone.kind === 'dir') listing.dirs = Math.max(0, listing.dirs - 1);
      else listing.files = Math.max(0, listing.files - 1);
    }
    listing.complete = listing.entries.length >= listing.total;
  }

  /**
   * A rename or a move: the only change a watcher cannot describe as an add and
   * a remove, because it does not say which row the entry left from.
   */
  patchRename(dir: string, remove: string, entry: DirEntry): void {
    const listing = this.listings.get(dir);
    if (!listing) return;
    const at = listing.entries.findIndex((e) => e.name === remove);
    if (at < 0) {
      listing.stale = true;
      return;
    }
    const [gone] = listing.entries.splice(at, 1);
    this.total -= 1;
    if (gone.kind !== entry.kind) {
      if (gone.kind === 'dir') listing.dirs = Math.max(0, listing.dirs - 1);
      else listing.files = Math.max(0, listing.files - 1);
      if (entry.kind === 'dir') listing.dirs += 1;
      else listing.files += 1;
    }
    const slot = insertAt(listing.entries, entry);
    if (listing.complete || slot < listing.entries.length) {
      listing.entries.splice(slot, 0, entry);
      this.total += 1;
    }
    listing.complete = listing.entries.length >= listing.total;
    // The entry it replaced is gone for good; a re-read confirms nothing else
    // moved (an editor's atomic save looks exactly like a rename).
    listing.stale = true;
  }

  markStale(dir: string): void {
    const listing = this.listings.get(dir);
    if (listing) listing.stale = true;
  }

  /** Replaces the protected set: the visible window plus explicit pins. */
  protect(dirs: Iterable<string>): void {
    this.protectedDirs = new Set(dirs);
  }

  delete(dir: string): void {
    const previous = this.listings.get(dir);
    if (!previous) return;
    this.total -= previous.entries.length;
    this.listings.delete(dir);
  }

  clear(): void {
    this.listings.clear();
    this.order = [];
    this.head = 0;
    this.serial = 0;
    this.protectedDirs.clear();
    this.total = 0;
  }

  stats() {
    return {
      dirs: this.listings.size,
      entries: this.total,
      protected: this.protectedDirs.size,
      maxDirs: this.maxDirs,
      maxEntries: this.maxEntries,
    };
  }

  private install(
    dir: string,
    entries: DirEntry[],
    total: number,
    files: number,
    dirs: number,
    offset = 0,
    queue = true,
  ): void {
    const previous = this.listings.get(dir);
    let seq: number;
    if (previous) {
      // Keeping the serial is deliberate: re-reading a directory is not the same
      // as discovering it, so it must not jump the queue.
      seq = previous.seq;
      this.total -= previous.entries.length;
    } else {
      seq = ++this.serial;
      if (queue) this.order.push({ dir, seq });
    }
    this.listings.set(dir, {
      dir,
      seq,
      entries: entries.slice(),
      total,
      files,
      dirs,
      complete: offset + entries.length >= total,
      stale: false,
    });
    this.total += entries.length;
    this.evict();
  }

  /**
   * Drops the oldest unprotected listings until the caps are met. Amortised O(1):
   * the order array is walked forward with a head cursor instead of re-sorting
   * every key on every insert.
   */
  private evict(): void {
    while (
      (this.listings.size > this.maxDirs || this.total > this.maxEntries) &&
      this.head < this.order.length
    ) {
      const slot = this.order[this.head++];
      if (this.protectedDirs.has(slot.dir)) continue;
      const listing = this.listings.get(slot.dir);
      // Gone already, or re-added after this slot was queued: either way the slot
      // decides nothing. Evicting on a stale slot is how the directory the reader
      // is standing in used to disappear under them.
      if (!listing || listing.seq !== slot.seq) continue;
      this.total -= listing.entries.length;
      this.listings.delete(slot.dir);
    }
    // Queue slots for evicted and deleted directories are skipped, not removed;
    // once they dominate the array, start over.
    if (this.head > 64 && this.head * 2 > this.order.length) {
      this.order = this.order.slice(this.head);
      this.head = 0;
    }
  }
}
