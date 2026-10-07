import { createEffect, createSignal, For, Show } from 'solid-js';

import { Icon } from '../Icon';
import { markdown } from '../../lib/markdown';
import type { Agent, Item } from '../../store/agent';
import type { Workspace } from '../../store/workspace';

export function AgentThread(props: { agent: Agent; ws: Workspace }) {
  let scroller: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(true);
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  createEffect(() => {
    props.agent.items().length;
    if (pinned() && scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  const onScroll = () => {
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setPinned(distance < 80);
  };

  return (
    <div class="thread-wrap">
      <div class="thread scroll" ref={scroller} onScroll={onScroll}>
        <div class="thread__intro">
          <span class="thread__sess">
            session <code>{props.agent.session().id}</code> · {props.agent.session().cwd}
          </span>
        </div>

        <For each={props.agent.items()}>
          {(item) => (
            <>
              <Show when={item.kind === 'assistant' && item.streaming && item.text === ''}>
                <ThinkingRow />
              </Show>
              <ThreadItem
                item={item}
                agent={props.agent}
                ws={props.ws}
                open={expanded()[keyOf(item)] ?? false}
                onToggle={() =>
                  setExpanded((prev) => ({ ...prev, [keyOf(item)]: !prev[keyOf(item)] }))
                }
              />
            </>
          )}
        </For>

        <Show when={props.agent.busy()}>
          <div class="thread__working">
            <span class="pulse" />
            <span>working · turn {props.agent.items().filter((i) => i.kind === 'tool').length + 1}</span>
          </div>
        </Show>
      </div>

      <Show when={!pinned()}>
        <button
          class="thread__jump"
          onClick={() => {
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            setPinned(true);
          }}
        >
          <Icon name="arrowRight" size={13} style={{ transform: 'rotate(90deg)' }} />
          Jump to latest
        </button>
      </Show>
    </div>
  );
}

function keyOf(item: Item): string {
  return `${item.kind}:${item.id}`;
}

function ThinkingRow() {
  return (
    <div class="msg msg--thinking">
      <span class="dots">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function ThreadItem(props: {
  item: Item;
  agent: Agent;
  ws: Workspace;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <Show when={props.item.kind === 'user'}>
        <div class="msg msg--user">
          <div class="bubble">{(props.item as any).text}</div>
        </div>
      </Show>

      <Show when={props.item.kind === 'assistant'}>
        <div class="msg msg--ai">
          <div class="msg__avatar">
            <Icon name="sparkles" size={13} />
          </div>
          <div class="msg__body markdown" innerHTML={markdown((props.item as any).text)} />
          <Show when={(props.item as any).streaming}>
            <span class="caret" />
          </Show>
        </div>
      </Show>

      <Show when={props.item.kind === 'tool'}>
        <ToolCard
          tool={props.item as any}
          agent={props.agent}
          ws={props.ws}
          open={props.open}
          onToggle={props.onToggle}
        />
      </Show>

      <Show when={props.item.kind === 'patch'}>
        <button
          class="patch"
          onClick={() => props.ws.openFile((props.item as any).path)}
          title="Open changed file"
        >
          <span class="patch__op">{(props.item as any).op === 'create' ? 'A' : (props.item as any).op === 'delete' ? 'D' : 'M'}</span>
          <span class="patch__path truncate">{(props.item as any).path}</span>
          <span class="patch__size">+{Math.round(((props.item as any).bytes as number) / 102.4) / 10} KB</span>
        </button>
      </Show>

      <Show when={props.item.kind === 'notice'}>
        <div class="notice" classList={{ 'notice--error': (props.item as any).tone === 'error' }}>
          <Icon name="alert" size={13} />
          {(props.item as any).text}
        </div>
      </Show>
    </>
  );
}

function ToolCard(props: {
  tool: {
    callId: string;
    name: string;
    input: string;
    output: string;
    status: 'running' | 'ok' | 'error';
    summary: string;
  };
  agent: Agent;
  ws: Workspace;
  open: boolean;
  onToggle: () => void;
}) {
  const tool = () => props.tool;
  const icon = () =>
    tool().name === 'bash' || tool().name === 'latexmk'
      ? 'terminal'
      : tool().name === 'grep'
        ? 'search'
        : tool().name === 'edit' || tool().name === 'write'
          ? 'pencil'
          : tool().name === 'read'
            ? 'fileText'
            : 'cpu';

  return (
    <div class="tool" classList={{ 'tool--open': props.open, 'tool--running': tool().status === 'running' }}>
      <button class="tool__head" onClick={props.onToggle}>
        <Icon name={icon()} size={13} class="tool__icon" />
        <span class="tool__name">{props.agent.label(tool().name)}</span>
        <span class="tool__input truncate">{firstLine(tool().input)}</span>
        <Show when={tool().summary}>
          <span class="tool__summary truncate">{tool().summary}</span>
        </Show>
        <Show
          when={tool().status === 'running'}
          fallback={
            <span class="tool__status" classList={{ 'tool__status--err': tool().status === 'error' }}>
              <Icon name={tool().status === 'ok' ? 'check' : 'x'} size={12} stroke={2} />
            </span>
          }
        >
          <span class="spinner" />
        </Show>
        <Icon name="chevronDown" size={12} class="tool__caret" />
      </button>
      <Show when={props.open}>
        <div class="tool__out">
          <Show when={tool().input.split('\n').length > 1}>
            <pre class="tool__io">{tool().input}</pre>
          </Show>
          <pre class="tool__io tool__io--out">{tool().output || '…'}</pre>
        </div>
      </Show>
    </div>
  );
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}
