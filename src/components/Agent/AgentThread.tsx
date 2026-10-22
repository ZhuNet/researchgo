import { createEffect, createSignal, Index, on, Show } from 'solid-js';

import { Icon } from '../Icon';
import { updateMarkdown } from '../../lib/markdown';
import type { Agent, Item } from '../../store/agent';
import { copyText } from '../../store/ui';
import type { Workspace } from '../../store/workspace';

/** Seconds to one decimal: long enough to stop the digits flickering. */
export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** What a finished turn averaged, from what it cost over how long it took. */
const rate = (tokens: number, ms: number) => (ms > 0 ? `${(tokens / (ms / 1000)).toFixed(1)} tok/s` : '');

export function AgentThread(props: { agent: Agent; ws: Workspace }) {
  let scroller: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(true);
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  const jumpToLatest = () => {
    if (!scroller) return;
    // Pinning first, before the move: the scroll that lands here fires
    // `onScroll`, and a pane that is still short of its bottom would
    // un-pin itself again on the way down.
    setPinned(true);
    scroller.scrollTop = scroller.scrollHeight;
  };

  createEffect(() => {
    props.agent.items().length;
    if (pinned() && scroller) scroller.scrollTop = scroller.scrollHeight;
  });

  // Sending is the one moment the follow rule has to be overridden. Someone
  // who scrolled back through the transcript to re-read an answer and then
  // types a follow-up would otherwise sit at that answer while their own
  // prompt, and the whole reply to it, arrive off-screen — the pane looks
  // like it swallowed the prompt. Every turn starts at the bottom; from
  // there the ordinary pinned-scroll carries the stream.
  //
  // `busy` dropping and lifting again is what a new turn looks like from
  // here, and it is deliberately not a counter on the store: `createAgent()`
  // runs once inside `App`, so a field added to it is a field a store instance
  // created before the app last hot-reloaded does not have, and reading it
  // from this effect throws and takes the whole thread down with it.
  createEffect(
    on(
      () => props.agent.busy(),
      (busy) => {
        if (!busy) return;
        jumpToLatest();
        // The row is in the DOM by now, but its markdown has not been laid
        // out yet, so a jump taken this frame can land a message short of
        // the real bottom. Correct it once the frame is painted.
        requestAnimationFrame(jumpToLatest);
      },
    ),
  );

  const onScroll = () => {
    if (!scroller) return;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    setPinned(distance < 80);
  };

  return (
    <div class="thread-wrap">
      <div class="thread scroll" ref={scroller} onScroll={onScroll}>
        <Index each={props.agent.items()}>
          {(item) => (
            <>
              <Show when={(() => {
                const value = item();
                return value.kind === 'assistant' && value.streaming && value.text === '';
              })()}>
                <ThinkingRow />
              </Show>
              <ThreadItem
                item={item()}
                agent={props.agent}
                ws={props.ws}
                open={expanded()[keyOf(item())] ?? false}
                onToggle={() =>
                  setExpanded((prev) => ({ ...prev, [keyOf(item())]: !prev[keyOf(item())] }))
                }
              />
            </>
          )}
        </Index>

        <Show when={props.agent.busy()}>
          <div class="thread__working" aria-label="Agent is working">
            <span class="thread__breath">
              <i />
              <i />
              <i />
            </span>
          </div>
        </Show>
      </div>

      <Show when={!pinned()}>
        <button class="thread__jump" onClick={jumpToLatest}>
          <Icon name="arrowRight" size={13} style={{ transform: 'rotate(90deg)' }} />
          Jump to latest
        </button>
      </Show>
    </div>
  );
}

function keyOf(item: Item): string {
  // A single assistant message can contain several tool calls, so its
  // message id is deliberately not unique among tool cards.  Call ids are
  // the stable identity used by all tool frames and must also own the local
  // expanded state.
  return item.kind === 'tool' ? `tool:${item.id}` : `${item.kind}:${item.id}`;
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
        <UserMessage
          item={props.item as Extract<Item, { kind: 'user' }>}
        />
      </Show>

      <Show when={props.item.kind === 'assistant'}>
        <div class="msg msg--ai">
          <div class="msg__avatar">
            <Icon name="sparkles" size={13} />
          </div>
          <AssistantText text={(props.item as any).text} />
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
        <PatchCard patch={props.item as any} open={props.open} onToggle={props.onToggle} />
      </Show>

      <Show when={props.item.kind === 'notice'}>
        <div class="notice" classList={{ 'notice--error': (props.item as any).tone === 'error' }}>
          <Icon name="alert" size={13} />
          <span class="notice__text">{(props.item as any).text}</span>
        </div>
      </Show>

      {/* The turn's own figure, closing out its own rows. */}
      <Show when={props.item.kind === 'stat'}>
        <div class="thread__stat">
          <span>{secs((props.item as any).ms)}</span>
          <span>{rate((props.item as any).tokens, (props.item as any).ms)}</span>
          <span>{(props.item as any).tools} {(props.item as any).tools === 1 ? 'tool' : 'tools'}</span>
        </div>
      </Show>
    </>
  );
}

function UserMessage(props: {
  item: Extract<Item, { kind: 'user' }>;
}) {
  return (
    <div class="msg msg--user">
      <div class="msg__content msg__content--user">
        <Show when={props.item.context} keyed>
          {(context) => (
            <div class="msg__attachment">
              <div class="msg__attachment-head">
                <Icon name="paperclip" size={12} />
                <span>{relativePath(context.path, props.item.root)}</span>
                <span class="msg__attachment-range">{selectionRange(context)}</span>
              </div>
              <pre class="msg__attachment-text">{context.text}</pre>
            </div>
          )}
        </Show>
        <div class="bubble">{props.item.text}</div>
        <MessageCopy text={props.item.text} />
      </div>
    </div>
  );
}

function MessageCopy(props: { text: string }) {
  return (
    <div class="msg__actions">
      <button
        class="msg__copy"
        aria-label="Copy message"
        data-tooltip="Copy message"
        onClick={() => void copyText(props.text, 'Message copied', false)}
      >
        <Icon name="copy" size={14} />
      </button>
    </div>
  );
}

function relativePath(path: string, root: string | null): string {
  if (!root) return path.replaceAll('\\', '/');
  const relative = path.slice(root.length).replace(/^[\\/]+/, '');
  return relative.replaceAll('\\', '/') || path.replaceAll('\\', '/');
}

function selectionRange(context: {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}): string {
  const start = `${context.startLine}:${context.startColumn}`;
  const end = `${context.endLine}:${context.endColumn}`;
  return start === end ? start : `${start}–${end}`;
}

function PatchCard(props: {
  patch: { path: string; op: 'create' | 'modify' | 'delete'; bytes: number; diff: string };
  open: boolean;
  onToggle: () => void;
}) {
  const mark = () => props.patch.op === 'create' ? 'A' : props.patch.op === 'delete' ? 'D' : 'M';

  return (
    <div class="patch" classList={{ 'patch--open': props.open }}>
      <button class="patch__head" onClick={props.onToggle} aria-expanded={props.open}>
        <span class="patch__op">{mark()}</span>
        <span class="patch__path truncate">{props.patch.path}</span>
        <span class="patch__size">{formatBytes(props.patch.bytes)}</span>
        <Icon name="chevronDown" size={12} class="patch__caret" />
      </button>
      <Show when={props.open}>
        <div class="patch__diff scroll">
          <Index each={props.patch.diff.split('\n')}>
            {(line, index) => (
              <div
                class="patch__line"
                classList={{
                  'patch__line--add': line().startsWith('+') && !line().startsWith('+++'),
                  'patch__line--del': line().startsWith('-') && !line().startsWith('---'),
                  'patch__line--hunk': line().startsWith('@@'),
                  'patch__line--meta': line().startsWith('---') || line().startsWith('+++'),
                }}
              >
                <span class="patch__line-no">{index + 1}</span>
                <span class="patch__line-text">{line() || ' '}</span>
              </div>
            )}
          </Index>
        </div>
      </Show>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 102.4) / 10} KB`;
}

function AssistantText(props: { text: string }) {
  let body!: HTMLDivElement;
  createEffect(() => updateMarkdown(body, props.text));
  return <div class="msg__body markdown" ref={body} />;
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
