import { createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';

import { Icon } from './Icon';
import { setSettingsOpen, toast } from '../store/ui';
import { agentApi, onLlmConfigChange, type ConfigView, type LlmView } from '../lib/agent';
import { VirtualList } from './VirtualList';

/**
 * The stored LLM endpoints, and the only place a key is ever typed.
 *
 * A list rather than a single endpoint, because "one URL, one key" does not
 * survive first contact with someone who has a subscription, a local Ollama,
 * and a gateway. Each row is one endpoint with the models it serves; the
 * active (name, model) pair is the one the agent calls.
 *
 * The key is write-only across this boundary: the host returns a fingerprint
 * rather than the secret, so the form shows what is stored without ever holding
 * it. An empty key field on save means "keep the stored one", which is what
 * makes it safe to open this dialog, read it, and close it.
 */
export function Settings() {
  const [store, { mutate, refetch }] = createResource(fetchConfigs);
  /** The row being edited, or null when the list is showing. */
  const [editing, setEditing] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [configQuery, setConfigQuery] = createSignal('');
  const filteredConfigs = createMemo(() => {
    const q = configQuery().trim().toLowerCase();
    const all = store()?.configs ?? [];
    return q ? all.filter((c) => `${c.name} ${c.url} ${c.models.join(' ')}`.toLowerCase().includes(q)) : all;
  });

  // `llm.json` can be edited by hand while this dialog is open; the list
  // should show that, not the snapshot from when it opened. A save from here
  // also rewrites the file, which lands as the same event — a refetch of
  // what `mutate` already applied, and nothing more.
  onCleanup(onLlmConfigChange(() => refetch()));

  const close = () => {
    setSettingsOpen(false);
    setEditing(null);
    setCreating(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div
      class="modal-backdrop"
      // `mousedown` rather than `click`: a drag that starts inside the dialog
      // and ends on the backdrop — selecting text and letting go slightly wide —
      // must not read as a dismissal. `click` fires for that, and the dialog
      // closes under the user's cursor mid-selection.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        class="modal modal--wide"
        role="dialog"
        aria-label="Settings"
        onKeyDown={onKey}
      >
        <header class="modal__head">
          <h2>Models</h2>
          <button class="icon-btn" onClick={close} aria-label="Close" data-tooltip="Close">
            <Icon name="x" size={15} />
          </button>
        </header>

        <Show
          when={!creating() && editing() === null}
          fallback={
            <Show when={creating() || editing() !== null}>
              <ConfigForm
                existing={
                  editing() ? store()?.configs.find((c) => c.name === editing()) : undefined
                }
                taken={store()?.configs ?? []}
                busy={busy()}
                onCancel={() => {
                  setCreating(false);
                  setEditing(null);
                }}
                onSaved={(next) => {
                  mutate(next);
                  setCreating(false);
                  setEditing(null);
                  toast('ok', 'Saved');
                }}
                onError={(msg) => toast('error', 'Not saved', msg)}
                onBusy={setBusy}
              />
            </Show>
          }
        >
          <div class="modal__body">
            <Show
              when={(store()?.configs.length ?? 0) > 0}
              fallback={
                <div class="empty">
                  <Icon name="sparkles" size={20} />
                  <p class="empty__title">No models configured</p>
                  <p class="empty__hint">
                    Add an endpoint to let the agent run. The key is stored on this machine.
                  </p>
                </div>
              }
            >
              <div class="model-list">
                <input class="input model-list__search" placeholder="Search providers and models…" value={configQuery()} onInput={(e) => setConfigQuery(e.currentTarget.value)} />
                <VirtualList items={filteredConfigs()} rowHeight={62} height={Math.min(372, Math.max(62, filteredConfigs().length * 62))} class="model-list__window" render={(c) => (
                    <ConfigRow
                      config={c}
                      busy={busy()}
                      onEdit={() => setEditing(c.name)}
                      onActivate={async () => {
                        setBusy(true);
                        try {
                          mutate(await agentApi.setActive(c.name, c.models[0]));
                        } catch (err) {
                          toast('error', 'Could not switch', String(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                      onDelete={async () => {
                        setBusy(true);
                        try {
                          mutate(await agentApi.deleteConfig(c.name));
                          toast('info', 'Removed', c.name);
                        } catch (err) {
                          toast('error', 'Could not remove', String(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                  )} />
              </div>
            </Show>
          </div>

          <footer class="modal__foot">
            <span class="modal__note">
              The active model is the one the agent calls.
            </span>
            <button class="btn btn--solid" onClick={() => setCreating(true)}>
              <Icon name="plus" size={13} />
              Add model
            </button>
          </footer>
        </Show>
      </div>
    </div>
  );
}

function ConfigRow(props: {
  config: LlmView;
  busy: boolean;
  onEdit: () => void;
  onActivate: () => void;
  onDelete: () => void;
}) {
  return (
    <div class="model" classList={{ 'model--active': props.config.active }}>
      <button
        class="model__pick"
        onClick={props.onActivate}
        disabled={props.busy || props.config.active || props.config.models.length === 0}
        aria-label="Use this model"
        data-tooltip={
          props.config.active
            ? 'In use'
            : props.config.models.length === 0
              ? 'Add a model to this entry first'
              : 'Use this model'
        }
      >
        <span class="model__dot" classList={{ 'model__dot--on': props.config.active }} />
      </button>

      <button class="model__main" onClick={props.onEdit} disabled={props.busy}>
        <span class="model__name truncate">{props.config.name}</span>
        <span class="model__meta truncate">
          {props.config.models.join(', ')} · {hostOf(props.config.url)}
        </span>
      </button>

      <Show when={!props.config.ready}>
        <span class="chip chip--warn" data-tooltip="missing url, key or model">
          incomplete
        </span>
      </Show>

      <button
        class="icon-btn icon-btn--danger"
        onClick={props.onDelete}
        disabled={props.busy}
        aria-label={`Delete ${props.config.name}`}
        data-tooltip={`Delete ${props.config.name}`}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}

function ConfigForm(props: {
  existing?: LlmView;
  taken: LlmView[];
  busy: boolean;
  onCancel: () => void;
  onSaved: (next: ConfigView) => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [url, setUrl] = createSignal(props.existing?.url ?? '');
  const [models, setModels] = createSignal<string[]>(
    props.existing?.models.length ? [...props.existing.models] : [''],
  );
  const [name, setName] = createSignal(props.existing?.name ?? '');
  const [key, setKey] = createSignal('');
  const [reveal, setReveal] = createSignal(false);
  /** The entry being edited, which picking from history can change mid-form. */
  const [current, setCurrent] = createSignal<LlmView | undefined>(props.existing);
  /** Which history dropdown is open: the name field's, or a model row's. */
  const [histAt, setHistAt] = createSignal<'name' | 'url' | number | null>(null);
  const [modelQuery, setModelQuery] = createSignal('');

  const setModel = (at: number, value: string) => {
    setModels((prev) => prev.map((m, i) => (i === at ? value : m)));
  };
  const removeModel = (at: number) => {
    // Rows shift when one goes, so any open history dropdown closes rather
    // than follow an index that now names a different row.
    setHistAt(null);
    setModels((prev) => prev.filter((_, i) => i !== at));
  };
  const addModel = () => {
    setHistAt(null);
    setModels((prev) => [...prev, '']);
  };

  /** Every model id already saved somewhere, once each, in list order. */
  const modelHistory = () => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of props.taken) {
      for (const m of c.models) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
    }
    return out;
  };

  const suggestions = (values: string[], value: string) => {
    const query = value.trim().toLowerCase();
    return [...new Set(values)].filter(
      (item) => item !== value && item.toLowerCase().includes(query),
    );
  };
  const nameSuggestions = () => suggestions(props.taken.map((c) => c.name), name());
  const urlSuggestions = () => suggestions(props.taken.map((c) => c.url).filter(Boolean), url());

  /** Loads a saved entry into the form: picking history is choosing what to edit. */
  const loadEntry = (entry: LlmView) => {
    setCurrent(entry);
    setName(entry.name);
    setUrl(entry.url);
    setModels(entry.models.length ? [...entry.models] : ['']);
    // The key never crosses this boundary; the placeholder says one is stored.
    setKey('');
    setHistAt(null);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    props.onBusy(true);
    const payload = {
      url: url().trim(),
      name: name().trim(),
      models: models().map((m) => m.trim()).filter(Boolean),
      apiKey: key().trim(),
    };
    try {
      const target = current();
      const next = target
        ? await agentApi.updateConfig(target.name, payload)
        : await agentApi.addConfig(payload);
      props.onSaved(next);
    } catch (err) {
      props.onError(String(err));
    } finally {
      props.onBusy(false);
    }
  };

  return (
    <form class="modal__body" autocomplete="off" onSubmit={submit}>
      <section class="field">
        <label class="field__label" for="set-name">
          Name
        </label>
        <div class="hist">
          <input
            id="set-name"
            class="input hist__input"
            placeholder="OpenAI"
            autocomplete="off"
            value={name()}
            onFocus={() => setHistAt('name')}
            onBlur={() => setHistAt((at) => (at === 'name' ? null : at))}
            onInput={(e) => {
              setName(e.currentTarget.value);
              setHistAt('name');
            }}
          />
          <Show when={histAt() === 'name' && nameSuggestions().length > 0}>
            <HistoryPop
              items={nameSuggestions()}
              onPick={(v) => {
                const entry = props.taken.find((c) => c.name === v);
                if (entry) loadEntry(entry);
              }}
              onClose={() => setHistAt(null)}
            />
          </Show>
        </div>
        <p class="field__hint">
          Unique, and case matters — <code>Prod</code> and <code>prod</code> are two entries.
        </p>
      </section>

      <section class="field">
        <label class="field__label" for="set-url">
          Base URL
        </label>
        <div class="hist">
        <input
          id="set-url"
          class="input hist__input"
          type="url"
          autocomplete="off"
          placeholder="https://api.openai.com/v1"
          value={url()}
          onFocus={() => setHistAt('url')}
          onBlur={() => setHistAt((at) => at === 'url' ? null : at)}
          onInput={(e) => {
            setUrl(e.currentTarget.value);
            setHistAt('url');
          }}
        />
        <Show when={histAt() === 'url' && urlSuggestions().length > 0}>
          <HistoryPop
            items={urlSuggestions()}
            onPick={(value) => { setUrl(value); setHistAt(null); }}
            onClose={() => setHistAt(null)}
          />
        </Show>
        </div>
        <p class="field__hint">
          Any OpenAI-compatible endpoint. The <code>/chat/completions</code> suffix is added
          for you, so leave it off.
        </p>
      </section>

      <section class="field">
        <label class="field__label" for="set-key">
          API key
        </label>
        <div class="field__row">
          <input
            id="set-key"
            class="input"
            type={reveal() ? 'text' : 'password'}
            placeholder={current()?.keyHint ? `stored · ${current()?.keyHint}` : 'sk-…'}
            value={key()}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setKey(e.currentTarget.value)}
          />
          <button
            type="button"
            class="icon-btn"
            aria-label={reveal() ? 'Hide' : 'Show'}
            data-tooltip={reveal() ? 'Hide' : 'Show'}
            onClick={() => setReveal(!reveal())}
          >
            <Icon name={reveal() ? 'eyeOff' : 'eye'} size={14} />
          </button>
        </div>
        <p class="field__hint">
          Stored on this machine, never in the browser. Leave blank to keep the stored key.
        </p>
      </section>

      <section class="field">
        <label class="field__label">Models</label>
        <input class="input model-list__search" placeholder="Filter model rows…" value={modelQuery()} onInput={(e) => setModelQuery(e.currentTarget.value)} />
        <VirtualList items={models().map((value, index) => ({ value, index })).filter(({ value }) => !modelQuery().trim() || value.toLowerCase().includes(modelQuery().trim().toLowerCase()))} rowHeight={42} height={Math.min(252, Math.max(42, models().length * 42))} class="models__window" render={({ index: i, value: m }) => (
          <div class="field__row hist">
              <input class="input hist__input" autocomplete="off" placeholder="gpt-4o" value={m}
                onFocus={() => setHistAt(i)} onBlur={() => setHistAt((at) => at === i ? null : at)}
                onInput={(e) => { setModel(i, e.currentTarget.value); setHistAt(i); }} />
              <Show when={histAt() === i && suggestions(modelHistory(), m).length > 0}>
                <HistoryPop items={suggestions(modelHistory(), m).slice(0, 100)} onPick={(v) => { setModel(i, v); setHistAt(null); }} onClose={() => setHistAt(null)} />
              </Show>
              <button type="button" class="icon-btn icon-btn--danger" aria-label="Remove model" data-tooltip={models().length === 1 ? 'At least one model is required' : 'Remove model'} disabled={models().length === 1} onClick={() => removeModel(i)}>
                <Icon name="x" size={14} />
              </button>
          </div>
        )} />
        <button type="button" class="btn" onClick={addModel}>
          <Icon name="plus" size={13} />
          Add model
        </button>
        <p class="field__hint">
          The model ids this endpoint serves. The first one is the default when the entry is
          activated.
        </p>
      </section>

      <footer class="modal__foot modal__foot--inset">
        <span class="modal__note">Keys are sent only to the URL above, from the app process.</span>
        <div class="modal__actions">
          <button type="button" class="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" class="btn btn--solid" disabled={props.busy}>
            {props.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </form>
  );
}

async function fetchConfigs(): Promise<ConfigView> {
  try {
    return await agentApi.getConfig();
  } catch {
    return { configs: [] };
  }
}

/**
 * A history dropdown: only what is already saved, nothing inferred.
 *
 * The browser's datalist was the alternative, and it is neither — it filters
 * by whatever is typed, styles itself natively, and offers the typed text
 * back as an option. This lists the saved values and picks one. Rendered only
 * while open, so the listeners live exactly as long as the dropdown does.
 */
function HistoryPop(props: {
  items: string[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  // Keep suggestions open while interacting with their input or list.
  const onDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('.hist__pop, .hist__input')) return;
    props.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  onCleanup(() => {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div class="hist__pop rise-in">
      <For each={props.items}>
        {(v) => (
          <button
            type="button"
            class="hist__item"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(v)}
          >
            <span class="truncate">{v}</span>
          </button>
        )}
      </For>
    </div>
  );
}

/** `https://api.openai.com/v1` → `api.openai.com`, enough to tell rows apart. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
