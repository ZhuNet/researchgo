import { describe, expect, it } from 'vitest';

import { DirCache } from '../src/lib/dircache';
import { anchoredScrollTop, virtualRange } from '../src/lib/tree';
import {
  RowIndex,
  ancestorsOf,
  basenameOf,
  joinPath,
  moveTargetOf,
  parentOf,
  type DirView,
} from '../src/lib/rowindex';
import type { DirEntry, DirPage } from '../src/lib/backend';

const file = (path: string): DirEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'file',
});

const dirEntry = (path: string): DirEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind: 'dir',
});

const files = (dir: string, n: number): DirEntry[] =>
  Array.from({ length: n }, (_, i) => file(`${dir}/f${i}.rs`));

const dirsIn = (dir: string, n: number): DirEntry[] =>
  Array.from({ length: n }, (_, i) => dirEntry(`${dir}/d${i}`));

/** The shape the row index consumes: a resident prefix plus what is still out there. */
function viewOf(cache: DirCache) {
  return (dir: string): DirView | undefined => {
    const listing = cache.listing(dir);
    if (!listing) return undefined;
    return { entries: listing.entries, total: listing.total, complete: listing.complete };
  };
}

function page(dir: string, entries: DirEntry[], offset = 0): DirPage {
  const files = entries.filter((e) => e.kind === 'file').length;
  return {
    dir,
    offset,
    entries,
    total: entries.length,
    files,
    dirs: entries.length - files,
    hasMore: false,
  };
}

describe('DirCache', () => {
  it('存取与计数', () => {
    const cache = new DirCache();
    cache.set('/a', [file('/a/x')]);
    expect(cache.has('/a')).toBe(true);
    expect(cache.get('/a')).toHaveLength(1);
    expect(cache.stats()).toMatchObject({ dirs: 1, entries: 1 });
  });

  it('重复 set 不会重复计数', () => {
    const cache = new DirCache();
    cache.set('/a', [file('/a/x'), file('/a/y')]);
    cache.set('/a', [file('/a/x')]);
    expect(cache.stats().entries).toBe(1);
  });

  it('protect 保护的目录不会被淘汰', () => {
    const cache = new DirCache({ maxDirs: 3, maxEntries: 1000 });
    cache.protect(['/keep']);
    cache.set('/keep', [file('/keep/a')]);
    for (let i = 0; i < 20; i++) cache.set(`/d${i}`, [file(`/d${i}/a`)]);
    expect(cache.has('/keep')).toBe(true);
  });

  it('未 pin 的目录超出上限时被淘汰', () => {
    const cache = new DirCache({ maxDirs: 5, maxEntries: 1000 });
    for (let i = 0; i < 50; i++) cache.set(`/d${i}`, [file(`/d${i}/a`)]);
    expect(cache.size).toBeLessThanOrEqual(5);
    expect(cache.has('/d49')).toBe(true);
    expect(cache.has('/d0')).toBe(false);
  });

  it('按条目数上限淘汰', () => {
    const cache = new DirCache({ maxDirs: 1000, maxEntries: 50 });
    for (let i = 0; i < 20; i++) cache.set(`/d${i}`, files(`/d${i}`, 10));
    expect(cache.stats().entries).toBeLessThanOrEqual(50);
  });

  it('移出 protect 集合后可以被淘汰', () => {
    const cache = new DirCache({ maxDirs: 2, maxEntries: 1000 });
    cache.protect(['/a']);
    cache.set('/a', [file('/a/x')]);
    cache.protect([]);
    cache.set('/b', [file('/b/x')]);
    cache.set('/c', [file('/c/x')]);
    expect(cache.has('/a')).toBe(false);
  });

  it('上限对任何目录都成立，展开过的目录没有豁免', () => {
    // "无限项目树"的核心保证：内存上限不留后门。
    const cache = new DirCache({ maxDirs: 4, maxEntries: 1000 });
    cache.set('/root', dirsIn('/root', 40));
    for (let i = 0; i < 40; i++) cache.set(`/root/d${i}`, [file(`/root/d${i}/x`)]);
    expect(cache.size).toBeLessThanOrEqual(4);
  });

  it('clear 清空一切', () => {
    const cache = new DirCache();
    cache.protect(['/a']);
    cache.set('/a', [file('/a/x')]);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.entryCount).toBe(0);
  });

  it('淘汰按进入顺序，而不是按最近访问', () => {
    // LRU 会让"一直有人看的目录"永远留在内存里，那正是无限树的反面。
    const cache = new DirCache({ maxDirs: 3, maxEntries: 1000 });
    cache.set('/a', [file('/a/x')]);
    cache.set('/b', [file('/b/x')]);
    cache.set('/c', [file('/c/x')]);
    cache.get('/a');
    cache.get('/a');
    cache.set('/d', [file('/d/x')]);
    expect(cache.has('/a')).toBe(false);
    expect(cache.has('/d')).toBe(true);
  });

  it('删除后重新载入的目录不会被旧槽位提前淘汰', () => {
    // 队列里留着 /a 的旧槽位（它是同一个路径，但现在指向新的一次载入）。
    // 按槽位淘汰而不核对序列号的话，活着的 /a 会被自己最早的那一格挤掉 ——
    // 读者脚下的目录就此消失，行退化成 pending，然后反复重读。
    const cache = new DirCache({ maxDirs: 2, maxEntries: 1000 });
    cache.set('/a', [file('/a/1')]);
    cache.set('/b', [file('/b/1')]);
    cache.delete('/a');
    cache.set('/a', [file('/a/1')]);
    cache.set('/c', [file('/c/1')]);
    expect(cache.has('/a')).toBe(true);
    expect(cache.has('/b')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('分页：只常驻已取回的前缀，total 说明还有多少', () => {
    const cache = new DirCache();
    cache.seed('/big', {
      dir: '/big',
      offset: 0,
      entries: files('/big', 512),
      total: 1_000_000,
      files: 1_000_000,
      dirs: 0,
      hasMore: true,
    });
    const listing = cache.listing('/big')!;
    expect(listing.entries).toHaveLength(512);
    expect(listing.total).toBe(1_000_000);
    expect(listing.complete).toBe(false);
    expect(cache.stats().entries).toBe(512);
  });

  it('分页：追加只接在已取回的前缀后面', () => {
    const cache = new DirCache();
    cache.seed('/big', {
      dir: '/big',
      offset: 0,
      entries: files('/big', 2),
      total: 4,
      files: 4,
      dirs: 0,
      hasMore: true,
    });
    cache.append('/big', {
      dir: '/big',
      offset: 2,
      entries: files('/big', 2).map((e) => ({ ...e, path: `/big/x${e.name}` })),
      total: 4,
      files: 4,
      dirs: 0,
      hasMore: false,
    });
    const listing = cache.listing('/big')!;
    expect(listing.entries).toHaveLength(4);
    expect(listing.complete).toBe(true);
  });

  it('分页错位时整段替换，而不是拼到错误的位置', () => {
    const cache = new DirCache();
    cache.seed('/x', { ...page('/x', files('/x', 2)) });
    cache.append('/x', {
      dir: '/x',
      offset: 99,
      entries: [file('/x/f9.rs')],
      total: 3,
      files: 3,
      dirs: 0,
      hasMore: false,
    });
    expect(cache.get('/x')!.map((e) => e.path)).toEqual(['/x/f9.rs']);
    expect(cache.listing('/x')!.total).toBe(3);
  });

  it('磁盘新建的行插入到排序位置，且计数不变式成立', () => {
    const cache = new DirCache();
    cache.set('/r', [dirEntry('/r/b'), file('/r/x.rs')]);
    cache.patchCreate('/r', 'a', 'dir');
    cache.patchCreate('/r', 'y.rs', 'file');
    expect(cache.get('/r')!.map((e) => e.name)).toEqual(['a', 'b', 'x.rs', 'y.rs']);
    expect(cache.listing('/r')!.total).toBe(4);
    expect(cache.listing('/r')!.dirs).toBe(2);
    expect(cache.listing('/r')!.files).toBe(2);
    expect(cache.stats().entries).toBe(4);
  });

  it('排序位置落在已取回范围之外时只增加 total', () => {
    // 前缀之外的行不能插进来：它是别人尚未请求的那一页的索引。
    const cache = new DirCache();
    cache.seed('/big', {
      dir: '/big',
      offset: 0,
      entries: files('/big', 2),
      total: 10,
      files: 10,
      dirs: 0,
      hasMore: true,
    });
    cache.patchCreate('/big', 'zzz.rs', 'file');
    expect(cache.get('/big')).toHaveLength(2);
    expect(cache.listing('/big')!.total).toBe(11);
  });

  it('磁盘删除的行连同计数一起消失', () => {
    const cache = new DirCache();
    cache.seed('/r', {
      dir: '/r',
      offset: 0,
      entries: [dirEntry('/r/b'), file('/r/x.rs')],
      total: 3,
      files: 2,
      dirs: 1,
      hasMore: true,
    });
    cache.patchRemove('/r', 'b');
    let listing = cache.listing('/r')!;
    expect(listing.entries.map((e) => e.name)).toEqual(['x.rs']);
    expect(listing.total).toBe(2);
    expect(listing.files).toBe(2); // 删掉的是目录，文件数不动
    expect(listing.dirs).toBe(0);
    expect(cache.stats().entries).toBe(1);

    // 落在已取回范围之外的删除同样要让总数跟上，否则末尾会永远差一个。
    cache.patchRemove('/r', 'zzz.rs');
    listing = cache.listing('/r')!;
    expect(listing.total).toBe(1);
    expect(listing.complete).toBe(true);
  });

  it('重命名到已取回范围之外时，常驻计数仍然守恒', () => {
    const cache = new DirCache();
    cache.seed('/r', {
      dir: '/r',
      offset: 0,
      entries: [file('/r/a.rs'), file('/r/b.rs')],
      total: 4,
      files: 4,
      dirs: 0,
      hasMore: true,
    });
    // zzz.rs 落在常驻前缀之外，只能丢掉旧行、留给下一页。
    cache.patchRename('/r', 'a.rs', file('/r/zzz.rs'));
    expect(cache.get('/r')!.map((e) => e.name)).toEqual(['b.rs']);
    expect(cache.stats().entries).toBe(1);
    expect(cache.listing('/r')!.total).toBe(4);
  });

  it('重命名就地换名，并把目录标记为需要核对', () => {
    const cache = new DirCache();
    cache.set('/r', [file('/r/a.rs'), file('/r/b.rs')]);
    cache.patchRename('/r', 'a.rs', file('/r/z.rs'));
    expect(cache.get('/r')!.map((e) => e.name)).toEqual(['b.rs', 'z.rs']);
    expect(cache.listing('/r')!.stale).toBe(true);
    expect(cache.listing('/r')!.total).toBe(2);
  });
});

describe('RowIndex', () => {
  function build() {
    const cache = new DirCache();
    cache.set('/r', [dirEntry('/r/src'), dirEntry('/r/docs'), file('/r/top.md')]);
    cache.set('/r/src', files('/r/src', 3));
    cache.set('/r/docs', files('/r/docs', 2));
    return { cache, lookup: viewOf(cache) };
  }

  it('未展开时只列出根的子项', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(), lookup);
    expect(index.length).toBe(3);
    expect(index.rowAt(0)?.path).toBe('/r/src');
  });

  it('展开后子项行号紧跟父行', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(['/r/src']), lookup);
    expect(index.length).toBe(3 + 3);
    expect(index.rowAt(1)?.path).toBe('/r/src/f0.rs');
    expect(index.rowAt(3)?.path).toBe('/r/src/f2.rs');
    expect(index.rowAt(4)?.path).toBe('/r/docs');
  });

  it('多个展开目录的行号连续', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(['/r/src', '/r/docs']), lookup);
    expect(index.length).toBe(3 + 3 + 2);
    expect(index.rowAt(5)?.path).toBe('/r/docs/f0.rs');
    expect(index.rowAt(7)?.path).toBe('/r/top.md');
  });

  it('深度信息正确', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(['/r/src']), lookup);
    expect(index.rowAt(0)?.depth).toBe(1);
    expect(index.rowAt(1)?.depth).toBe(2);
  });

  it('slice 只取窗口内的行', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(['/r/src']), lookup);
    expect(index.slice(1, 3).map((r) => r.path)).toEqual(['/r/src/f0.rs', '/r/src/f1.rs']);
  });

  it('越界返回 undefined', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(), lookup);
    expect(index.rowAt(-1)).toBeUndefined();
    expect(index.rowAt(3)).toBeUndefined();
  });

  it('indexOf 能反查行号', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(['/r/src', '/r/docs']), lookup);
    expect(index.indexOf('/r/src/f1.rs')).toBe(2);
    expect(index.indexOf('/r/top.md')).toBe(7);
    expect(index.indexOf('/r/nope')).toBe(-1);
  });

  it('未加载的子目录视为叶子（懒加载）', () => {
    const cache = new DirCache();
    cache.set('/r', [dirEntry('/r/lazy')]);
    const index = new RowIndex('/r', new Set(['/r/lazy']), viewOf(cache));
    expect(index.length).toBe(1);
    expect(index.rowAt(0)?.pending).toBe(true);
  });

  it('expandedDirs 给出需要监听watcher 的目录', () => {
    const { lookup } = build();
    const index = new RowIndex('/r', new Set(['/r/src']), lookup);
    expect(index.expandedDirs()).toEqual(['/r', '/r/src']);
  });

  it('百万行规模下索引本身很小', () => {
    const cache = new DirCache({ maxDirs: 5000, maxEntries: 2_000_000 });
    // 视口保护现在按窗口计算，这里把全部目录标为在屏，等价于"用户全展开着"。
    cache.protect(
      Array.from({ length: 101 }, (_, i) => (i === 0 ? '/r' : `/r/d${i - 1}`)),
    );
    cache.set('/r', dirsIn('/r', 100));
    const expanded = new Set<string>();
    for (let i = 0; i < 100; i++) {
      cache.set(`/r/d${i}`, files(`/r/d${i}`, 10_000));
      expanded.add(`/r/d${i}`);
    }
    const before = process.memoryUsage().heapUsed;
    const index = new RowIndex('/r', expanded, viewOf(cache));
    const after = process.memoryUsage().heapUsed;
    expect(index.length).toBe(100 + 100 * 10_000);
    expect(after - before).toBeLessThan(2 * 1024 * 1024);
    expect(index.rowAt(1_000_000)?.path).toBe('/r/d99/f9900.rs');
  });

  it('同一路径复用同一 Row 对象，同时字段保持最新', () => {
    // 两个曾经互相打架的要求：对象必须复用，否则 <For> 全量重建 → 闪烁；
    // 字段必须同步，否则展开后三角不刷新。缺任何一半都会出可见故障。
    const cache = new DirCache();
    const shared = new Map();
    cache.set('/r', [dirEntry('/r/a'), dirEntry('/r/b')]);

    const first = new RowIndex('/r', new Set<string>(), viewOf(cache), shared);
    const rowA = first.rowAt(0)!;
    expect(first.rowAt(0)).toBe(rowA);

    const second = new RowIndex('/r', new Set(['/r/a']), viewOf(cache), shared);
    expect(second.rowAt(0)).toBe(rowA); // 身份复用
    expect(rowA.expanded).toBe(true); // 状态最新
  });

  it('被淘汰的展开目录降级为 pending 单行，不会让行号错位', () => {
    // 上限之内：/r 和 /r/loaded 常驻，/r/gone 被淘汰。
    const cache = new DirCache({ maxDirs: 2, maxEntries: 1000 });
    cache.protect(['/r']);
    cache.set('/r', [dirEntry('/r/loaded'), dirEntry('/r/gone'), file('/r/f.txt')]);
    cache.protect(['/r', '/r/loaded']);
    cache.set('/r/loaded', files('/r/loaded', 3));
    const expanded = new Set(['/r', '/r/loaded', '/r/gone']);
    const index = new RowIndex('/r', expanded, viewOf(cache));

    expect(cache.has('/r/gone')).toBe(false);
    const paths = Array.from({ length: index.length }, (_, i) => index.rowAt(i)?.path);
    // gone 仍在展开集合里，但条目被淘汰 → 只占一行，且标记 pending。
    expect(paths).toEqual([
      '/r/loaded',
      '/r/loaded/f0.rs',
      '/r/loaded/f1.rs',
      '/r/loaded/f2.rs',
      '/r/gone',
      '/r/f.txt',
    ]);
    expect(index.rowAt(4)?.pending).toBe(true);
    expect(index.rowAt(1)?.pending).toBe(false);
  });

  it('未取完的目录在已取回的行之后多出一行哨兵', () => {
    const cache = new DirCache();
    cache.seed('/r', {
      dir: '/r',
      offset: 0,
      entries: files('/r', 3),
      total: 1_000_000,
      files: 1_000_000,
      dirs: 0,
      hasMore: true,
    });
    const index = new RowIndex('/r', new Set(['/r']), viewOf(cache));
    // 行空间只包含"已经存在的行"，高度不按 total 虚报。
    expect(index.length).toBe(4);
    const sentinel = index.rowAt(3);
    expect(sentinel?.more).toBe(true);
    expect(sentinel?.path).toBe('/r');
    expect(sentinel?.moreCount).toBe(1_000_000 - 3);
  });

  it('载入下一页只追加在哨兵之后，已有的行号一个都不动', () => {
    // 这是"滚动时不跳条"的地基：append 只能长在下面。
    const cache = new DirCache();
    const total = 9;
    const seed = (from: number, count: number): DirPage => ({
      dir: '/r',
      offset: from,
      entries: files('/r', total).slice(from, from + count),
      total,
      files: total,
      dirs: 0,
      hasMore: from + count < total,
    });
    cache.seed('/r', seed(0, 3));
    const expanded = new Set(['/r']);
    const before = new RowIndex('/r', expanded, viewOf(cache));
    const pathsBefore = Array.from({ length: before.length }, (_, i) => before.rowAt(i)?.path);
    const indicesBefore = pathsBefore.map((p) => before.indexOf(p as string));

    cache.append('/r', seed(3, 3));
    const middle = new RowIndex('/r', expanded, viewOf(cache));
    const pathsMiddle = Array.from({ length: middle.length }, (_, i) => middle.rowAt(i)?.path);
    // 哨兵自己被推到下面去了，读者正在看的那几行一个都没动。
    expect(pathsMiddle.slice(0, 3)).toEqual(pathsBefore.slice(0, 3));
    expect(indicesBefore.slice(0, 3)).toEqual([0, 1, 2]);
    expect(pathsMiddle[3]).toBe('/r/f3.rs');
    expect(middle.rowAt(6)?.more).toBe(true);

    cache.append('/r', seed(6, 3));
    const after = new RowIndex('/r', expanded, viewOf(cache));
    expect(after.length).toBe(total); // 取完了，哨兵消失
    expect(Array.from({ length: after.length }, (_, i) => after.rowAt(i)?.more).some(Boolean)).toBe(
      false,
    );
    const pathsAfter = Array.from({ length: after.length }, (_, i) => after.rowAt(i)?.path);
    expect(pathsAfter.slice(0, 6)).toEqual(pathsMiddle.slice(0, 6));
  });

  it('哨兵行不属于任何条目，因此不能被当成目录展开', () => {
    const cache = new DirCache();
    cache.seed('/r', {
      dir: '/r',
      offset: 0,
      entries: [dirEntry('/r/sub')],
      total: 2,
      files: 1,
      dirs: 1,
      hasMore: true,
    });
    cache.set('/r/sub', files('/r/sub', 1));
    const index = new RowIndex('/r', new Set(['/r', '/r/sub']), viewOf(cache));
    expect(index.rowAt(1)?.path).toBe('/r/sub/f0.rs');
    expect(index.rowAt(2)?.more).toBe(true);
    // 哨兵指向的是自己的目录，点它加载的是 /r 的下一页。
    expect(index.rowAt(2)?.path).toBe('/r');
    expect(index.expandedDirs()).toEqual(['/r', '/r/sub']);
  });
});

describe('路径工具', () => {
  it('parentOf', () => {
    expect(parentOf('/a/b/c.txt', '/a')).toBe('/a/b');
    expect(parentOf('/a.txt', '/a')).toBe('/a');
    expect(parentOf('/a', '/a')).toBeUndefined();
  });

  it('ancestorsOf 由近到远', () => {
    expect(ancestorsOf('/a/b/c/d.txt', '/a')).toEqual(['/a/b/c', '/a/b', '/a']);
    expect(ancestorsOf('/a.txt', '/a')).toEqual(['/a']);
  });

  it('basenameOf', () => {
    expect(basenameOf('/a/b/c.rs', '/a')).toBe('c.rs');
    expect(basenameOf('/a', '/a')).toBe('/a');
  });

  it('joinPath', () => {
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(joinPath('/', 'b')).toBe('/b');
  });
});

describe('虚拟窗口', () => {
  it('只返回窗口边界，高度由调用方按 total * itemH 决定', () => {
    // 曾经 padTop/padBottom 也在这里算，两份高度各自推导、更新不同步，
    // 浏览器就会夹紧 scrollTop 把树弹回顶部。现在高度只有一个来源。
    const range = virtualRange(480, 400, 24, 1000, 20);
    expect(range.start).toBe(0); // 480/24=20，减 overscan 20 → 0
    expect(range.end).toBe(Math.ceil(400 / 24) + 40);
    expect(Object.keys(range).sort()).toEqual(['end', 'start']);
  });

  it('窗口随滚动前移，且不越界', () => {
    expect(virtualRange(2400, 400, 24, 1000, 20).start).toBe(80);
    const atEnd = virtualRange(999999, 400, 24, 50, 20);
    expect(atEnd.end).toBe(50);
    expect(atEnd.start).toBeLessThanOrEqual(50);
  });

  it('总行数为 0 时窗口为空', () => {
    expect(virtualRange(0, 400, 24, 0, 20)).toEqual({ start: 0, end: 0 });
  });
});
describe('锚点滚动：精确而不是含糊', () => {
  const H = 24;

  it('上方插入多少行，滚动位置就跟着走多少', () => {
    // 展开读者上方的一个目录：那一行必须原地不动。
    const before = anchoredScrollTop(100, 7, H, 100_000);
    expect(before).toBe(100 * H + 7);
    expect(anchoredScrollTop(103, 7, H, 100_000)).toBe(before + 3 * H);
    // 折叠回去，一分不差地回来。
    expect(anchoredScrollTop(100, 7, H, 100_000)).toBe(before);
  });

  it('内容缩到锚点之上时停在能停的最远处，而不是反复去够一个够不到的位置', () => {
    // 可视高度不足：诚实的答案是夹紧，并且这个位置会被记录成新的锚点。
    expect(anchoredScrollTop(100, 7, H, 40 * H)).toBe(40 * H);
    expect(anchoredScrollTop(100, 7, H, 0)).toBe(0);
    expect(anchoredScrollTop(100, -9999, H, 0)).toBe(0);
  });

  it('行内偏移原样保留，不会被取整', () => {
    for (const offset of [0, 0.5, 7, 23.5]) {
      expect(anchoredScrollTop(10, offset, H, 100_000)).toBe(10 * H + offset);
    }
  });
});

describe('拖拽移动的目标判定', () => {
  const hit = (path: string | null, kind: 'dir' | 'file' = 'dir') => ({ path, kind });

  it('文件行代表它所在的目录', () => {
    expect(moveTargetOf('/README.md', '/', hit('/docs/guide.md', 'file'))).toBe('/docs');
    expect(moveTargetOf('/a/f.md', '/', hit('/b.md', 'file'))).toBe('/');
  });

  it('同级（自己的父目录）是 no-op，保持无效', () => {
    expect(moveTargetOf('/a/f.md', '/', hit('/a'))).toBeNull();
    expect(moveTargetOf('/a/f.md', '/', hit('/a/b.md', 'file'))).toBeNull();
    expect(moveTargetOf('/f.md', '/', hit(null))).toBeNull();
  });

  it('同级、上级与其它分支的文件夹都是有效目标', () => {
    expect(moveTargetOf('/a/f.md', '/', hit('/a/b'))).toBe('/a/b');
    expect(moveTargetOf('/a/b/f.md', '/', hit('/a'))).toBe('/a');
    expect(moveTargetOf('/a/f.md', '/', hit('/c/d'))).toBe('/c/d');
  });

  it('自己和子孙目录不可作为目标', () => {
    expect(moveTargetOf('/a', '/', hit('/a'))).toBeNull();
    expect(moveTargetOf('/a', '/', hit('/a/b'))).toBeNull();
    expect(moveTargetOf('/a', '/', hit('/a/b/x.md', 'file'))).toBeNull();
  });

  it('空白区域指根目录', () => {
    expect(moveTargetOf('/a/f.md', '/', hit(null))).toBe('/');
  });

  it('树外一律无效', () => {
    expect(moveTargetOf('/a/f.md', '/', null)).toBeNull();
  });
});
