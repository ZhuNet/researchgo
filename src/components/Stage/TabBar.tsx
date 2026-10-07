import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';

import { Icon, LANG_COLOR } from '../Icon';
import { fileIconLang } from '../../lib/fs';
import { scrollToReveal, tabWindow, TAB_WIDTH } from '../../lib/tabwindow';
import { copyText, openMenu } from '../../store/ui';
import type { Workspace } from '../../store/workspace';

/**
 * The tab strip is a window into an unbounded list.
 *
 * Tabs themselves stay in one array — that is the model, and closing something
 * must not renumber anything else. What is bounded is the DOM: a few thousand
 * mounted buttons is a frozen window, and a few thousand tabs is a normal Tuesday
 * once quick open is in play. So the strip renders only the tabs near the visible
 * slice and scrolls to reach the rest, which is the same arrangement as the file
 * tree's rows.
 *
 * Tab width is fixed for the same reason the tree's row height is: a window has
 * to know where tab 4,000 is before tab 4,000 exists.
 */
export function TabBar(props: { ws: Workspace }) {
  const [dragFrom, setDragFrom] = createSignal<string | null>(null);
  const [dropAt, setDropAt] = createSignal<number | null>(null);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  let strip: HTMLDivElement | undefined;

  const tabs = () => props.ws.tabs();
  const total = () => tabs().length;

  const win = createMemo(() =>
    tabWindow(total(), scrollLeft(), viewport(), TAB_WIDTH),
  );

  /**
   * The mounted slice, each with its absolute index.
   *
   * The index is carried with the tab rather than derived from the loop position,
   * so a drop marker and a reorder both speak in terms of the real list.
   */
  const slice = createMemo(() => {
    const { start, end } = win();
    return tabs()
      .slice(start, end)
      .map((path, i) => ({ path, index: start + i }));
  });

  createMemo(() => {
    const el = strip;
    if (!el) return;
    // The strip can also grow because tabs were added, not because it was
    // scrolled; measuring on every version keeps the window correct after a close.
    setViewport(el.clientWidth);
  });

  function measure(): void {
    const el = strip;
    if (!el) return;
    if (el.clientWidth !== viewport()) setViewport(el.clientWidth);
  }

  // About the element, not the tab list, so it is created once on mount rather
  // than per render.
  onMount(() => {
    const el = strip;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    onCleanup(() => ro.disconnect());
  });

  /** Brings a tab into view with the smallest movement that does it. */
  function reveal(path: string): void {
    const el = strip;
    const index = tabs().indexOf(path);
    if (!el || index < 0) return;
    const next = scrollToReveal(
      el.scrollLeft,
      el.clientWidth,
      index,
      win().contentWidth,
      TAB_WIDTH,
    );
    if (next === null) return;
    el.scrollLeft = next;
    setScrollLeft(next);
  }

  // The active tab follows the reader: opening a file from the tree should not
  // leave it scrolled out of sight.
  let revealedFor = '';
  createEffect(() => {
    const path = props.ws.active();
    if (!path || path === revealedFor) return;
    revealedFor = path;
    queueMicrotask(() => reveal(path));
  });

  function menuFor(e: MouseEvent, path: string) {
    e.preventDefault();
    props.ws.openFile(path);
    const all = props.ws.tabs();
    const others = all.filter((p) => p !== path);
    openMenu(e.clientX, e.clientY, [
      { label: 'Close', hint: '⌘W', run: () => props.ws.closeTab(path) },
      {
        label: 'Close others',
        disabled: others.length === 0,
        run: () => {
          for (const p of others) props.ws.closeTab(p);
        },
      },
      {
        label: 'Close all',
        run: () => {
          for (const p of [...all]) props.ws.closeTab(p);
        },
      },
      { label: '', separator: true },
      { label: 'Copy path', run: () => void copyText(path) },
      {
        label: 'Reveal in explorer',
        run: () => {
          props.ws.revealPath(path);
          props.ws.setSelected([path]);
        },
      },
      { label: '', separator: true },
      {
        label: 'Move left',
        hint: '⌥←',
        disabled: all.indexOf(path) === 0,
        run: () => props.ws.moveBy(path, -1),
      },
      {
        label: 'Move right',
        hint: '⌥→',
        disabled: all.indexOf(path) === all.length - 1,
        run: () => props.ws.moveBy(path, 1),
      },
    ]);
  }

  function commitDrop(to: number) {
    const from = dragFrom();
    setDragFrom(null);
    setDropAt(null);
    if (!from) return;
    const list = props.ws.tabs();
    const src = list.indexOf(from);
    if (src < 0) return;
    const rest = list.filter((p) => p !== from);
    const at = Math.max(0, Math.min(rest.length, to > src ? to - 1 : to));
    if (at === src) return;
    props.ws.reorderTabs(from, at);
  }

  return (
    <div class="tabbar">
      <div
        class="tabbar__strip scroll"
        ref={strip}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollLeft !== scrollLeft()) setScrollLeft(el.scrollLeft);
        }}
      >
        <div
          class="tabbar__spacer"
          style={{ width: `${win().contentWidth}px` }}
        >
          <div
            class="tabbar__window"
            style={{
              transform: `translateX(${win().start * TAB_WIDTH}px)`,
              width: `${(win().end - win().start) * TAB_WIDTH}px`,
            }}
          >
            <For each={slice()}>
              {(item) => (
                <button
                  class="tab"
                  style={{ width: `${TAB_WIDTH}px` }}
                  classList={{
                    'tab--on': props.ws.active() === item.path,
                    'tab--dragging': dragFrom() === item.path,
                    'tab--dropbefore': dropAt() === item.index && dragFrom() !== item.path,
                    'tab--dropafter':
                      dropAt() === item.index + 1 &&
                      item.index === props.ws.tabs().length - 1 &&
                      dragFrom() !== item.path,
                  }}
                  draggable={true}
                  onDragStart={(e) => {
                    e.dataTransfer?.setData('text/plain', item.path);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                    setDragFrom(item.path);
                  }}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDropAt(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragFrom()) return;
                    e.preventDefault();
                    const box = e.currentTarget.getBoundingClientRect();
                    // The mounted position is an absolute index, not an offset
                    // inside the window, so a drop near the end of a scrolled
                    // strip still lands where it looks like it lands.
                    setDropAt(
                      e.clientX < box.left + box.width / 2 ? item.index : item.index + 1,
                    );
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    commitDrop(dropAt() ?? item.index);
                  }}
                  onClick={() => props.ws.openFile(item.path)}
                  onContextMenu={(e) => menuFor(e, item.path)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      props.ws.closeTab(item.path);
                    }
                  }}
                  title={item.path}
                >
                  <Show
                    when={item.path.endsWith('.pdf')}
                    fallback={
                      <span class="row__mono" style={{ color: LANG_COLOR[fileIconLang(item.path)] }}>
                        {fileIconLang(item.path)}
                      </span>
                    }
                  >
                    <Icon name="book" size={13} class="row__glyph" />
                  </Show>
                  <span class="tab__name truncate">{item.path.split('/').pop()}</span>
                  <Show when={props.ws.dirty().has(item.path)}>
                    <span class="tab__dirty" />
                  </Show>
                  <span
                    class="tab__close"
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.ws.closeTab(item.path);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <Icon name="x" size={12} stroke={1.8} />
                  </span>
                  <Show when={props.ws.active() === item.path}>
                    <span class="tab__edge" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
        <Show when={props.ws.tabs().length === 0}>
          <span class="tabbar__empty">No open editors</span>
        </Show>
      </div>
    </div>
  );
}