import { createMemo, createResource, createSignal, Show } from 'solid-js';

import { Icon } from './Icon';
import { SearchClear } from './SearchClear';
import { VirtualList } from './VirtualList';
import { agentApi } from '../lib/agent';
import { setApiSettingsOpen, toast } from '../store/ui';

/** Fixed, non-LLM service credentials. Kept separate from model endpoints. */
export function ApiSettings() {
  const [openAlex, { mutate: mutateOpenAlex }] = createResource(agentApi.getOpenAlexConfig);
  const [keys, setKeys] = createSignal<Record<string, string>>({});
  const [revealed, setRevealed] = createSignal<Record<string, boolean>>({});
  const [saving, setSaving] = createSignal<Record<string, boolean>>({});
  const [query, setQuery] = createSignal('');
  const apiEntries = [
    { id: 'openalex', label: 'OpenAlex key', resource: openAlex, mutate: mutateOpenAlex, save: agentApi.setOpenAlexKey },
  ];
  const filteredEntries = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? apiEntries.filter((entry) => entry.label.toLowerCase().includes(q)) : apiEntries;
  });
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
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div class="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div class="modal modal--wide" role="dialog" aria-label="API settings" onKeyDown={onKey}>
        <header class="modal__head">
          <div>
            <h2>API settings</h2>
          </div>
          <button class="icon-btn" onClick={close} aria-label="Close" data-tooltip="Close"><Icon name="x" size={15} /></button>
        </header>
        <div class="modal__body">
          <div class="model-list">
            <div class="clearable-search model-list__search">
              <input class="input" aria-label="Search APIs" placeholder="Search APIs…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
              <SearchClear value={query()} onClear={() => setQuery('')} />
            </div>
            <VirtualList items={filteredEntries()} rowHeight={72} height={Math.min(372, Math.max(72, filteredEntries().length * 72))} class="model-list__window" render={(entry) => (
            <section class="field">
              <label class="field__label" for={`${entry.id}-key`}>{entry.label}</label>
              <div class="field__row">
                <input id={`${entry.id}-key`} class="input" type={revealed()[entry.id] ? 'text' : 'password'} placeholder={entry.resource()?.keyHint ? `stored · ${entry.resource()?.keyHint}` : `Enter ${entry.label}`} value={keys()[entry.id] ?? ''} autocomplete="off" spellcheck={false} onInput={(event) => setKeys((previous) => ({ ...previous, [entry.id]: event.currentTarget.value }))} />
                <button type="button" class="icon-btn" aria-label={revealed()[entry.id] ? 'Hide' : 'Show'} data-tooltip={revealed()[entry.id] ? 'Hide' : 'Show'} onClick={() => setRevealed((previous) => ({ ...previous, [entry.id]: !previous[entry.id] }))}><Icon name={revealed()[entry.id] ? 'eyeOff' : 'eye'} size={14} /></button>
                <button type="button" class="btn btn--solid" disabled={saving()[entry.id] || entry.resource.loading || !(keys()[entry.id] ?? '').trim()} onClick={() => save(entry)}>{saving()[entry.id] ? 'Saving…' : 'Save'}</button>
              </div>
            </section>
            )} />
          </div>
          <Show when={openAlex.error}><p class="field__hint" role="alert">Could not load OpenAlex settings: {String(openAlex.error)}</p></Show>
        </div>
      </div>
    </div>
  );
}
