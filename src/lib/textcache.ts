/**
 * Resident file contents, bounded by bytes rather than by file count.
 *
 * The editor holds whole files, and a count limit is the wrong bound: a hundred
 * 2 MiB files is 200 MB, and one 200 MB file is one entry that would have passed
 * it. Bytes are what the process actually spends, so bytes are what is capped.
 *
 * Eviction is FIFO in insertion order, exactly like the directory cache, with
 * two exceptions and both of them are about not losing work:
 *
 *  - The file being read is pinned. Dropping it would mean re-reading on every
 *    tab switch, which is the "flash of loading" this whole design avoids.
 *  - Unsaved files are pinned. Dropping one drops an edit.
 *
 * A slot carries the sequence number it was queued at, so a file that is
 * evicted and re-added cannot be dropped by the stale queue entry from its
 * previous life.
 */

export interface TextCacheOptions {
  /** Total bytes of content kept resident. */
  maxBytes: number;
  /** Files kept even when over budget, on top of the pinned ones. */
  maxEntries?: number;
}

export const DEFAULT_TEXT_BUDGET = 48 * 1024 * 1024;

/**
 * Rough resident cost of a string. Not the exact encoded length — measuring it
 * would cost a pass over the content — but proportional to it, and every budget
 * here is approximate by nature.
 */
export function bytesOf(text: string): number {
  return text.length * 2;
}

interface Slot {
  seq: number;
}

export class TextCache<T> {
  private readonly values = new Map<string, { value: T; bytes: number; seq: number }>();
  private readonly queue: (Slot & { key: string })[] = [];
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private seq = 0;
  private live = 0;
  private readonly pinned = new Set<string>();

  constructor(options: TextCacheOptions) {
    this.maxBytes = Math.max(0, options.maxBytes);
    this.maxEntries = Math.max(1, options.maxEntries ?? 32);
  }

  /** Bytes currently held. */
  get bytes(): number {
    return this.live;
  }

  get size(): number {
    return this.values.size;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  get(key: string): T | undefined {
    return this.values.get(key)?.value;
  }

  /** Reads without changing the eviction order — a peek is not a use. */
  peek(key: string): T | undefined {
    return this.values.get(key)?.value;
  }

  keys(): Iterable<string> {
    return this.values.keys();
  }

  /**
   * Stores a value and marks it as the most recently used. Re-adding an existing
   * key requeues it, so an edited file stays alive.
   */
  put(key: string, value: T, bytes: number): void {
    this.drop(key);
    const seq = ++this.seq;
    this.values.set(key, { value, bytes, seq });
    this.queue.push({ key, seq });
    this.live += bytes;
    this.evict();
  }

  /**
   * Replaces a value in place, keeping its position in the eviction order.
   *
   * Used when a buffer grows while being edited: the file was already admitted,
   * so moving it to the back would let an edit reorder what gets dropped.
   */
  replace(key: string, value: T, bytes: number): void {
    const slot = this.values.get(key);
    if (!slot) {
      this.put(key, value, bytes);
      return;
    }
    this.live += bytes - slot.bytes;
    slot.value = value;
    slot.bytes = bytes;
    this.evict();
  }

  delete(key: string): boolean {
    return this.drop(key);
  }

  clear(): void {
    this.values.clear();
    this.queue.length = 0;
    this.live = 0;
  }

  /** Files that survive eviction regardless of budget. */
  pin(key: string): void {
    this.pinned.add(key);
  }

  unpin(key: string): void {
    this.pinned.delete(key);
    this.evict();
  }

  /** The pinned set, for callers that need to persist or reapply it. */
  pins(): ReadonlySet<string> {
    return new Set(this.pinned);
  }

  /**
   * Drops the oldest unpinned entries until the cache is inside its budget.
   *
   * Both bounds are enforced: an entry larger than the whole budget would
   * otherwise be dropped the moment it lands, which for a file the reader is
   * looking at means an endless re-read.
   */
  private evict(): void {
    // A pass that drops nothing ends the loop. Without this, a cache where
    // everything is pinned rotates its queue forever: the pinned-at-the-head case
    // is handled by rotating past it, and rotating past *every* entry makes no
    // progress while the budget stays exceeded.
    let consider = this.queue.length + 1;
    while (consider-- > 0 && this.queue.length > 0 && this.overBudget()) {
      const next = this.queue[0];
      const slot = next && this.values.get(next.key);
      // A slot whose file was replaced or removed is a tombstone; the live entry
      // for that key carries a newer sequence and sits later in the queue.
      if (!slot || slot.seq !== next.seq) {
        this.queue.shift();
        continue;
      }
      if (this.pinned.has(next.key)) {
        // Rotate past it rather than stopping: a pinned head must not block the
        // rest of the queue from being considered.
        this.queue.shift();
        this.queue.push(next);
        continue;
      }
      const doomed = this.queue.shift();
      if (doomed) this.drop(doomed.key);
    }
  }

  private overBudget(): boolean {
    return this.live > this.maxBytes || this.values.size > this.maxEntries;
  }

  private drop(key: string): boolean {
    const slot = this.values.get(key);
    if (!slot) return false;
    this.values.delete(key);
    this.live -= slot.bytes;
    return true;
  }

  /**
   * Reports what eviction would drop, without dropping it.
   *
   * The reader uses this to decide whether to hold a file open: a 40 MB file
   * inside a 48 MB budget will evict everything else the moment it lands, and
   * that should be a decision rather than a surprise.
   */
  wouldEvict(key: string, bytes: number): string[] {
    const incoming = new Set([key]);
    const doomed: string[] = [];
    let live = this.live + bytes;
    for (const entry of this.queue) {
      if (live <= this.maxBytes && doomed.length + 1 <= this.maxEntries) break;
      const slot = this.values.get(entry.key);
      if (!slot || slot.seq !== entry.seq) continue;
      if (this.pinned.has(entry.key) || incoming.has(entry.key)) continue;
      doomed.push(entry.key);
      live -= slot.bytes;
    }
    return doomed;
  }
}