import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';

import { closeMenu, menu } from '../store/ui';

export function ContextMenu() {
  const [active, setActive] = createSignal(0);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });

  const entries = createMemo(() => {
    let n = 0;
    return (menu()?.items ?? []).map((item) => {
      const sep = Boolean(item.separator);
      const disabled = Boolean(item.disabled);
      const idx = sep || disabled ? -1 : n++;
      return { item, sep, disabled, idx };
    });
  });

  createEffect(() => {
    const m = menu();
    if (!m) return;
    setActive(0);
    const w = 236;
    const h = Math.min(m.items.length * 28 + 12, 440);
    setPos({
      x: Math.max(8, Math.min(m.x, window.innerWidth - w - 12)),
      y: Math.max(8, Math.min(m.y, window.innerHeight - h - 12)),
    });
  });

  const count = () => entries().filter((e) => e.idx >= 0).length;

  const onKey = (e: KeyboardEvent) => {
    if (!menu()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(count(), 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + count()) % Math.max(count(), 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = entries().find((e2) => e2.idx === active());
      if (target) {
        closeMenu();
        target.item.run?.();
      }
    }
  };

  const onDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('.ctxmenu')) return;
    closeMenu();
  };

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('pointerdown', onDown, true);
  onCleanup(() => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointerdown', onDown, true);
  });

  return (
    <Show when={menu()}>
      <div
        class="ctxmenu rise-in"
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <For each={entries()}>
          {(entry) => (
            <Show
              when={!entry.sep}
              fallback={<div class="ctxmenu__sep" />}
            >
              <button
                class="ctxmenu__item"
                classList={{
                  'ctxmenu__item--danger': entry.item.danger,
                  'ctxmenu__item--on': entry.idx === active(),
                }}
                disabled={entry.disabled}
                onPointerEnter={() => entry.idx >= 0 && setActive(entry.idx)}
                onClick={() => {
                  closeMenu();
                  entry.item.run?.();
                }}
              >
                <span class="ctxmenu__label">{entry.item.label}</span>
                <Show when={entry.item.hint}>
                  <span class="ctxmenu__hint">{entry.item.hint}</span>
                </Show>
              </button>
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}
