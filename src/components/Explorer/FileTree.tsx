import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from 'solid-js';

import { Icon, LANG_COLOR } from '../Icon';
import { langOf } from '../../lib/fs';
import { anchoredScrollTop, virtualRange } from '../../lib/tree';
import { parentOf, type Row } from '../../lib/rowindex';
import { copyText, openMenu, setTreeCmd, toast, treeCmd } from '../../store/ui';
import type { Workspace } from '../../store/workspace';

const ROW = 24;
/**
 * How long the pointer has to rest on a folder before its first page is fetched.
 * Long enough that sweeping the mouse across a list costs nothing, short enough
 * that a deliberate move onto a folder is already paying off by the click.
 */
const WARM_MS = 150;

interface CreateItem {
  t: 'create';
  dir: string;
  kind: 'file' | 'dir';
}

export function FileTree(props: { ws: Workspace }) {
  const ws = () => props.ws;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(640);
  const [cursor, setCursor] = createSignal(0);
  const [cursorPath, setCursorPath] = createSignal<string | null>(null);
  const [dropPath, setDropPath] = createSignal<string | null>(null);
  const [dragPath, setDragPath] = createSignal<string | null>(null);
  /**
   * The topmost row the reader is looking at, plus the leftover pixels inside it.
   *
   * `scrollTop` on its own cannot survive a change to the row space: expanding a
   * directory above the viewport inserts rows, the browser keeps the pixel offset,
   * and everything under the reader jumps by the height of the insertion. Holding
   * a row instead means the row stays put and the scrollbar follows it — which is
   * the whole difference between a tree that feels solid and one that flinches.
   */
  const [anchor, setAnchor] = createSignal<{ path: string; offset: number } | null>(null);
  let scroller: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  /** At most one directory is warmed at a time, and only on a deliberate dwell. */
  let dwell: number | undefined;
  let warming: string | null = null;
  onCleanup(() => {
    if (dwell !== undefined) clearTimeout(dwell);
  });

  function onRowHover(path: string, kind: 'dir' | 'file'): void {
    setCursorPath(path);
    if (dwell !== undefined) {
      clearTimeout(dwell);
      dwell = undefined;
    }
    if (kind !== 'dir' || warming !== null) return;
    dwell = setTimeout(() => {
      dwell = undefined;
      warming = path;
      void ws().prefetch(path).finally(() => {
        if (warming === path) warming = null;
      });
    }, WARM_MS);
  }

  const total = createMemo(() => ws().rowCount());
  const range = createMemo(() => virtualRange(scrollTop(), viewport(), ROW, total(), 20));

  const slice = createMemo(() => ws().sliceRows(range().start, range().end));

  const createItem = createMemo(() => {
    const creating = ws().creating();
    return creating ? ({ t: 'create' as const, ...creating } as CreateItem) : null;
  });

  /**
   * The create row is rendered as its own sibling between the two halves of the
   * window instead of being spliced into a single list. Inside one list the row
   * shifted position whenever the window moved, and moving a focused input in the
   * DOM fires blur — which committed a half-typed name and silently did nothing.
   */
  const createSlot = createMemo(() => {
    const creating = createItem();
    const rows = slice();
    if (!creating) return { before: rows, after: [] as Row[], item: null };
    let at = -1;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.kind === 'dir' && row.path === creating.dir) {
        at = i + 1;
        break;
      }
    }
    if (at < 0) return { before: rows, after: [] as Row[], item: creating };
    return {
      before: rows.slice(0, at),
      after: rows.slice(at),
      item: creating,
    };
  });

  // Repopulate directories the cache evicted to respect its ceiling, extend
  // directories whose next page is on screen, and keep the visible window's
  // directories exempt from eviction.
  //
  // The store recomputes both of those sets inside `protectWindow`, from rows it
  // has just re-read. Asking it — rather than reading flags off recycled row
  // objects — is what keeps the label in a row honest: a directory that has
  // already loaded can never keep saying "loading…".
  createEffect(() => {
    const { start, end } = range();
    const store = ws();
    store.revision();
    store.protectWindow(start, end);
    for (const dir of store.missing()) void store.ensureLoaded(dir);
    for (const dir of store.pageable()) void store.loadMore(dir);
  });

  function captureAnchor(offsetPx: number): void {
    const count = ws().rowCount();
    if (count <= 0) {
      setAnchor(null);
      return;
    }
    const first = Math.max(0, Math.floor(offsetPx / ROW));
    const row = ws().rowAt(Math.min(first, count - 1));
    if (!row) return;
    setAnchor({ path: row.path, offset: offsetPx - first * ROW });
  }

  /**
   * Where the anchored row currently is. If the row itself is gone (deleted, or
   * evicted with its directory) the nearest surviving ancestor takes over, so the
   * reader lands on the closest thing to where they were instead of at the top.
   */
  function anchorIndex(held: { path: string }): number {
    const base = ws().root() ?? '/';
    let path = held.path;
    for (let guard = 0; guard < 64; guard++) {
      const at = ws().indexOf(path);
      if (at >= 0) return at;
      const parent = parentOf(path, base);
      if (!parent) return -1;
      path = parent;
    }
    return -1;
  }

  function scrollToPx(px: number): void {
    const sc = scroller;
    if (!sc) return;
    sc.scrollTop = px;
    setScrollTop(px);
    captureAnchor(px);
  }

  /**
   * Puts the anchored row back where the reader left it.
   *
   * Runs after the DOM has the new heights, and reads `scrollHeight` first — that
   * forces layout, so the clamp below is computed against the geometry the reader
   * will actually see. If the content shrank past the anchor, the anchor is
   * re-recorded from the position we can actually reach: the alternative, writing
   * an unreachable offset and correcting it later, is indistinguishable from the
   * reader scrolling away, which is exactly how the scrollbar ends up fighting
   * the person using it.
   */
  function restore(): void {
    const sc = scroller;
    const held = anchor();
    if (!sc || !held) return;
    const at = anchorIndex(held);
    if (at < 0) return;
    const wanted = anchoredScrollTop(at, held.offset, ROW, sc.scrollHeight - sc.clientHeight);
    if (Math.abs(sc.scrollTop - wanted) <= 1) return;
    sc.scrollTop = wanted;
    setScrollTop(wanted);
    captureAnchor(wanted);
  }

  // Anything that reshapes the row space re-runs this: expansions above the
  // viewport, pages appended, evictions, renames, the cursor's own directory.
  createEffect(() => {
    ws().revision();
    restore();
  });

  createEffect(() => {
    const sizer = content;
    if (!sizer) return;
    const ro = new ResizeObserver(() => restore());
    ro.observe(sizer);
    onCleanup(() => ro.disconnect());
  });

  // Creating inside a folder that is scrolled out of view would hide the inline
  // input, so pull it into the window.
  createEffect(() => {
    const creating = createItem();
    if (!creating) return;
    const sc = scroller;
    if (!sc) return;
    const at = ws().indexOf(creating.dir);
    if (at < 0) {
      // 父目录本身还没展开成行：定位不到就把输入框收掉，别留下一个
      // 永远无法提交的孤儿输入框。
      ws().setCreating(null);
      return;
    }
    const top = at * ROW;
    if (top < sc.scrollTop || top + ROW * 2 > sc.scrollTop + sc.clientHeight) {
      scrollToPx(Math.max(0, top - ROW * 2));
    }
  });

  createEffect(() => {
    if (!scroller) return;
    const el = scroller;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  // The cursor is a row *number*, and expanding a directory above it moves every
  // row in between. Re-deriving it from the path keeps the highlight on the same
  // file, which is what a reader expects after opening a folder above.
  createEffect(() => {
    ws().revision();
    const path = cursorPath();
    if (!path) return;
    const at = ws().indexOf(path);
    if (at >= 0 && at !== cursor()) setCursor(at);
    // A drag whose source row is gone can never deliver a drop; drop the mode
    // rather than leaving every row painted as a target.
    const dragging = dragPath();
    if (dragging && at < 0 && ws().rowAt(ws().indexOf(dragging))?.path !== dragging) {
      releaseDrag();
    }
  });

  // Keep the cursor on the active file whenever it changes from outside the tree
  // (palette, tab bar, agent) and scroll it into view.
  createEffect(
    on(ws().active, (path) => {
    if (!path) return;
    const at = ws().indexOf(path);
    if (at < 0) return;
    setCursor(at);
    setCursorPath(path);
    const sc = scroller;
    if (!sc) return;
    const top = at * ROW;
    if (top < sc.scrollTop || top + ROW > sc.scrollTop + sc.clientHeight) {
      scrollToPx(Math.max(0, top - sc.clientHeight / 2));
    }
    }),
  );

  function rowAtCursor(): Row | undefined {
    return ws().rowAt(cursor());
  }

  function moveCursor(delta: number): void {
    const next = Math.max(0, Math.min(total() - 1, cursor() + delta));
    setCursor(next);
    const row = ws().rowAt(next);
    setCursorPath(row?.path ?? null);
    scrollCursorIntoView();
  }

  function scrollCursorIntoView(): void {
    const sc = scroller;
    if (!sc) return;
    const top = cursor() * ROW;
    const bottom = top + ROW;
    if (top < sc.scrollTop) scrollToPx(top);
    else if (bottom > sc.scrollTop + sc.clientHeight) scrollToPx(bottom - sc.clientHeight);
  }

  async function commitCreate(
    dir: string,
    kind: 'file' | 'dir',
    value: string,
  ): Promise<void> {
    const name = String(value ?? '').trim();
    if (!name) {
      ws().setCreating(null);
      return;
    }
    try {
      const created = await ws().createEntry(dir, name, kind);
      toast('ok', kind === 'dir' ? 'Folder created' : 'File created', created ?? name);
      if (created && kind === 'file') await ws().openFile(created);
    } catch (err) {
      // Previously a backend failure rejected silently: no file, no message.
      toast('error', 'Create failed', String(err));
    } finally {
      ws().setCreating(null);
    }
  }

  function commitRename(path: string, value: string): void {
    ws().setRenaming(null);
    const name = value.trim();
    if (!name) return;
    void ws()
      .renameEntry(path, name)
      .then((renamed) => toast('ok', 'Renamed', renamed ?? name))
      .catch((err: unknown) => toast('error', 'Rename failed', String(err)));
  }

  function startRename(path: string): void {
    ws().setRenaming(path);
    queueMicrotask(() => {
      const input = scroller?.querySelector<HTMLInputElement>('.row__input');
      input?.focus();
      input?.select();
    });
  }

  function deleteSelection(): void {
    const many = ws().selected();
    const target = many.length ? many : cursorPath() ? [cursorPath() as string] : [];
    if (!target.length) return;
    void ws().removeEntries(target).then(() => {
      toast('info', target.length > 1 ? `Deleted ${target.length} items` : 'Deleted', target[0]);
    });
  }

  function rowMenu(e: MouseEvent, row: Row): void {
    e.preventDefault();
    e.stopPropagation();
    if (!ws().selected().includes(row.path)) ws().setSelected([row.path]);
    setCursorPath(row.path);
    setCursor(ws().indexOf(row.path));
    const base = ws().root() ?? '/';
    const parent = parentOf(row.path, base) ?? base;
    const isDirRow = row.kind === 'dir';
    const targetDir = isDirRow ? row.path : parent;
    // Creating is the only action that needs write access, and it is the one
    // that used to fail with a bare EACCES. Check first, explain up front.
    void ws().canWrite(targetDir).then((writable) => {
      const blocked = writable
        ? ''
        : { label: '（无写入权限）', disabled: true, run: () => {} };
      openMenu(e.clientX, e.clientY, [
      {
        label: 'New File…',
        disabled: !writable,
        run: () => ws().setCreating({ dir: targetDir, kind: 'file' }),
      },
      {
        label: 'New Folder…',
        disabled: !writable,
        run: () => ws().setCreating({ dir: targetDir, kind: 'dir' }),
      },
      ...(blocked ? [blocked] : []),
      { separator: true, label: '' },
      { label: 'Open', run: () => void ws().openFile(row.path) },
      { label: 'Rename…', run: () => startRename(row.path) },
      { separator: true, label: '' },
      { label: 'Copy Path', run: () => void copyText(row.path, 'Path copied') },
      {
        label: 'Reveal in Stage',
        run: () => void ws().openFile(row.path),
      },
      { separator: true, label: '' },
      {
        label: ws().selected().length > 1 ? `Delete ${ws().selected().length} items` : 'Delete',
        danger: true,
        run: deleteSelection,
      },
      ]);
    });
  }

  function headerMenu(e: MouseEvent): void {
    e.preventDefault();
    const base = ws().root();
    // Root-level entries land directly in the opened folder, so its writability
    // decides whether the two create actions are usable at all.
    void ws().canWrite(base ?? '').then((writable) => openMenu(e.clientX, e.clientY, [
      {
        label: 'New File…',
        disabled: !base || !writable,
        run: () => base && ws().setCreating({ dir: base, kind: 'file' }),
      },
      {
        label: 'New Folder…',
        disabled: !base || !writable,
        run: () => base && ws().setCreating({ dir: base, kind: 'dir' }),
      },
      ...(base && !writable
        ? [{ label: '（根目录无写入权限）', disabled: true, run: () => {} }]
        : []),
      { separator: true, label: '' },
      { label: 'Expand All', run: () => void expandAll() },
      { label: 'Collapse All', run: collapseAll },
      { separator: true, label: '' },
      {
        label: 'Open Folder…',
        run: () =>
          void ws().pickFolder().then((ok) => {
            if (ok) toast('ok', 'Folder opened', ws().rootName());
          }),
      },
    ]));
  }

  /** Expands breadth-first under a budget: a huge tree must not stall the UI. */
  async function expandAll(): Promise<void> {
    const base = ws().root();
    if (!base) return;
    const budget = 200;
    let touched = 0;
    await ws().ensureLoaded(base);
    ws().setExpanded(base, true);
    touched++;
    const queue = ws()
      .entriesOf(base)
      .filter((e) => e.kind === 'dir')
      .map((e) => e.path);
    while (queue.length && touched < budget) {
      const dir = queue.shift() as string;
      await ws().ensureLoaded(dir);
      ws().setExpanded(dir, true);
      touched++;
      for (const entry of ws().entriesOf(dir)) {
        if (entry.kind === 'dir') queue.push(entry.path);
      }
    }
    toast(
      touched >= budget ? 'info' : 'ok',
      'Expanded',
      touched >= budget ? `first ${budget} directories` : `${touched} directories`,
    );
  }

  function collapseAll(): void {
    const base = ws().root();
    ws().setExpanded(base ?? '', false);
  }

  function onKeyDown(e: KeyboardEvent): void {
    const row = rowAtCursor();
    const path = row?.path;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCursor(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (row?.kind === 'dir' && !ws().expanded().has(row.path)) void ws().toggleDir(row.path);
      else moveCursor(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (row?.kind === 'dir' && ws().expanded().has(row.path)) ws().setExpanded(row.path, false);
      else if (path) {
        const parent = parentOf(path, ws().root() ?? '/');
        if (parent) {
          const at = ws().indexOf(parent);
          if (at >= 0) {
            setCursor(at);
            setCursorPath(parent);
            scrollCursorIntoView();
          }
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (path) void ws().openFile(path);
    } else if (e.key === 'F2' && path) {
      e.preventDefault();
      startRename(path);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && (path || ws().selected().length)) {
      e.preventDefault();
      deleteSelection();
    }
  }

  createEffect(() => {
    const cmd = treeCmd();
    if (!cmd) return;
    if (cmd.kind === 'collapse-all') collapseAll();
    else void expandAll();
    setTreeCmd(null);
  });

  function renderRow(item: Row) {
    if (item.more) return <MoreRow ws={ws()} row={item} />;
    return (
      <TreeRow
        row={item}
        ws={ws()}
        renaming={ws().renaming() === item.path}
        selected={ws().selected().includes(item.path)}
        active={ws().active() === item.path}
        dropTarget={dropPath()}
        onRename={(v) => commitRename(item.path, v)}
        onRenameEnd={() => ws().setRenaming(null)}
        onContext={rowMenu}
        onToggle={() => void ws().toggleDir(item.path)}
        onArmDrag={() => releaseDrag()}
        onDragStart={() => setDragPath(item.path)}
        onDragEnd={() => releaseDrag()}
        onDragOverRow={() => setDropPath(onDropTarget(item))}
        onSelect={(e) => {
          // Event-time work: keeping `indexOf` out of the *render* path matters,
          // since it would make every visible row depend on the index memo and
          // re-run the whole window on each expand.
          setCursor(ws().indexOf(item.path));
          setCursorPath(item.path);
          ws().setSelected([item.path]);
          if (e.metaKey || e.ctrlKey) {
            ws().setSelected((prev) =>
              prev.includes(item.path)
                ? prev.filter((p) => p !== item.path)
                : [...prev, item.path],
            );
            return;
          }
          if (e.shiftKey) {
            const anchor = ws().indexOf(cursorPath() ?? item.path);
            const from = Math.min(anchor, ws().indexOf(item.path));
            const to = Math.max(anchor, ws().indexOf(item.path));
            const picked: string[] = [];
            for (let i = from; i <= to; i++) {
              const r = ws().rowAt(i);
              if (r) picked.push(r.path);
            }
            ws().setSelected(picked);
            return;
          }
          // A plain click on a folder expands or collapses it, the way every
          // file explorer behaves. The chevron stops propagation, so clicking it
          // still toggles exactly once.
          if (item.kind === 'dir') void ws().toggleDir(item.path);
        }}
        onHover={() => onRowHover(item.path, item.kind)}
      />
    );
  }

  /**
   * Every exit from a drag goes through here.
   *
   * `dragend` is not enough: a drag whose source row leaves the window (it was
   * evicted, or the tree reshaped under it) never fires it, and the tree stays in
   * drag mode — every row highlighted as a drop target and every hover accepted,
   * which reads as "stuck". Pointer and window events cover the rest.
   */
  function releaseDrag(): void {
    setDragPath(null);
    setDropPath(null);
  }

  function onDropTarget(row: Row): string | null {
    const dragging = dragPath();
    if (!dragging || dragging === row.path) return null;
    if (dragging.startsWith(`${row.path}/`)) return null;
    return row.kind === 'dir' ? row.path : (parentOf(row.path, ws().root() ?? '/') ?? null);
  }

  return (
    <div
      class="tree scroll"
      ref={scroller}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        // Every scroll event is treated as the reader's intent. The one case that
        // is not — the browser clamping the offset after the content got shorter —
        // is corrected by the anchored restore on the next frame, before paint.
        setScrollTop(e.currentTarget.scrollTop);
        captureAnchor(e.currentTarget.scrollTop);
      }}
      onContextMenu={headerMenu}
      onPointerUp={releaseDrag}
      onPointerCancel={releaseDrag}
      onBlur={releaseDrag}
      onDragOver={(e) => {
        if (dragPath()) e.preventDefault();
      }}
      onDrop={() => {
        const dragging = dragPath();
        const target = dropPath() ?? ws().root();
        releaseDrag();
        if (!dragging || !target) return;
        void ws().move(dragging, target).then((moved) => {
          if (moved) toast('info', 'Moved', `${dragging} → ${moved}`);
          else toast('error', 'Cannot move there', `${dragging} → ${target}`);
        });
      }}
    >
      <div
        class="tree__sizer"
        ref={content}
        style={{ height: `${total() * ROW}px` }}
      >
      <div
        class="tree__window"
        style={{ transform: `translateY(${range().start * ROW}px)` }}
      >
      <For each={createSlot().before}>{(item) => renderRow(item)}</For>
      <Show when={createSlot().item}>
        {(item) => (
          <CreateRow
            item={item()}
            onCommit={(value) => void commitCreate(item().dir, item().kind, value)}
            onCancel={() => ws().setCreating(null)}
          />
        )}
      </Show>
      <For each={createSlot().after}>{(item) => renderRow(item)}</For>
      </div>
      </div>
    </div>
  );
}

function CreateRow(props: {
  item: { dir: string; kind: 'file' | 'dir' };
  /** Takes the typed name only. A wider callback signature type-checks happily
   *  against a narrower lambda and then mis-binds every argument at runtime. */
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  let input: HTMLInputElement | undefined;
  // Enter and blur both fire for a single confirmation; committing twice made the
  // second call collide with the file the first one had just written.
  let settled = false;
  const commit = (): void => {
    if (settled) return;
    settled = true;
    try {
      props.onCommit(input?.value ?? '');
    } catch (err) {
      // Never leave the row stuck in edit mode: a failed commit must be
      // retryable, otherwise the input is permanently frozen.
      settled = false;
      toast('error', 'Create failed', String(err));
    }
  };
  createEffect(() => {
    input?.focus();
  });
  return (
    <div class="row row--create" style={{ 'padding-left': '8px' }}>
      <Icon name={props.item.kind === 'dir' ? 'folder' : 'file'} size={14} class="row__glyph" />
      <input
        ref={input}
        class="row__input"
        placeholder={props.item.kind === 'dir' ? 'folder name' : 'file name'}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') props.onCancel();
        }}
        onBlur={commit}
      />
    </div>
  );
}

function TreeRow(props: {
  row: Row;
  ws: Workspace;
  renaming: boolean;
  selected: boolean;
  active: boolean;
  dropTarget: string | null;
  onRename: (value: string) => void;
  onRenameEnd: () => void;
  onContext: (e: MouseEvent, row: Row) => void;
  onToggle: () => void;
  onArmDrag: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverRow: (e: DragEvent) => void;
  onSelect: (e: MouseEvent) => void;
  onHover: () => void;
}) {
  const row = () => props.row;
  /**
   * A row is not draggable until a pointer actually goes down on it.
   *
   * `draggable` set at render time makes every click a potential drag: a couple of
   * pixels of hand movement while pressing starts an HTML5 drag, the click never
   * completes, and the folder under the cursor refuses to expand. Arming on
   * pointerdown keeps the gesture available while leaving a plain click a click.
   */
  const [draggable, setDraggable] = createSignal(false);
  onCleanup(() => setDraggable(false));
  const indent = () => 6 + row().depth * 13;
  // Row objects are recycled across rebuilds so `<For>` does not recreate every
  // visible row. A plain property on them is therefore invisible to Solid: the
  // chevron has to read the store's signal, or it never updates — same for the
  // pending state, which is why it reads the revision counter.
  const isOpen = () => row().kind === 'dir' && props.ws.expanded().has(row().path);
  const pending = () => props.ws.missing().has(row().path);
  const blocked = () => props.ws.unreadable().has(row().path);

  let input: HTMLInputElement | undefined;
  createEffect(() => {
    if (props.renaming) {
      input?.focus();
      const dot = row().name.lastIndexOf('.');
      input?.setSelectionRange(0, dot > 0 ? dot : row().name.length);
    }
  });

  return (
    <div
      class="row"
      classList={{
        'row--on': props.selected,
        'row--active': props.active,
        'row--drop': props.dropTarget === row().path,
        'row--pending': pending(),
        'row--blocked': blocked(),
      }}
      style={{ 'padding-left': `${indent()}px` }}
      data-path={row().path}
      data-kind={row().kind}
      draggable={draggable() && !props.renaming}
      onDragStart={(e) => {
        e.dataTransfer?.setData('text/plain', row().path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        props.onDragStart();
      }}
      onDragEnd={props.onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOverRow(e);
      }}
      onPointerEnter={props.onHover}
      onPointerDown={(e) => {
        if (!props.renaming) setDraggable(true);
        props.onArmDrag();
        props.onSelect(e);
      }}
      onPointerUp={() => setDraggable(false)}
      onPointerCancel={() => setDraggable(false)}
      onDblClick={() => {
        if (props.renaming) return;
        if (row().kind === 'dir') props.onToggle();
        else void props.ws.openFile(row().path);
      }}
      onContextMenu={(e) => props.onContext(e, row())}
    >
      <button
        class="row__chevron"
        classList={{ 'row__chevron--hidden': row().kind !== 'dir' }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggle();
        }}
        tabIndex={-1}
      >
        <Icon name={isOpen() ? 'chevronDown' : 'chevronRight'} size={12} stroke={1.8} />
      </button>

      <Show
        when={!props.renaming}
        fallback={
          <input
            ref={input}
            class="row__input"
            value={row().name}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') props.onRename(e.currentTarget.value);
              if (e.key === 'Escape') props.onRenameEnd();
            }}
            onBlur={(e) => props.onRename(e.currentTarget.value)}
          />
        }
      >
        <Show
          when={row().kind === 'file'}
          fallback={<Icon name="folder" size={14} class="row__glyph" />}
        >
          <span class="row__mono" style={{ color: LANG_COLOR[langOf(row().path)] }}>
            {langOf(row().path).slice(0, 2)}
          </span>
        </Show>
        <span class="row__name truncate">{row().name}</span>
        <Show when={pending() || blocked()}>
          <span class="row__hint" title={props.ws.reasonOf(row().path) ?? ''}>
            {blocked() ? '无法读取' : 'loading…'}
          </span>
        </Show>
      </Show>
    </div>
  );
}

/**
 * The continuation row of a directory with more children than are resident.
 *
 * It is a real row, not a spinner: the row space ends here until the next page
 * arrives, so the scrollbar never claims depth that does not exist yet, and what
 * arrives is appended *below* it — the rows the reader is looking at keep their
 * indices. It also loads itself the moment it enters the window, so scrolling
 * into a large directory keeps going without a click.
 */
function MoreRow(props: { ws: Workspace; row: Row }) {
  const remaining = () => {
    props.ws.revision();
    const listing = props.ws.listingOf(props.row.path);
    if (!listing) return 0;
    return Math.max(0, listing.total - listing.entries.length);
  };
  const busy = () => props.ws.busyDirs().has(props.row.path);
  const blocked = () => props.ws.unreadable().has(props.row.path);
  return (
    <div
      class="row row--more"
      style={{ 'padding-left': `${6 + props.row.depth * 13}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => void props.ws.loadMore(props.row.path)}
    >
      <Icon name="more" size={14} class="row__glyph" />
      <span
        class="row__name row__name--more truncate"
        title={props.ws.reasonOf(props.row.path) ?? ''}
      >
        {blocked() ? '无法读取' : busy() ? 'loading…' : `${remaining().toLocaleString()} more`}
      </span>
    </div>
  );
}