import { createSignal, For, Show } from 'solid-js';

import { Icon } from '../Icon';
import { toast } from '../../store/ui';
import type { Agent } from '../../store/agent';
import type { Workspace } from '../../store/workspace';

const MODES = [
  { id: 'agent', label: 'Agent', hint: 'Edits files, runs commands' },
  { id: 'plan', label: 'Plan', hint: 'Read-only, proposes a plan' },
  { id: 'ask', label: 'Ask', hint: 'Answers from context only' },
] as const;

const SUGGESTIONS = [
  'Why does the tree slow down past 50k nodes?',
  'Rebuild the paper PDF after tightening Table 1',
  'Audit the JSONL frame enum against the renderer',
];

export function Composer(props: { agent: Agent; ws: Workspace }) {
  const [text, setText] = createSignal('');
  const [mode, setMode] = createSignal<(typeof MODES)[number]['id']>('agent');
  let area: HTMLTextAreaElement | undefined;

  const grow = () => {
    if (!area) return;
    area.style.height = '0px';
    area.style.height = `${Math.min(220, Math.max(24, area.scrollHeight))}px`;
  };

  const submit = () => {
    const value = text();
    if (!value.trim()) return;
    // The agent's tools are sandboxed to a workspace, so a prompt sent without
    // one has nowhere to read from. Saying so beats a turn that opens with a
    // tool error the model has to reason around.
    if (!props.ws.root()) {
      toast('error', 'No folder open', 'Open a folder first — the agent reads and writes inside it');
      return;
    }
    void props.agent.send(value, props.ws.root()!);
    setText('');
    queueMicrotask(grow);
  };

  const estimate = () => Math.ceil(text().length / 3.6);

  return (
    <div class="composer">
      <Show when={!text().trim()}>
        <div class="composer__sugg">
          <For each={SUGGESTIONS}>
            {(s) => (
              <button class="sugg" onClick={() => setText(s)}>
                <Icon name="sparkles" size={11} />
                <span class="truncate">{s}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="composer__box">
        <textarea
          ref={area}
          class="composer__input"
          rows={1}
          placeholder="Ask the agent, or describe a change…"
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            grow();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !(e as unknown as { isComposing?: boolean }).isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div class="composer__bar">
          <div class="composer__left">
            <div class="segmented segmented--sm">
              <For each={MODES}>
                {(m) => (
                  <button
                    class="segmented__item"
                    classList={{ 'segmented__item--on': mode() === m.id }}
                    title={m.hint}
                    onClick={() => setMode(m.id)}
                  >
                    {m.label}
                  </button>
                )}
              </For>
            </div>
            <button
              class="icon-btn"
              title="Attach context"
              onClick={() => toast('info', 'Context picker', 'Renderer-only stub for now')}
            >
              <Icon name="paperclip" size={14} />
            </button>
            <button
              class="icon-btn"
              title="Reference a file"
              onClick={() => toast('info', 'File reference', 'Type @ to search the tree')}
            >
              <Icon name="hash" size={14} />
            </button>
          </div>

          <div class="composer__right">
            <Show when={text().trim()}>
              <span class="composer__count">~{estimate()} tok</span>
            </Show>
            <Show
              when={props.agent.busy()}
              fallback={
                <button
                  class="send"
                  classList={{ 'send--ready': text().trim().length > 0 }}
                  onClick={submit}
                  title="Send  ⏎"
                >
                  <Icon name="arrowUp" size={15} stroke={2} />
                </button>
              }
            >
              <button class="send send--stop" onClick={() => props.agent.abort()} title="Interrupt">
                <Icon name="stop" size={13} />
              </button>
            </Show>
          </div>
        </div>
      </div>

      <div class="composer__foot">
        <span>
          <span class="kbd">⏎</span> send
        </span>
        <span>
          <span class="kbd">⇧⏎</span> newline
        </span>
      </div>
    </div>
  );
}
