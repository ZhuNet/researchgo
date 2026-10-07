/**
 * The tab strip as a sliding window over an unbounded list.
 *
 * Tabs are cheap to hold in an array and expensive to hold as DOM: a few thousand
 * mounted buttons is a frozen window, and the point of an unbounded tab list is
 * that people do end up with a few thousand. So the list stays complete and the
 * DOM becomes a window into it, scrolled horizontally — the same arrangement as
 * the file tree's rows, on the other axis.
 *
 * Tab width is fixed rather than measured. A window needs to know where tab 4,000
 * is before tab 4,000 is mounted, and per-tab widths taken from layout would
 * mean measuring everything, which is the thing being avoided.
 */

export const TAB_WIDTH = 168;

/** Tabs rendered on each side of the window, so a scroll does not outrun them. */
export const OVERSCAN = 2;

export interface TabWindow {
  /** First tab index rendered. */
  start: number;
  /** Exclusive end index. */
  end: number;
  /** Total width of the strip, so the scrollbar spans every tab. */
  contentWidth: number;
}

export function tabWindow(
  count: number,
  scrollLeft: number,
  viewportWidth: number,
  width = TAB_WIDTH,
  overscan = OVERSCAN,
): TabWindow {
  const contentWidth = count * width;
  if (count <= 0 || viewportWidth <= 0) return { start: 0, end: 0, contentWidth: 0 };

  // Clamped because a strip can be shorter than the viewport (two tabs on a wide
  // window), and a negative scrollLeft would otherwise produce a negative index.
  const at = Math.max(0, Math.min(scrollLeft, Math.max(0, contentWidth - viewportWidth)));
  const firstVisible = Math.floor(at / width);
  const visible = Math.ceil(viewportWidth / width) + 1;
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, firstVisible + visible + overscan);
  return { start, end, contentWidth };
}

/**
 * Which tab to bring back into view after `to` is closed.
 *
 * The neighbour is the tab that used to sit next to it, and which one that is
 * depends on whether the reader was looking at the closed tab or at something
 * before it — the same rule every tab strip uses, and the reason closing the last
 * visible tab leaves the strip where the reader was instead of jumping to the top.
 */
export function neighbourAfterClose(
  tabs: readonly string[],
  closing: string,
  active: string | null,
): string | null {
  const index = tabs.indexOf(closing);
  if (index < 0) return active;
  const next = tabs.filter((p) => p !== closing);
  if (!active || active === closing) {
    return next[Math.min(index, next.length - 1)] ?? null;
  }
  return active;
}

/**
 * Scroll position that keeps a tab visible, or `null` when it already is.
 *
 * Only the smallest movement that brings it fully into view is returned: pulling
 * a nearly-visible tab to the middle of the strip is the kind of motion that
 * makes a tab bar feel like it is taking over.
 */
export function scrollToReveal(
  scrollLeft: number,
  viewportWidth: number,
  index: number,
  contentWidth: number,
  width = TAB_WIDTH,
  margin = 0,
): number | null {
  const left = index * width;
  const right = left + width;
  const max = Math.max(0, contentWidth - viewportWidth);
  let next = scrollLeft;
  if (left - margin < scrollLeft) next = Math.max(0, left - margin);
  else if (right + margin > scrollLeft + viewportWidth) {
    next = Math.min(max, right + margin - viewportWidth);
  }
  next = Math.max(0, Math.min(max, next));
  return next === scrollLeft ? null : next;
}