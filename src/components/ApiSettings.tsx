import { createMemo, createResource, createSignal, Show } from 'solid-js';

import { Icon } from './Icon';
import { SearchClear } from './SearchClear';
import { VirtualList } from './VirtualList';
import { agentApi } from '../lib/agent';
import { setApiSettingsOpen, toast } from '../store/ui';

/** Fixed, non-LLM service credentials. Kept separate from model endpoints. */
export function ApiSettings() {
  const [serpApi, { mutate }] = createResource(agentApi.getSerpApiConfig);
  const [key, setKey] = createSignal('');
  const [reveal, setReveal] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const apiEntries = [{ id: 'serpapi', label: 'SerpApi key' }];
  const filteredEntries = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? apiEntries.filter((entry) => entry.label.toLowerCase().includes(q)) : apiEntries;
  });
  const close = () => {
    setApiSettingsOpen(false);
    setKey('');
    setReveal(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      mutate(await agentApi.setSerpApiKey(key()));
      setKey('');
      setReveal(false);
      toast('ok', 'SerpApi key saved');
    } catch (err) {
      toast('error', 'SerpApi key not saved', String(err));
    } finally {
      setBusy(false);
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
                <input id={`${entry.id}-key`} class="input" type={reveal() ? 'text' : 'password'} placeholder={serpApi()?.keyHint ? `stored · ${serpApi()?.keyHint}` : 'Enter SerpApi key'} value={key()} autocomplete="off" spellcheck={false} onInput={(event) => setKey(event.currentTarget.value)} />
                <button type="button" class="icon-btn" aria-label={reveal() ? 'Hide' : 'Show'} data-tooltip={reveal() ? 'Hide' : 'Show'} onClick={() => setReveal(!reveal())}><Icon name={reveal() ? 'eyeOff' : 'eye'} size={14} /></button>
                <button type="button" class="btn btn--solid" disabled={busy() || serpApi.loading || !key().trim()} onClick={save}>{busy() ? 'Saving…' : 'Save'}</button>
              </div>
            </section>
            )} />
          </div>
          <Show when={serpApi.error}><p class="field__hint" role="alert">Could not load SerpApi settings: {String(serpApi.error)}</p></Show>
        </div>
      </div>
    </div>
  );
}
