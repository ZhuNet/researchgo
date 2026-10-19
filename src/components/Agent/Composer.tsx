import { createMemo, createSignal, Show } from 'solid-js';

import { Icon } from '../Icon';
import { toast } from '../../store/ui';
import type { Agent } from '../../store/agent';
import type { Workspace } from '../../store/workspace';

export function Composer(props: { agent: Agent; ws: Workspace }) {
  const [text, setText] = createSignal('');
  const [includeSelection, setIncludeSelection] = createSignal(true);
  let area: HTMLTextAreaElement | undefined;

  const selection = createMemo(() => {
    const value = props.ws.editorSelection();
    return value?.path === props.ws.active() && value.text ? value : null;
  });

  const relativePath = () => {
    const value = selection();
    const root = props.ws.root();
    if (!value || !root) return '';
    return value.path.slice(root.length).replace(/^[\\/]+/, '').replaceAll('\\', '/');
  };

  const preview = () => selection()?.text.replace(/\s+/g, ' ').trim() ?? '';

  const grow = () => {
    if (!area) return;
    area.style.height = '0px';
    area.style.height = `${Math.min(220, Math.max(24, area.scrollHeight))}px`;
  };

  const submit = () => {
    const value = text();
    if (!value.trim()) return;
    // One action at a time. The send button is already a stop button while a
    // turn is running, but Enter is not — and clearing the draft for a prompt
    // that was never sent is the worst possible reading of "ignored".
    if (props.agent.busy()) return;
    // The agent's tools are sandboxed to a workspace, so a prompt sent without
    // one has nowhere to read from. Saying so beats a turn that opens with a
    // tool error the model has to reason around.
    if (!props.ws.root()) {
      toast('error', 'No folder open', 'Open a folder first — the agent reads and writes inside it');
      return;
    }
    void props.agent.send(value, props.ws.root()!, includeSelection() ? selection() : null);
    setText('');
    queueMicrotask(grow);
  };

  const estimate = () => Math.ceil(text().length / 3.6);

  return (
    <div class="composer">
      <Show when={selection()}>
        <button
          class="composer__selection"
          classList={{ 'composer__selection--off': !includeSelection() }}
          onClick={() => setIncludeSelection((value) => !value)}
          title={includeSelection() ? 'Do not include this selection' : 'Include this selection'}
          aria-pressed={includeSelection()}
        >
          <span class="composer__selection-check">
            <Show when={includeSelection()}>
              <Icon name="check" size={11} stroke={2} />
            </Show>
          </span>
          <span class="composer__selection-text">
            <strong>{relativePath()}</strong>
            <span>[{preview()}]</span>
          </span>
        </button>
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
              {/* One button for both halves of the turn, disabled in both of
                  the states where there is nothing to press. `sending` has no
                  turn to interrupt yet, and `stopping` is a stop already in
                  flight — arming it again would queue a second prompt against
                  a transcript the host is still finishing with. */}
              <button
                class="send send--stop"
                classList={{ 'send--busy': !props.agent.stoppable() }}
                disabled={!props.agent.stoppable()}
                onClick={() => void props.agent.abort()}
                title={props.agent.stopping() ? 'Stopping…' : 'Interrupt'}
              >
                <Show
                  when={props.agent.stopping()}
                  fallback={<Icon name="stop" size={13} />}
                >
                  <Icon name="refresh" size={13} class="spin" />
                </Show>
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
