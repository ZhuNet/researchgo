import type { DirEntry } from './backend';

export interface Row {
  path: string;
  name: string;
  kind: 'dir' | 'file';
  depth: number;
  /** Mirrors the store's expanded set. The UI reads the signal directly (a plain
   *  field on a recycled object is invisible to Solid); this stays for tests. */
  expanded: boolean;
  index: number;
  /** Build in which `index` was last computed. `indexOf` trusts the cached index
   *  only while this matches, otherwise it walks the spans again. */
  gen?: number;
  /**
   * The directory is expanded but its entries are not resident, because the cache
   * evicted them to stay inside its ceiling. It renders as one placeholder row
   * until the store reloads it.
   */
  pending?: boolean;
  /**
   * The continuation row of a partially loaded directory: everything above it is
   * resident, everything below exists but has not been asked for. Clicking it
   * fetches the next page, which appends rows *after* it — so nothing the reader
   * is looking at moves.
   */
  more?: boolean;
  /** Children the index knows about that are not resident yet. */
  moreCount?: number;
}

/** What a directory contributes to the row space right now. */
export interface DirView {
  entries: DirEntry[];
  total: number;
  complete: boolean;
}

interface Branch {
  /** Offset of this child inside the parent's entry list. */
  offset: number;
  dir: string;
  /** Row index where the child's own rows begin. */
  start: number;
  /** Rows contributed by the child's subtree, including the child row itself. */
  total: number;
}

interface Span {
  dir: string;
  depth: number;
  entries: DirEntry[];
  /** Row index of this directory's first child row. */
  start: number;
  total: number;
  /** A continuation row follows this directory's children. */
  more: boolean;
  /** Expanded children only — collapsed siblings contribute exactly one row. */
  branches: Branch[];
}

/**
 * Flattens the expanded part of the tree lazily into one addressable row space.
 *
 * The old `buildRows` allocated one object per visible row, which is fine for a
 * demo seed and fatal at a million files. Here a directory only stores a span
 * plus the list of its *expanded* children, so memory is O(expanded
 * directories + expanded edges) rather than O(visible rows). `rowAt` descends
 * depth-first using those branches and never materialises the rows in between.
 *
 * The row space is *append-growing*. A directory whose listing is larger than
 * the resident page contributes its loaded entries plus exactly one continuation
 * row, so `length` is "rows that exist", never "rows that might exist". Total
 * height therefore tracks the data instead of a guess, and the scrollbar does not
 * lie about how deep the tree goes.
 */
export class RowIndex {
  private spans: Span[] = [];
  private readonly root: string;
  private readonly expanded: ReadonlySet<string>;
  private readonly lookup: (dir: string) => DirView | undefined;
  /**
   * Row objects are shared across rebuilds on purpose. Solid's `<For>` diffs by
   * reference, so handing out a fresh object per rebuild makes it destroy and
   * recreate every visible row — that reads as a full-tree flicker and it also
   * throws away the scroll position. Rows are mutable and updated in place, so
   * reuse is safe and makes expanding O(inserted rows) instead of O(window).
   */
  private readonly byPath: Map<string, Row>;
  private readonly byMore: Map<string, Row>;
  /**
   * Bumped by every rebuild. A cached row records the build that last positioned
   * it, so `indexOf` can tell "this row still knows its index" from "this row was
   * last seen before rows were inserted above it" — without that check a reveal
   * or a scroll restore can jump to a stale position.
   */
  private generation = 0;

  constructor(
    root: string,
    expanded: ReadonlySet<string>,
    lookup: (dir: string) => DirView | undefined,
    rowCache: Map<string, Row> = new Map(),
    moreCache: Map<string, Row> = new Map(),
  ) {
    this.root = root;
    this.expanded = expanded;
    this.lookup = lookup;
    this.byPath = rowCache;
    this.byMore = moreCache;
    this.rebuild();
  }

  get length(): number {
    const rootSpan = this.spans[0];
    return rootSpan ? rootSpan.total : 0;
  }

  get directoryCount(): number {
    return this.spans.length;
  }

  /** Directories whose rows are currently reachable, i.e. what we must watch. */
  expandedDirs(): string[] {
    return this.spans.map((s) => s.dir);
  }

  private rebuild(): void {
    this.generation += 1;
    this.spans = [];
    const view = this.lookup(this.root);
    const span: Span = {
      dir: this.root,
      depth: 0,
      entries: view?.entries ?? [],
      start: 0,
      total: 0,
      more: view ? !view.complete : false,
      branches: [],
    };
    this.spans.push(span);
    span.total = this.count(span, 0);
  }

  /** Rows contributed by a span, recursing only into expanded children. */
  private count(span: Span, cursor: number): number {
    let rows = 0;
    span.branches = [];
    span.start = cursor;
    const children = span.entries;
    for (let offset = 0; offset < children.length; offset++) {
      const entry = children[offset];
      const isOpen = entry.kind === 'dir' && this.expanded.has(entry.path);
      let added = 1;
      if (isOpen) {
        const view = this.lookup(entry.path);
        if (view && view.entries.length) {
          const branch: Branch = {
            offset,
            dir: entry.path,
            start: cursor + rows,
            total: 0,
          };
          const child: Span = {
            dir: entry.path,
            depth: span.depth + 1,
            entries: view.entries,
            start: branch.start,
            total: 0,
            more: !view.complete,
            branches: [],
          };
          if (span.depth < 32) {
            this.spans.push(child);
            branch.total = 1 + this.count(child, branch.start + 1);
          } else {
            branch.total = 1;
          }
          span.branches.push(branch);
          added = branch.total;
        }
      }
      rows += added;
    }
    if (span.more) rows += 1;
    span.total = rows;
    return rows;
  }

  rowAt(index: number): Row | undefined {
    if (index < 0 || index >= this.length) return undefined;
    let span = this.spans[0];
    if (!span) return undefined;

    // Branch bounds are absolute row indices, so every comparison must use
    // `index`, never a span-relative offset.
    for (let guard = 0; guard < 64; guard++) {
      const branch = span.branches.find(
        (b) => index > b.start && index < b.start + b.total,
      );
      if (!branch) break;
      const child = this.spans.find((s) => s.dir === branch.dir);
      if (!child) break;
      span = child;
    }

    let offset = index - span.start;
    for (const branch of span.branches) {
      if (branch.start < index) offset -= branch.total - 1;
    }
    if (offset >= span.entries.length) {
      if (!span.more) return undefined;
      return this.moreRow(span, index);
    }
    const entry = span.entries[offset];
    if (!entry) return undefined;
    const path = entry.path;
    let row = this.byPath.get(path);
    if (!row) {
      row = {
        path,
        name: entry.name,
        kind: entry.kind,
        depth: span.depth + 1,
        expanded: false,
        index,
      };
      this.byPath.set(path, row);
    }
    row.index = index;
    row.gen = this.generation;
    row.expanded = entry.kind === 'dir' && this.expanded.has(path);
    row.depth = span.depth + 1;
    row.pending =
      row.expanded && entry.kind === 'dir' && this.lookup(path) === undefined;
    row.more = false;
    row.moreCount = undefined;
    return row;
  }

  private moreRow(span: Span, index: number): Row {
    let row = this.byMore.get(span.dir);
    if (!row) {
      row = {
        path: span.dir,
        name: '',
        kind: 'dir',
        depth: span.depth + 1,
        expanded: true,
        index,
        more: true,
      };
      this.byMore.set(span.dir, row);
    }
    row.index = index;
    row.gen = this.generation;
    row.depth = span.depth + 1;
    const view = this.lookup(span.dir);
    row.moreCount = view ? Math.max(0, view.total - view.entries.length) : 0;
    return row;
  }

  slice(start: number, end: number): Row[] {
    const out: Row[] = [];
    const total = this.length;
    const from = Math.max(0, Math.min(start, total));
    const to = Math.max(from, Math.min(end, total));
    for (let i = from; i < to; i++) {
      const row = this.rowAt(i);
      if (row) out.push(row);
    }
    return out;
  }

  indexOf(path: string): number {
    const row = this.byPath.get(path);
    if (row && row.gen === this.generation) return row.index;
    for (const span of this.spans) {
      const offset = span.entries.findIndex((e) => e.path === path);
      if (offset < 0) continue;
      let index = span.start + offset;
      for (const branch of span.branches) {
        if (branch.offset < offset) index += branch.total - 1;
      }
      if (row) {
        row.index = index;
        row.gen = this.generation;
      }
      return index;
    }
    return -1;
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }
}

export function parentOf(path: string, root: string): string | undefined {
  if (path === root) return undefined;
  const cut = path.lastIndexOf('/');
  if (cut <= 0) return root;
  const parent = path.slice(0, cut);
  return parent.length >= root.length ? parent : root;
}

export function ancestorsOf(path: string, root: string): string[] {
  const out: string[] = [];
  let current = path;
  for (;;) {
    const parent = parentOf(current, root);
    if (parent === undefined) return out;
    out.push(parent);
    if (parent === root) return out;
    current = parent;
  }
}

export function basenameOf(path: string, root: string): string {
  if (path === root) return root;
  return path.slice(path.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/**
 * Where a row drag over `hit` would move `dragging` to.
 *
 * `hit` is the row under the pointer: `path: null` is the empty space of the
 * tree (which means the workspace root), and a `null` hit is a point outside
 * the tree. A file row stands for the folder that holds it. The source's own
 * folder would be a no-op; the source's subtree is off-limits. Every other
 * folder — a sibling, an ancestor, a folder in another branch — is a real move.
 */
export function moveTargetOf(
  dragging: string,
  base: string,
  hit: { path: string | null; kind: 'dir' | 'file' } | null,
): string | null {
  if (!hit) return null;
  const target =
    hit.path === null
      ? base
      : hit.kind === 'dir'
        ? hit.path
        : (parentOf(hit.path, base) ?? null);
  if (!target) return null;
  if (target === dragging || target.startsWith(`${dragging}/`)) return null;
  if (parentOf(dragging, base) === target) return null;
  return target;
}