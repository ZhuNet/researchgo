import { describe, expect, it } from 'vitest';

import {
  applySidebarView,
  applyViewerPosition,
  captureSidebarView,
  captureViewerPosition,
  SIDEBAR_VIEW,
  type PdfViewerLike,
  type ViewerPosition,
  type ViewsManagerLike,
} from '../src/lib/pdfposition';

/**
 * The rebuild loop's promise: the preview reopens the new PDF where the reader
 * was, not at the top of page one.
 *
 * pdf.js resets page, zoom and scroll when a document is swapped, so the
 * position has to be taken before `open` and put back once the new pages
 * exist. These tests run that math against a fake viewer — the real one lives
 * inside an iframe and cannot be brought here.
 */

class FakeViewer implements PdfViewerLike {
  readonly pagesCount: number;
  private readonly pageHeight: number;
  private page_ = 1;
  private scale_: string | null = null;
  readonly container = { scrollTop: 0, scrollLeft: 0 };
  /** Every scale write, so "did not touch the zoom" is assertable. */
  readonly scaleWrites: (string | null)[] = [];

  constructor(pages: number, pageHeight: number) {
    this.pagesCount = pages;
    this.pageHeight = pageHeight;
  }

  get currentPageNumber() {
    return this.page_;
  }
  set currentPageNumber(v: number) {
    this.page_ = v;
  }

  get currentScaleValue() {
    return this.scale_;
  }
  set currentScaleValue(v: string | null) {
    this.scale_ = v;
    this.scaleWrites.push(v);
  }

  /** Puts the reader somewhere, without going through the setters. */
  setReading(page: number, scale: string | null, scrollTop: number): void {
    this.page_ = page;
    this.scale_ = scale;
    this.container.scrollTop = scrollTop;
  }

  pageTop(page: number): number {
    return (page - 1) * this.pageHeight;
  }

  getPageView(index: number) {
    if (index < 0 || index >= this.pagesCount) return undefined;
    return { div: { offsetTop: index * this.pageHeight, offsetLeft: 0 } };
  }
}

describe('重建后回到原处：位置先取后还', () => {
  it('捕获记录页码、缩放和页内偏移，而不是绝对滚动值', () => {
    const v = new FakeViewer(10, 800);
    v.setReading(3, '1.25', v.pageTop(3) + 400);
    const pos = captureViewerPosition(v);
    expect(pos.page).toBe(3);
    expect(pos.scale).toBe('1.25');
    // 400 是“第 3 页顶往下 400px”，与该页在文档里的绝对位置无关。
    expect(pos.offsetTop).toBe(400);
    expect(pos.offsetLeft).toBe(0);
  });

  it('恢复时按新页位置重算滚动，内容移位也回到原阅读点', () => {
    const before = new FakeViewer(10, 800);
    before.setReading(3, '1.25', before.pageTop(3) + 400);
    const pos = captureViewerPosition(before);

    // 重建后每页变高：第 3 页的顶从 1600 移到了 1800。
    const after = new FakeViewer(10, 900);
    after.setReading(1, 'page-width', 0);
    applyViewerPosition(after, pos);

    expect(after.currentPageNumber).toBe(3);
    expect(after.currentScaleValue).toBe('1.25');
    expect(after.container.scrollTop).toBe(after.pageTop(3) + 400);
  });

  it('恢复时把缩放一并还原：重建后仍是读者选定的倍数', () => {
    const before = new FakeViewer(10, 800);
    before.setReading(4, '1.25', before.pageTop(4) + 60);
    const pos = captureViewerPosition(before);

    // open() 之后 pdf.js 会把缩放重置成它自己的默认值（如 "auto"）。
    const after = new FakeViewer(10, 800);
    after.setReading(1, 'auto', 0);
    applyViewerPosition(after, pos);

    expect(after.currentScaleValue).toBe('1.25');
    expect(after.scaleWrites).toEqual(['1.25']);
  });

  it('恢复时预设缩放（如 page-width）也一并还原', () => {
    const before = new FakeViewer(10, 800);
    before.setReading(2, 'page-width', before.pageTop(2) + 10);
    const pos = captureViewerPosition(before);

    const after = new FakeViewer(10, 800);
    after.setReading(1, 'auto', 0);
    applyViewerPosition(after, pos);

    expect(after.currentScaleValue).toBe('page-width');
  });

  it('页码超出新文档时夹到最后一页', () => {
    const before = new FakeViewer(12, 800);
    before.setReading(12, null, before.pageTop(12) + 100);
    const pos = captureViewerPosition(before);

    const after = new FakeViewer(8, 800);
    applyViewerPosition(after, pos);

    expect(after.currentPageNumber).toBe(8);
    expect(after.container.scrollTop).toBe(after.pageTop(8) + 100);
  });

  it('缩放未知时不碰缩放', () => {
    const before = new FakeViewer(10, 800);
    before.setReading(2, null, before.pageTop(2) + 10);
    const pos = captureViewerPosition(before);

    const after = new FakeViewer(10, 800);
    after.setReading(1, 'page-width', 0);
    applyViewerPosition(after, pos);

    expect(after.currentScaleValue).toBe('page-width');
    expect(after.scaleWrites).toEqual([]);
  });

  it('没有页面视图时，捕获退化为绝对偏移（首次打开前的安全态）', () => {
    const v = new FakeViewer(0, 800);
    const pos = captureViewerPosition(v);
    expect(pos.page).toBe(1);
    expect(pos.offsetTop).toBe(0);
  });

  it('新文档还没有页面时不写任何状态', () => {
    const after = new FakeViewer(0, 800);
    after.setReading(1, 'page-width', 0);
    const pos: ViewerPosition = { page: 3, scale: '1.25', offsetTop: 400, offsetLeft: 0 };
    applyViewerPosition(after, pos);
    expect(after.currentPageNumber).toBe(1);
    expect(after.currentScaleValue).toBe('page-width');
    expect(after.container.scrollTop).toBe(0);
  });
});

/**
 * The sidebar, faked with pdf.js's own semantics: NONE closes it, a view
 * becomes active, and forceOpen opens it. pdf.js's `reset()` — which runs on
 * every document swap — puts the active view back to thumbnails, and a PDF's
 * own /PageMode can open the sidebar outright; both are what the restore has
 * to win over.
 */
class FakeViewsManager implements ViewsManagerLike {
  private open_ = false;
  private active_: number = SIDEBAR_VIEW.THUMBS;
  readonly calls: string[] = [];

  get visibleView() {
    return this.open_ ? this.active_ : SIDEBAR_VIEW.NONE;
  }

  switchView(view: number, forceOpen = false): void {
    this.calls.push(`switch:${view}:${forceOpen}`);
    if (view === SIDEBAR_VIEW.NONE) {
      if (this.open_) this.close();
      return;
    }
    this.active_ = view;
    if (forceOpen && !this.open_) this.open_ = true;
  }

  close(): void {
    this.calls.push('close');
    this.open_ = false;
  }

  /** Test setup: put the sidebar somewhere without recording calls. */
  setView(open: boolean, view: number): void {
    this.open_ = open;
    this.active_ = view;
  }
}

describe('侧边栏：重建后开着的还是开着的', () => {
  it('捕获：开着大纲记为 OUTLINE，关着记为 NONE', () => {
    const open = new FakeViewsManager();
    open.setView(true, SIDEBAR_VIEW.OUTLINE);
    expect(captureSidebarView(open)).toBe(SIDEBAR_VIEW.OUTLINE);

    const closed = new FakeViewsManager();
    closed.setView(false, SIDEBAR_VIEW.OUTLINE);
    expect(captureSidebarView(closed)).toBe(SIDEBAR_VIEW.NONE);
  });

  it('恢复：重建把视图重置成缩略图后，仍开回大纲', () => {
    const before = new FakeViewsManager();
    before.setView(true, SIDEBAR_VIEW.OUTLINE);
    const view = captureSidebarView(before);

    // pdf.js 的 reset() 会把 active 重置为缩略图。
    const after = new FakeViewsManager();
    after.setView(true, SIDEBAR_VIEW.THUMBS);
    applySidebarView(after, view);

    expect(after.visibleView).toBe(SIDEBAR_VIEW.OUTLINE);
  });

  it('恢复：关着的，重建后即使被 /PageMode 打开也关回去', () => {
    const before = new FakeViewsManager();
    before.setView(false, SIDEBAR_VIEW.OUTLINE);
    const view = captureSidebarView(before);

    // PDF 自己的 /PageMode 会在加载时把侧边栏打开。
    const after = new FakeViewsManager();
    after.setView(true, SIDEBAR_VIEW.OUTLINE);
    applySidebarView(after, view);

    expect(after.visibleView).toBe(SIDEBAR_VIEW.NONE);
  });

  it('恢复：开着缩略图的回到缩略图', () => {
    const before = new FakeViewsManager();
    before.setView(true, SIDEBAR_VIEW.THUMBS);
    const view = captureSidebarView(before);

    const after = new FakeViewsManager();
    after.setView(false, SIDEBAR_VIEW.THUMBS);
    applySidebarView(after, view);

    expect(after.visibleView).toBe(SIDEBAR_VIEW.THUMBS);
  });
});
