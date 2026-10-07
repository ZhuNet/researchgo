/**
 * Tree-adjacent helpers that are still in use.
 *
 * The demo-seed era also lived here: a `Row` type duplicating the one in
 * `rowindex.ts` plus `buildRows`, which materialised every visible row on each
 * expand. Both are gone — the lazy index in `rowindex.ts` replaced them, and the
 * duplicate type only invited drift.
 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct === 0) return 1000 - t.length;
  if (direct > 0) return 700 - direct - t.length * 0.1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 12 + streak * 6 - Math.min(found - ti, 12);
    ti = found + 1;
  }
  return Math.max(1, score - t.length * 0.05);
}

export interface VirtualRange {
  start: number;
  end: number;
}

/**
 * Only the window bounds. The spacer heights used to live here too, which made
 * the scrollable height depend on two independently-derived numbers; when they
 * disagreed mid-update the browser clamped `scrollTop` and the tree jumped to the
 * top. Callers now size the scroll area from `total * itemH` and translate the
 * window instead.
 */
export function virtualRange(
  scrollTop: number,
  viewport: number,
  itemH: number,
  total: number,
  overscan = 12,
): VirtualRange {
  const visible = Math.ceil(viewport / itemH) + overscan * 2;
  // Clamp the start so the window can never invert or run past the end. When the
  // content briefly shrinks (a directory collapsing) the scroll offset can sit
  // beyond the last row for a frame; without this the slice came back empty and
  // the whole tree blanked out before the scroll position was restored.
  const maxStart = Math.max(0, total - visible);
  const start = Math.min(
    maxStart,
    Math.max(0, Math.floor(scrollTop / itemH) - overscan),
  );
  const end = Math.min(total, start + visible);
  return { start, end };
}

/**
 * Where the scroller has to sit for the anchored row to stay where the reader
 * left it.
 *
 * `scrollable` is the height the scroller can actually reach, which must be read
 * *after* the new content height is in the DOM (reading it forces layout). Two
 * rules, and they are the whole contract:
 *
 *  - Rows inserted above the anchor move it down, and the scroller follows. This
 *    is what makes expanding a folder above the viewport invisible instead of a
 *    jump.
 *  - When the content shrank past the anchor there is no position that satisfies
 *    it, so the honest answer is the furthest the scroller can go — clamped, not
 *    fought. A previous version re-asserted the write on the next frame, which
 *    could not tell a browser clamp from the reader scrolling away in between,
 *    and that is what made the scrollbar feel stuck.
 */
export function anchoredScrollTop(
  anchorIndex: number,
  anchorOffset: number,
  itemH: number,
  scrollable: number,
): number {
  const wanted = anchorIndex * itemH + anchorOffset;
  if (wanted <= 0) return 0;
  const max = Math.max(0, scrollable);
  return Math.min(wanted, max);
}
