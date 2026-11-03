import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from 'solid-js';

import { Icon } from './Icon';
import { SearchClear } from './SearchClear';
import { VirtualList } from './VirtualList';
import { agentApi } from '../lib/agent';
import { setApiSettingsOpen, toast, texEngine, setTexEngine, type TexEngine } from '../store/ui';
import { invoke } from '../lib/backend';

/** The fixed set of LaTeX compilers, in the order the menu lists them. */
const ENGINE_OPTIONS: TexEngine[] = ['xelatex', 'pdflatex', 'lualatex', 'latex'];

/** Display names, kept next to the values they label. */
const ENGINE_LABELS: Record<TexEngine, string> = {
  xelatex: 'XeLaTeX (xelatex)',
  pdflatex: 'pdfLaTeX (pdflatex)',
  lualatex: 'LuaLaTeX (lualatex)',
  latex: 'LaTeX (latex)',
};

/**
 * The compiler picker: the same dropdown as the LLM model menu — the same
 * trigger, the same popover, the same outside-click/Escape close and the same
 * item rows — so the two selectors read as one family of menus. The option set
 * is small and fixed, so no search field and no virtual window are needed.
 */
function EngineSelect(props: {
  value: TexEngine;
  disabled: boolean;
  onChange: (engine: TexEngine) => void;
}) {
  const [open, setOpen] = createSignal(false);

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
        e.stopPropagation();
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
        disabled={props.disabled}
        aria-label="LaTeX compiler"
        data-tooltip="LaTeX compiler"
        onClick={() => setOpen(!open())}
      >
        <span class="truncate">{ENGINE_LABELS[props.value]}</span>
        <Icon name="chevronDown" size={12} class="modelbtn__chev" />
      </button>

      <Show when={open()}>
        <div class="modelmenu__pop rise-in">
          <VirtualList
            items={ENGINE_OPTIONS}
            rowHeight={27}
            height={Math.min(270, Math.max(54, ENGINE_OPTIONS.length * 27))}
            class="modelmenu__list"
            render={(engine) => (
              <button
                class="modelmenu__item"
                classList={{ 'modelmenu__item--on': engine === props.value }}
                onClick={() => {
                  setOpen(false);
                  if (engine !== props.value) props.onChange(engine);
                }}
              >
                <span class="modelmenu__check">
                  <Show when={engine === props.value}>
                    <Icon name="check" size={13} />
                  </Show>
                </span>
                <span class="modelmenu__model truncate">{ENGINE_LABELS[engine]}</span>
              </button>
            )}
          />
        </div>
      </Show>
    </div>
  );
}

/** Fixed, non-LLM service credentials. Kept separate from model endpoints. */
export function ApiSettings() {
  const [engineBusy, setEngineBusy] = createSignal(false);
  const [engines, { mutate: setEngineResource }] = createResource(() => invoke<TexEngine>('get_tex_engine'));
  createEffect(() => {
    const engine = engines();
    if (engine) setTexEngine(engine);
  });
  const [serpapi, { mutate: mutateSerpapi }] = createResource(agentApi.getSerpapiConfig);
  const [keys, setKeys] = createSignal<Record<string, string>>({});
  const [revealed, setRevealed] = createSignal<Record<string, boolean>>({});
  const [saving, setSaving] = createSignal<Record<string, boolean>>({});
  const [query, setQuery] = createSignal('');
  const apiEntries = [
    { id: 'serpapi', label: 'SerpAPI key', resource: serpapi, mutate: mutateSerpapi, save: agentApi.setSerpapiKey },
  ];
  // The whole panel is queried at the granularity of one configuration each:
  // the compiler and every API credential are independent atoms. A query that
  // hides a neighbour never touches the atom that stays visible, so an open
  // field keeps accepting input exactly as before.
  const engineSearch = () =>
    `LaTeX compiler ${ENGINE_OPTIONS.map((engine) => ENGINE_LABELS[engine]).join(' ')}`;
  const engineVisible = createMemo(() => {
    const q = query().trim().toLowerCase();
    return !q || engineSearch().toLowerCase().includes(q);
  });
  const filteredEntries = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q
      ? apiEntries.filter(
          (entry) => `${entry.label} ${entry.resource()?.keyHint ?? ''}`.toLowerCase().includes(q),
        )
      : apiEntries;
  });
  const nothingVisible = createMemo(() => !engineVisible() && filteredEntries().length === 0);
  const close = () => {
    setApiSettingsOpen(false);
    setKeys({});
    setRevealed({});
  };
  const save = async (entry: typeof apiEntries[number]) => {
    setSaving((previous) => ({ ...previous, [entry.id]: true }));
    try {
      entry.mutate(await entry.save(keys()[entry.id] ?? ''));
      setKeys((previous) => ({ ...previous, [entry.id]: '' }));
      setRevealed((previous) => ({ ...previous, [entry.id]: false }));
      toast('ok', `${entry.label} saved`);
    } catch (err) {
      toast('error', `${entry.label} not saved`, String(err));
    } finally {
      setSaving((previous) => ({ ...previous, [entry.id]: false }));
    }
  };
  const changeEngine = async (engine: TexEngine) => {
    if (engineBusy()) return;
    setEngineBusy(true);
    try {
      const saved = await invoke<TexEngine>('set_tex_engine', { engine });
      setEngineResource(saved);
      setTexEngine(saved);
      toast('ok', 'Compiler saved', saved);
    } catch (err) {
      toast('error', 'Compiler not saved', String(err));
    } finally {
      setEngineBusy(false);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div class="modal modal--wide" role="dialog" aria-label="Settings" onKeyDown={onKey}>
        <header class="modal__head">
          <div>
            <h2>Settings</h2>
          </div>
          <button class="icon-btn" onClick={close} aria-label="Close" data-tooltip="Close"><Icon name="x" size={15} /></button>
        </header>
        <div class="modal__body">
          <div class="clearable-search">
            <input class="input" aria-label="Search settings" placeholder="Search settings…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
            <SearchClear value={query()} onClear={() => setQuery('')} />
          </div>
          <Show when={engineVisible()}>
            <section class="field">
              <label class="field__label">LaTeX compiler</label>
              <EngineSelect value={engines() ?? texEngine()} disabled={engineBusy() || engines.loading} onChange={(engine) => void changeEngine(engine)} />
              <p class="field__hint">This setting is stored by the backend and used for automatic builds.</p>
            </section>
          </Show>
          <Show when={filteredEntries().length > 0}>
            <div class="model-list">
              <VirtualList items={filteredEntries()} rowHeight={72} height={Math.min(372, Math.max(72, filteredEntries().length * 72))} class="model-list__window" render={(entry) => (
              <section class="field">
                <label class="field__label">{entry.label}</label>
                <div class="field__row">
                  <input id={`${entry.id}-key`} class="input" aria-label={entry.label} type={revealed()[entry.id] ? 'text' : 'password'} placeholder={entry.resource()?.keyHint ? `stored · ${entry.resource()?.keyHint}` : `Enter ${entry.label}`} value={keys()[entry.id] ?? ''} autocomplete="off" spellcheck={false} onInput={(event) => setKeys((previous) => ({ ...previous, [entry.id]: event.currentTarget.value }))} />
                  <button type="button" class="icon-btn" aria-label={revealed()[entry.id] ? 'Hide' : 'Show'} data-tooltip={revealed()[entry.id] ? 'Hide' : 'Show'} onClick={() => setRevealed((previous) => ({ ...previous, [entry.id]: !previous[entry.id] }))}><Icon name={revealed()[entry.id] ? 'eyeOff' : 'eye'} size={14} /></button>
                  <button type="button" class="btn btn--solid" disabled={saving()[entry.id] || entry.resource.loading || !(keys()[entry.id] ?? '').trim()} onClick={() => save(entry)}>{saving()[entry.id] ? 'Saving…' : 'Save'}</button>
                </div>
              </section>
              )} />
            </div>
          </Show>
          <Show when={nothingVisible()}>
            <div class="empty">
              <Icon name="search" size={20} />
              <p class="empty__title">No settings match</p>
              <p class="empty__hint">Try a different search, or clear it to show every setting.</p>
            </div>
          </Show>
          <Show when={serpapi.error}><p class="field__hint" role="alert">Could not load SerpAPI settings: {String(serpapi.error)}</p></Show>
        </div>
      </div>
    </div>
  );
}
