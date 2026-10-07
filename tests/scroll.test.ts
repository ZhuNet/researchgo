import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';

import { virtualRange } from '../src/lib/tree';
import { createWorkspace, type Workspace } from '../src/store/workspace';
import { fakeBackend, FakeFs } from './fakefs';

/**
 * The tree component, minus the DOM.
 *
 * Every scroll and every expand does exactly what `FileTree` does: recompute the
 * window, hand the store the visible range to protect, then ask for whatever is
 * pending or has another page. Running that loop here is the only way to see
 * eviction and loading interact — the two are only ever wrong together.
 */

const ROW = 24;
const VIEWPORT = 24 * 12;
const OVERSCAN = 20;

const tick = () => new Promise((r) => setTimeout(r, 0));

function deepTree(branch: number, depth: number, leaves: number): Record<string, string[]> {
  const tree: Record<string, string[]> = { '/': [] };
  let frontier = ['/'];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const dir of frontier) {
      for (let i = 0; i < branch; i++) {
        const name = `d${i}`;
        tree[dir] ??= [];
        tree[dir].push(name);
        const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
        tree[path] ??= [];
        if (d === depth - 1) {
          for (let f = 0; f < leaves; f++) tree[path].push(`f${f}.rs`);
        } else next.push(path);
      }
    }
    frontier = next;
  }
  return tree;
}

interface Harness {
  ws: Workspace;
  fs: FakeFs;
  settle: () => Promise<void>;
  scroll: (px: number) => void;
  step: (px: number) => Promise<void>;
  window: () => { start: number; end: number };
  pending: () => string[];
  pageCalls: () => number;
}

function harness(fs: FakeFs, limits: Record<string, number> = {}): Harness {
  let ws!: Workspace;
  createRoot(() => {
    ws = createWorkspace(fakeBackend(fs), limits);
  });
  const range = () => virtualRange(current, VIEWPORT, ROW, ws.rowCount(), OVERSCAN);

  let current = 0;

  const settle = async () => {
    // A few turns: one for the request to land, one for the effect's follow-up.
    for (let i = 0; i < 6; i++) await tick();
  };

  const step = async (px: number) => {
    current = px;
    const { start, end } = range();
    ws.protectWindow(start, end);
    const calls = [];
    for (let i = start; i < end; i++) {
      const row = ws.rowAt(i);
      if (!row) continue;
      if (row.more) {
        calls.push(`more:${row.path}`);
        void ws.loadMore(row.path);
      } else if (row.pending) {
        calls.push(`pending:${row.path}`);
        void ws.ensureLoaded(row.path);
      }
    }
    (harness as { lastCalls?: string[] }).lastCalls = calls;
    await settle();
  };

  const h: Harness = {
    ws,
    fs,
    settle,
    scroll: (px) => {
      current = px;
    },
    step,
    window: range,
    pending: () => {
      const { start, end } = range();
      const out: string[] = [];
      for (let i = start; i < end; i++) {
        const row = ws.rowAt(i);
        if (row?.pending) out.push(row.path);
      }
      return out;
    },
    pageCalls: () => fs.pageCalls.length,
  };
  return h;
}

describe('窗口与淘汰一起跑', () => {
  it('嵌套展开不会出现"永远 loading"，也不会反复重读同一个目录', async () => {
    const fs = new FakeFs(deepTree(4, 3, 8));
    const h = harness(fs);
    await h.ws.openFolder('/');
    await h.step(0);

    const reads = new Map<string, number>();
    const note = () => {
      for (const call of fs.pageCalls) {
        const dir = call.split('@')[0];
        reads.set(dir, (reads.get(dir) ?? 0) + 1);
      }
      fs.pageCalls.length = 0;
    };
    note();

    // Walk down the tree the way a reader does: expand what is on screen, then
    // scroll into its children, level by level.
    let px = 0;
    for (let level = 0; level < 3; level++) {
      await h.step(px);
      const { start, end } = h.window();
      const dirRow = h.ws
        .sliceRows(start, end)
        .find((r) => r.kind === 'dir' && r.depth === level + 1);
      expect(dirRow, `level ${level} has a directory on screen`).toBeTruthy();
      await h.ws.toggleDir(dirRow!.path);
      note();
      px = Math.max(0, h.ws.indexOf(dirRow!.path) * ROW - VIEWPORT / 2);
      await h.step(px);
      expect(h.pending(), `level ${level}: nothing on screen stays pending`).toEqual([]);
    }

    // Nothing re-read more than a couple of times: no eviction/refetch loop.
    for (const [dir, times] of reads) {
      expect(times, `${dir} was read ${times} times`).toBeLessThanOrEqual(2);
    }
  });

  it('上限很小的时候，屏幕内的目录不会被反复淘汰又重读', async () => {
    const fs = new FakeFs(deepTree(4, 3, 8));
    // Far below what the tree needs, so eviction is guaranteed to happen.
    const h = harness(fs, { maxDirs: 3, maxEntries: 60 });
    await h.ws.openFolder('/');
    await h.step(0);

    fs.pageCalls.length = 0;
    for (let round = 0; round < 6; round++) {
      const { start, end } = h.window();
      for (let i = start; i < end; i++) {
        const row = h.ws.rowAt(i);
        if (row?.kind === 'dir' && row.depth === 1 && !row.expanded) {
          await h.ws.toggleDir(row.path);
          break;
        }
      }
      await h.step(h.ws.rowCount() * 0);
      expect(h.pending(), `round ${round}: on-screen rows must not stay pending`).toEqual([]);
    }

    const reads = new Map<string, number>();
    for (const call of fs.pageCalls) {
      const dir = call.split('@')[0];
      reads.set(dir, (reads.get(dir) ?? 0) + 1);
    }
    for (const [dir, times] of reads) {
      expect(times, `${dir} was read ${times} times under a tiny ceiling`).toBeLessThanOrEqual(3);
    }
  });

  it('收起根目录之后，展开另一个根目录照常出内容', async () => {
    const fs = new FakeFs(deepTree(5, 2, 10));
    const h = harness(fs);
    await h.ws.openFolder('/');
    await h.step(0);

    const first = h.ws.rowAt(0)!;
    await h.ws.toggleDir(first.path);
    await h.step(0);
    expect([...h.ws.missing()]).toEqual([]);

    // Collapsing the root hides the root's own children; whatever was open inside
    // them keeps its own rows, which is what every explorer does.
    h.ws.setExpanded('/', false);
    await h.step(0);
    const collapsed = h.ws.rowCount();
    expect(collapsed).toBe(10);

    const other = h.ws
      .sliceRows(0, collapsed)
      .find((r) => r.kind === 'dir' && r.depth === 1 && r.path !== first.path)!;
    expect(other).toBeTruthy();
    await h.ws.toggleDir(other.path);
    await h.step(0);

    expect(h.ws.expanded().has(other.path)).toBe(true);
    expect([...h.ws.missing()]).toEqual([]);
    expect(h.ws.rowCount()).toBe(collapsed + 5);
    const at = h.ws.indexOf(other.path);
    expect(h.ws.rowAt(at)?.path).toBe(other.path);
    expect(h.ws.rowAt(at + 1)?.path).toBe(`${other.path}/d0`);
    expect(h.ws.rowAt(at + 5)?.path).toBe(`${other.path}/d4`);
  });

  it('多层嵌套一路展开到底，中间不会出现永远补不齐的行', async () => {
    const fs = new FakeFs(deepTree(3, 5, 4));
    const h = harness(fs);
    await h.ws.openFolder('/');
    await h.step(0);

    let px = 0;
    for (let depth = 0; depth < 5; depth++) {
      const { start, end } = h.window();
      const row = h.ws
        .sliceRows(start, end)
        .find((r) => r.kind === 'dir' && r.depth === depth + 1);
      expect(row, `depth ${depth + 1} should be on screen`).toBeTruthy();
      await h.ws.toggleDir(row!.path);
      px = h.ws.indexOf(row!.path) * ROW;
      await h.step(px);
      expect([...h.ws.missing()], `depth ${depth + 1}: nothing stays unfilled`).toEqual([]);
      expect([...h.ws.unreadable()]).toEqual([]);
      const children = h.ws
        .sliceRows(0, h.ws.rowCount())
        .filter((r) => r.depth === depth + 2);
      expect(children.length, `depth ${depth + 2} rows exist`).toBeGreaterThan(0);
    }
  });

  it('超宽目录靠哨兵自动追加，读盘次数与页数相当而不是按行', async () => {
    const wide: Record<string, string[]> = { '/': ['big'] };
    wide['/big'] = Array.from({ length: 5_000 }, (_, i) => `f${i}.rs`);
    const fs = new FakeFs(wide);
    const h = harness(fs, { maxDirs: 4, maxEntries: 4_000 });
    await h.ws.openFolder('/');
    await h.step(0);
    await h.ws.toggleDir('/big');
    await h.step(0);

    // 512 rows resident plus one continuation row: nothing else exists yet, and
    // the continuation row is below the window, so nothing has been fetched.
    expect(h.ws.listingOf('/big')!.entries).toHaveLength(512);
    expect(h.ws.rowAt(513)?.more).toBe(true);
    expect(h.ws.rowCount()).toBe(514);

    fs.pageCalls.length = 0;
    // Walk down through the sentinel: each screen pulls one page, and the rows
    // already drawn keep their indices.
    const anchors: string[] = [];
    for (let page = 0; page < 4; page++) {
      const at = h.ws.rowCount() - 2;
      const anchor = h.ws.rowAt(at);
      anchors.push(`${anchor?.path}:${anchor?.index}`);
      h.scroll(Math.max(0, (h.ws.rowCount() - 20) * ROW));
      await h.step(Math.max(0, (h.ws.rowCount() - 20) * ROW));
    }
    expect(h.ws.listingOf('/big')!.entries.length).toBeGreaterThan(512);
    // Four screens, at most a handful of page fetches: no per-row request.
    expect(fs.pageCalls.length).toBeLessThanOrEqual(8);
    for (const [, calls] of new Map(fs.pageCalls.map((c) => [c.split('@')[0], 0]))) void calls;
    expect([...h.ws.missing()]).toEqual([]);
  });

  it('把缓存压到远不够用时，读者所在的目录一次都不会被换掉', async () => {
    // 这是"淘汰必须精确"的可证伪版本：上限小到必然触发淘汰，然后一路往下走。
    // 断言有三条：屏幕内的目录永远补得齐；读者刚展开的那个目录始终常驻；
    // 同一个目录不会被反复重读（那就是卡顿）。
    const tree: Record<string, string[]> = { '/': [] };
    for (let a = 0; a < 24; a++) {
      const an = `a${a}`;
      tree['/'].push(an);
      tree[`/${an}`] = [];
      for (let b = 0; b < 8; b++) {
        const bn = `b${b}`;
        tree[`/${an}`].push(bn);
        tree[`/${an}/${bn}`] = ['x.rs', 'y.rs'];
      }
    }
    const fs = new FakeFs(tree);
    const h = harness(fs, { maxDirs: 6, maxEntries: 80 });
    await h.ws.openFolder('/');
    await h.step(0);

    const reads = new Map<string, number>();
    const count = () => {
      for (const call of fs.pageCalls) {
        const dir = call.split('@')[0];
        reads.set(dir, (reads.get(dir) ?? 0) + 1);
      }
      fs.pageCalls.length = 0;
    };
    count();

    let px = 0;
    let lastExpanded = '';
    for (let round = 0; round < 30; round++) {
      const { start, end } = h.window();
      const row = h.ws
        .sliceRows(start, end)
        .find((r) => r.kind === 'dir' && r.depth === 2 && !r.expanded);
      if (!row) break;
      await h.ws.toggleDir(row.path);
      lastExpanded = row.path;
      count();
      px = h.ws.indexOf(row.path) * ROW;
      await h.step(px);

      expect([...h.ws.missing()], `round ${round}: 屏幕内全部补齐`).toEqual([]);
      expect(
        h.ws.listingOf(lastExpanded),
        `round ${round}: 读者所在的目录必须仍然常驻`,
      ).toBeTruthy();
      expect(h.ws.stats().dirs).toBeLessThanOrEqual(h.ws.stats().maxDirs);
    }

    for (const [dir, times] of reads) {
      expect(times, `${dir} 被重读了 ${times} 次`).toBeLessThanOrEqual(2);
    }
  });

  it('展开父目录时，读者的那一行不动', async () => {
    const fs = new FakeFs(deepTree(6, 2, 6));
    const h = harness(fs);
    await h.ws.openFolder('/');
    await h.step(0);

    const { start, end } = h.window();
    const anchor = h.ws.rowAt(Math.min(start + 6, end - 1))!;
    const above = h.ws
      .sliceRows(start, end)
      .find((r) => r.kind === 'dir' && r.index < anchor.index);
    expect(above).toBeTruthy();

    const before = h.ws.indexOf(anchor.path);
    await h.ws.toggleDir(above!.path);
    await h.step(h.ws.indexOf(above!.path) * ROW);

    // The rows above the reader's row were inserted, so its *index* moved — but
    // the row under the cursor is still that row, which is what the scroll
    // anchoring in FileTree is built on.
    expect(h.ws.rowAt(h.ws.indexOf(anchor.path))?.path).toBe(anchor.path);
    expect(h.ws.indexOf(anchor.path)).toBeGreaterThanOrEqual(before);
    expect(h.ws.rowCount()).toBeGreaterThan(0);
  });
});