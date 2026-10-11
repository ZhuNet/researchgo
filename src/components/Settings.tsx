import { createResource, createSignal, For, Show } from 'solid-js';

import { Icon } from './Icon';
import { setSettingsOpen, toast } from '../store/ui';
import { agentApi, type ConfigView, type LlmView } from '../lib/agent';

/**
 * The stored LLM endpoints, and the only place a key is ever typed.
 *
 * A list rather than a single endpoint, because "one URL, one key" does not
 * survive first contact with someone who has a subscription, a local Ollama,
 * and a gateway. Each row is one endpoint+model pair; the active row is the one
 * the agent calls.
 *
 * The key is write-only across this boundary: the host returns a fingerprint
 * rather than the secret, so the form shows what is stored without ever holding
 * it. An empty key field on save means "keep the stored one", which is what
 * makes it safe to open this dialog, read it, and close it.
 */
export function Settings() {
  const [store, { mutate }] = createResource(fetchConfigs);
  /** The row being edited, or null when the list is showing. */
  const [editing, setEditing] = createSignal<string | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

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
          <button class="icon-btn" onClick={close} title="Close">
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
                <For each={store()?.configs}>
                  {(c) => (
                    <ConfigRow
                      config={c}
                      busy={busy()}
                      onEdit={() => setEditing(c.name)}
                      onActivate={async () => {
                        setBusy(true);
                        try {
                          mutate(await agentApi.setActive(c.name));
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
                  )}
                </For>
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
        disabled={props.busy || props.config.active}
        title={props.config.active ? 'In use' : 'Use this model'}
      >
        <span class="model__dot" classList={{ 'model__dot--on': props.config.active }} />
      </button>

      <button class="model__main" onClick={props.onEdit} disabled={props.busy}>
        <span class="model__name truncate">{props.config.name}</span>
        <span class="model__meta truncate">
          {props.config.model} · {hostOf(props.config.url)}
        </span>
      </button>

      <Show when={!props.config.ready}>
        <span class="chip chip--warn" title="missing url, key or model">
          incomplete
        </span>
      </Show>

      <button
        class="icon-btn icon-btn--danger"
        onClick={props.onDelete}
        disabled={props.busy}
        title={`Delete ${props.config.name}`}
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
  const [model, setModel] = createSignal(props.existing?.model ?? '');
  const [name, setName] = createSignal(props.existing?.name ?? '');
  const [key, setKey] = createSignal('');
  const [reveal, setReveal] = createSignal(false);

  /**
   * Names already in use, offered as suggestions.
   *
   * Empty when the list is empty, which is the only time a first name has
   * nothing to collide with — the dropdown appears as soon as there is
   * something to pick and disappears when everything has been removed.
   */
  const known = () => props.taken.map((c) => c.name);

  const submit = async (e: Event) => {
    e.preventDefault();
    props.onBusy(true);
    const payload = {
      url: url().trim(),
      name: name().trim(),
      model: model().trim(),
      apiKey: key().trim(),
    };
    try {
      const next = props.existing
        ? await agentApi.updateConfig(props.existing.name, payload)
        : await agentApi.addConfig(payload);
      props.onSaved(next);
    } catch (err) {
      props.onError(String(err));
    } finally {
      props.onBusy(false);
    }
  };

  return (
    <form class="modal__body" onSubmit={submit}>
      <section class="field">
        <label class="field__label" for="set-name">
          Name
        </label>
        <input
          id="set-name"
          class="input"
          list="rg-known-models"
          placeholder="OpenAI"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <datalist id="rg-known-models">
          <For each={known()}>{(n) => <option value={n} />}</For>
        </datalist>
        <p class="field__hint">
          Unique, and case matters — <code>Prod</code> and <code>prod</code> are two models.
        </p>
      </section>

      <section class="field">
        <label class="field__label" for="set-url">
          Base URL
        </label>
        <input
          id="set-url"
          class="input"
          type="url"
          placeholder="https://api.openai.com/v1"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
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
            placeholder={props.existing?.keyHint ? `stored · ${props.existing.keyHint}` : 'sk-…'}
            value={key()}
            autocomplete="off"
            spellcheck={false}
            onInput={(e) => setKey(e.currentTarget.value)}
          />
          <button
            type="button"
            class="icon-btn"
            title={reveal() ? 'Hide' : 'Show'}
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
        <label class="field__label" for="set-model">
          Model
        </label>
        <input
          id="set-model"
          class="input"
          placeholder="gpt-4o"
          value={model()}
          onInput={(e) => setModel(e.currentTarget.value)}
        />
        <p class="field__hint">The model id the endpoint expects.</p>
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

/** `https://api.openai.com/v1` → `api.openai.com`, enough to tell rows apart. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}