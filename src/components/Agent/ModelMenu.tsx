import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';

import { Icon } from '../Icon';
import type { LlmView } from '../../lib/agent';
import { VirtualList } from '../VirtualList';

/**
 * The model switcher: a dropdown anchored under the panel's model button.
 *
 * One row per configured model, every row naming its entry, so two endpoints
 * serving the same id stay tellable apart. The selected row carries a check —
 * the name is never traded for a state label, because the name is the part
 * that tells the rows apart.
 */
export function ModelMenu(props: {
  configs: LlmView[];
  onOpen: () => void;
  onPick: (name: string, model: string) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');

  const active = () => props.configs.find((c) => c.active);

  /**
   * The collapsed state names both: which endpoint, and which model in it.
   * The model alone is ambiguous the moment two entries serve the same id.
   */
  const label = () => {
    const a = active();
    return a?.activeModel ? `${a.name} · ${a.activeModel}` : 'no model';
  };

  /** Every (entry, model) pair, in list order. */
  const rows = () =>
    props.configs.flatMap((c) =>
      c.models.map((m) => ({
        name: c.name,
        model: m,
        selected: c.active && c.activeModel === m,
      })),
    );
  const filteredRows = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? rows().filter((r) => `${r.model} ${r.name}`.toLowerCase().includes(q)) : rows();
  });

  const toggle = () => {
    if (open()) {
      setOpen(false);
      return;
    }
    if (rows().length === 0) {
      // Nothing to switch between yet: the settings dialog is where the first
      // endpoint gets typed.
      props.onOpenSettings();
      return;
    }
    // Re-read on the way in: a model may have been added or removed since the
    // panel last looked, and the rows render from the resource, so the list
    // corrects itself the moment the read lands.
    props.onOpen();
    setOpen(true);
  };

  // A dropdown closes from anywhere but itself: a click elsewhere, or Escape.
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.('.modelmenu')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    });
  });

  return (
    <div class="modelmenu" classList={{ 'modelmenu--open': open() }}>
      <button
        class="modelbtn"
        classList={{ 'modelbtn--unset': !active() }}
        aria-label={active() ? 'Switch model' : 'Configure a model'}
        data-tooltip={active() ? 'Switch model' : 'Configure a model'}
        onClick={toggle}
      >
        <Icon name="cpu" size={12} />
        <span class="truncate">{label()}</span>
        <Icon name="chevronDown" size={12} class="modelbtn__chev" />
      </button>

      <Show when={open()}>
        <div class="modelmenu__pop rise-in">
          <input class="input modelmenu__search" placeholder="Search models…" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          <VirtualList items={filteredRows()} rowHeight={27} height={Math.min(270, Math.max(54, filteredRows().length * 27))} class="modelmenu__list" render={(row) => (
              <button
                class="modelmenu__item"
                classList={{ 'modelmenu__item--on': row.selected }}
                onClick={() => {
                  setOpen(false);
                  if (!row.selected) props.onPick(row.name, row.model);
                }}
              >
                <span class="modelmenu__check">
                  <Show when={row.selected}>
                    <Icon name="check" size={13} />
                  </Show>
                </span>
                <span class="modelmenu__model truncate">{row.model}</span>
                <span class="modelmenu__name truncate">{row.name}</span>
              </button>
            )} />
        </div>
      </Show>
    </div>
  );
}
