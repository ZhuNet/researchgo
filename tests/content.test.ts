import { describe, expect, it } from 'vitest';

import { bytesOf, TextCache } from '../src/lib/textcache';
import { neighbourAfterClose, scrollToReveal, tabWindow, TAB_WIDTH } from '../src/lib/tabwindow';

describe('内容缓存：按字节，而不是按文件数', () => {
  it('字节上限才是真正的上限', () => {
    // A count limit would have let five 4 KB files and one 400 MB file through
    // with equal ease; the budget is what the process actually spends.
    const cache = new TextCache<string>({ maxBytes: 1000 });
    for (let i = 0; i < 6; i++) cache.put(`/f${i}`, 'x'.repeat(200), 200);
    expect(cache.bytes).toBeLessThanOrEqual(1000);
    expect(cache.has('/f0')).toBe(false);
    expect(cache.has('/f5')).toBe(true);
  });

  it('FIFO 顺序就是插入顺序', () => {
    const cache = new TextCache<string>({ maxBytes: 300 });
    cache.put('a', 'a', 100);
    cache.put('b', 'b', 100);
    cache.put('c', 'c', 100);
    cache.put('d', 'd', 100);
    // 'a' was the oldest so it goes first, and only as much as the budget needs.
    expect([...cache.keys()]).toEqual(['b', 'c', 'd']);
    expect(cache.bytes).toBe(300);
  });

  it('读一次不改变淘汰顺序', () => {
    const cache = new TextCache<string>({ maxBytes: 300 });
    cache.put('a', 'a', 100);
    cache.put('b', 'b', 100);
    cache.put('c', 'c', 100);
    cache.get('a');
    cache.get('a');
    cache.put('d', 'd', 100);
    // 'a' is still the oldest: peeking is not using it.
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('重新写入会把它挪到队尾', () => {
    const cache = new TextCache<string>({ maxBytes: 300 });
    cache.put('a', 'a', 100);
    cache.put('b', 'b', 100);
    cache.put('a', 'a2', 100);
    cache.put('c', 'c', 100);
    expect([...cache.keys()]).toEqual(['b', 'a', 'c']);
  });

  it('被淘汰后重新加入，不会被上一次留下的旧槽位提前挤掉', () => {
    // This is the bug a plain queue has: the stale entry for 'a' is still at the
    // head, so adding 'a' again finds its own tombstone and evicts it instantly.
    const cache = new TextCache<string>({ maxBytes: 200 });
    cache.put('a', 'a', 100);
    cache.put('b', 'b', 100);
    cache.put('c', 'c', 100);
    expect(cache.has('a')).toBe(false);

    cache.put('a', 'a', 100);
    cache.put('d', 'd', 100);
    expect(cache.has('a')).toBe(true);
    // Plain FIFO from here: 'c' was older than the re-added 'a'.
    expect([...cache.keys()]).toEqual(['a', 'd']);
  });

  it('活动文件被钉住，永远不会被淘汰', () => {
    const cache = new TextCache<string>({ maxBytes: 200 });
    cache.pin('active');
    cache.put('active', 'a'.repeat(150), 150);
    for (let i = 0; i < 6; i++) cache.put(`/f${i}`, 'x', 100);
    expect(cache.has('active')).toBe(true);
    // Everything else went instead.
    expect(cache.size).toBe(1);
  });

  it('钉住解除后立刻补上淘汰', () => {
    // A pinned buffer is allowed to sit over budget; the moment it is released
    // it is the first candidate, like any other.
    const cache = new TextCache<string>({ maxBytes: 150 });
    cache.pin('keep');
    cache.put('keep', 'k', 200);
    cache.put('a', 'a', 100);
    expect(cache.has('keep')).toBe(true);
    expect(cache.has('a')).toBe(false);
    cache.unpin('keep');
    expect(cache.has('keep')).toBe(false);
  });

  it('钉住队列头部不会挡住后面的淘汰', () => {
    // A queue that stops at the first pinned entry never sheds anything again,
    // and the cache grows without bound.
    const cache = new TextCache<string>({ maxBytes: 300 });
    cache.pin('a');
    cache.put('a', 'a', 100);
    cache.put('b', 'b', 100);
    cache.put('c', 'c', 100);
    cache.put('d', 'd', 100);
    cache.put('e', 'e', 100);
    expect(cache.has('a')).toBe(true);
    expect(cache.bytes).toBeLessThanOrEqual(300);
  });

  it('文件数上限和字节上限一起生效', () => {
    const cache = new TextCache<string>({ maxBytes: 1e9, maxEntries: 3 });
    for (let i = 0; i < 6; i++) cache.put(`/f${i}`, 'x', 1);
    expect(cache.size).toBe(3);
    expect([...cache.keys()]).toEqual(['/f3', '/f4', '/f5']);
  });

  it('就地替换不改变顺序，编辑中的文件不会因此被挪到队尾', () => {
    const cache = new TextCache<string>({ maxBytes: 400 });
    cache.put('a', 'a', 100);
    cache.put('b', 'b', 100);
    cache.put('c', 'c', 100);
    // The editor is typing into 'a': it grows, and must stay where it is.
    cache.replace('a', 'a'.repeat(200), 200);
    expect([...cache.keys()]).toEqual(['a', 'b', 'c']);
    expect(cache.bytes).toBe(400);
    // Order preserved, so eviction still follows insertion order rather than
    // letting a grown buffer dodge its turn.
    cache.put('d', 'd', 100);
    expect(cache.has('a')).toBe(false);
    expect([...cache.keys()]).toEqual(['b', 'c', 'd']);
  });

  it('超过预算的大文件，靠调用方钉住来保住', () => {
    // The cache cannot know which file is being looked at, so it is the caller's
    // job to pin it. Unpinned, a file bigger than the whole budget is dropped the
    // moment it lands and re-read on every scroll — so it must be pinned, and a
    // pinned entry survives being over budget.
    const cache = new TextCache<string>({ maxBytes: 100 });
    cache.put('huge', 'x'.repeat(5000), 5000);
    expect(cache.has('huge')).toBe(false);

    const pinned = new TextCache<string>({ maxBytes: 100 });
    pinned.pin('huge');
    pinned.put('huge', 'x'.repeat(5000), 5000);
    expect(pinned.has('huge')).toBe(true);
    pinned.put('other', 'y', 50);
    expect(pinned.has('huge')).toBe(true);
  });

  it('全部被钉住时不会原地打转', () => {
    // A queue that rotates pinned entries without ever dropping one loops
    // forever while over budget.
    const cache = new TextCache<string>({ maxBytes: 10 });
    for (const key of ['a', 'b', 'c']) cache.pin(key);
    for (const key of ['a', 'b', 'c']) cache.put(key, 'x', 100);
    expect(cache.size).toBe(3);
    expect(cache.pins().size).toBe(3);
  });

  it('预算报告：可以先问代价再决定要不要读', () => {
    const cache = new TextCache<string>({ maxBytes: 500 });
    cache.put('a', 'a', 100);
    cache.put('b', 'b', 100);
    cache.pin('active');
    cache.put('active', 'x', 50);
    // A 400 KB file here costs the other two buffers; the reader can say so.
    expect(cache.wouldEvict('/big.txt', 400)).toEqual(['a', 'b']);
    // But it never costs the file being looked at, or itself.
    expect(cache.wouldEvict('/active', 400)).not.toContain('/active');
  });

  it('字节估算和字符串长度同量级', () => {
    expect(bytesOf('')).toBe(0);
    expect(bytesOf('abcd')).toBe(8);
    expect(bytesOf('中文')).toBe(4);
  });
});

describe('Tab 窗口：横轴上的滑动窗口', () => {
  const W = TAB_WIDTH;

  it('窗口落在可见范围内，并带一点余量', () => {
    const win = tabWindow(1000, 0, 800);
    expect(win.start).toBe(0);
    expect(win.contentWidth).toBe(1000 * W);
    // 800 / 168 = 5 tabs, plus the one straddling the edge, plus overscan.
    expect(win.end).toBeLessThanOrEqual(10);
  });

  it('滚到中间，窗口跟着走，且窗口宽度不随总数变化', () => {
    const near = tabWindow(1000, 500 * W, 800);
    const far = tabWindow(100_000, 50_000 * W, 800);
    expect(near.start).toBe(500 - 2);
    expect(far.end - far.start).toBe(near.end - near.start);
    expect(far.start).toBe(50_000 - 2);
  });

  it('总数再大，渲染的标签数也是有界的', () => {
    for (const count of [1, 10, 1_000, 1_000_000]) {
      const win = tabWindow(count, 0, 800);
      expect(win.end - win.start).toBeLessThanOrEqual(12);
    }
  });

  it('标签比视口窄时，窗口不越界', () => {
    const win = tabWindow(2, 0, 800);
    expect(win.start).toBe(0);
    expect(win.end).toBe(2);
  });

  it('空列表不会产生负数下标', () => {
    expect(tabWindow(0, 120, 800)).toEqual({ start: 0, end: 0, contentWidth: 0 });
    expect(tabWindow(5, -40, 800).start).toBe(0);
    expect(tabWindow(5, 99999, 800).end).toBe(5);
  });

  it('关闭之后选中哪一个邻居，是可以确定的', () => {
    const tabs = ['a', 'b', 'c', 'd'];
    // Looking at the closed tab: the tab that took its place.
    expect(neighbourAfterClose(tabs, 'b', 'b')).toBe('c');
    expect(neighbourAfterClose(tabs, 'd', 'd')).toBe('c');
    // Looking at something before it: stay where you are, do not jump forward.
    expect(neighbourAfterClose(tabs, 'd', 'b')).toBe('b');
    // Last tab standing.
    expect(neighbourAfterClose(['only'], 'only', 'only')).toBeNull();
    // Closing something that is not open changes nothing.
    expect(neighbourAfterClose([], 'a', 'a')).toBe('a');
  });

  it('把某个标签带进视野，只移动必要的距离', () => {
    const viewport = 4 * W;
    const content = 100 * W;
    // Already visible: no movement at all.
    expect(scrollToReveal(2 * W, viewport, 2, content)).toBeNull();
    // Just past the right edge: nudged left by exactly its own width.
    expect(scrollToReveal(0, viewport, 5, content)).toBe(2 * W);
    // Before the left edge: scrolled back to put it at the left.
    expect(scrollToReveal(10 * W, viewport, 2, content)).toBe(2 * W);
  });

  it('带进视野不会越过可滚动的最大值', () => {
    const viewport = 4 * W;
    const content = 5 * W;
    expect(scrollToReveal(0, viewport, 4, content)).toBe(W);
  });
});