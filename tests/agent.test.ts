import { afterEach, describe, expect, it } from 'vitest';

import { createAgent, type AgentTool, type Item } from '../src/store/agent';

/**
 * The agent store, driven the way the desktop app drives it: `send` hands a
 * prompt to the host, frames come back on one event, and `apply` folds them
 * into items. The bridge here is a stub that captures the frame listener, so
 * a test speaks the wire protocol at the store and asserts on the items the
 * thread renders.
 */

let frame: ((payload: unknown) => void) | undefined;
let calls: { cmd: string; args?: Record<string, unknown> }[] = [];
/** What the host does with `agent_abort`, resolved by the test rather than by a real turn. */
let stopHost: () => void = () => {};

function installBridge() {
  frame = undefined;
  calls = [];
  stopHost = () => {};
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'agent_abort') await new Promise<void>((resolve) => (stopHost = resolve));
      },
    },
    event: {
      listen: async (_name: string, cb: (msg: { payload: unknown }) => void) => {
        frame = (payload: unknown) => cb({ payload });
        return () => {};
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI__;
  frame = undefined;
});

async function turn(agent: ReturnType<typeof createAgent>, prompt: string, frames: unknown[]) {
  await agent.send(prompt, '/root');
  for (const f of frames) frame?.(f);
}

const texts = (agent: ReturnType<typeof createAgent>) =>
  agent
    .items()
    .filter((i): i is Extract<Item, { kind: 'assistant' }> => i.kind === 'assistant')
    .map((i) => i.text);

const tools = (agent: ReturnType<typeof createAgent>) =>
  agent.items().filter((i): i is AgentTool => i.kind === 'tool');

describe('agent store: 轮次身份', () => {
  it('第二轮复用后端 id 时，文本各自成段、卡片各自成张', async () => {
    installBridge();
    const agent = createAgent();

    await turn(agent, 'first', [
      { type: 'assistant.delta', id: 'a1', text: '你好' },
      { type: 'assistant.done', id: 'a1' },
      { type: 'tool.start', id: 'a1', call_id: 'call_0', name: 'read', input: { path: 'x' } },
      { type: 'tool.output', id: 'a1', call_id: 'call_0', chunk: '内容' },
      { type: 'tool.end', id: 'a1', call_id: 'call_0', ok: true, summary: '1 line' },
      { type: 'turn.end', turn: 1, reason: 'stop' },
    ]);

    // 每轮以自己的统计行收尾。
    expect(agent.items().map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'stat']);
    expect(texts(agent)).toEqual(['你好']);
    expect(tools(agent)[0]).toMatchObject({ output: '内容', status: 'ok' });

    // The backend numbers every turn from `a1` again, and the endpoint hands
    // out the same call ids. The second turn must land on its own rows, not
    // on the first turn's — the regression that merged every answer into one
    // growing paragraph and made later cards vanish.
    await turn(agent, 'second', [
      { type: 'assistant.delta', id: 'a1', text: '第二段' },
      { type: 'assistant.done', id: 'a1' },
      { type: 'tool.start', id: 'a1', call_id: 'call_0', name: 'read', input: { path: 'y' } },
      { type: 'tool.output', id: 'a1', call_id: 'call_0', chunk: '输出' },
      { type: 'tool.end', id: 'a1', call_id: 'call_0', ok: true, summary: '1 line' },
      { type: 'turn.end', turn: 2, reason: 'stop' },
    ]);

    expect(agent.items().map((i) => i.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'stat',
      'user',
      'assistant',
      'tool',
      'stat',
    ]);
    expect(texts(agent)).toEqual(['你好', '第二段']);
    expect(tools(agent).map((t) => t.output)).toEqual(['内容', '输出']);
  });

  it('同一条消息的多个工具调用各成一张卡，id 互不相同', async () => {
    installBridge();
    const agent = createAgent();

    // One assistant message, two calls: the frames share the message id and
    // differ only by call id. Each call is its own card with its own
    // renderer id — the key the expanded state and the list reconciliation
    // are keyed by, so a shared one made toggling one card move another.
    await turn(agent, 'do', [
      { type: 'tool.start', id: 'a1', call_id: 'call_0', name: 'read', input: { path: 'a' } },
      { type: 'tool.start', id: 'a1', call_id: 'call_1', name: 'grep', input: { q: 'b' } },
      { type: 'tool.output', id: 'a1', call_id: 'call_0', chunk: 'A' },
      { type: 'tool.output', id: 'a1', call_id: 'call_1', chunk: 'B' },
      { type: 'tool.end', id: 'a1', call_id: 'call_0', ok: true, summary: 's' },
      { type: 'tool.end', id: 'a1', call_id: 'call_1', ok: false, summary: 'e' },
      { type: 'turn.end', turn: 1, reason: 'stop' },
    ]);

    const cards = tools(agent);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ output: 'A', status: 'ok' });
    expect(cards[1]).toMatchObject({ output: 'B', status: 'error' });
    expect(cards[0].id).not.toBe(cards[1].id);
  });
});

describe('agent store: 终止是串行的', () => {
  it('停止在 host 确认之前不放行：按钮禁用，且不接受下一条消息', async () => {
    installBridge();
    const agent = createAgent();

    await agent.send('first', '/root');
    frame?.({ type: 'assistant.delta', id: 'a1', text: 'thinking' });
    expect(agent.stoppable()).toBe(true);

    // The host tears the turn down and only answers once it is gone. Until it
    // does, the stop is still in flight: the button is not pressable and a
    // second prompt would land on a transcript the host is still writing.
    const stopping = agent.abort();
    await Promise.resolve();
    expect(agent.stopping()).toBe(true);
    expect(agent.stoppable()).toBe(false);
    expect(agent.busy()).toBe(true);

    await agent.send('second', '/root');
    expect(calls.map((c) => c.cmd)).toEqual(['agent_send', 'agent_abort']);
    expect(agent.items().filter((i) => i.kind === 'user')).toHaveLength(1);

    stopHost();
    await stopping;

    expect(agent.busy()).toBe(false);
    expect(agent.stopping()).toBe(false);
    expect(texts(agent)).toEqual(['thinking']);
  });

  it('被停止的轮次留下的行就地收尾，而不是等一帧永远不会来的帧', async () => {
    installBridge();
    const agent = createAgent();

    await agent.send('build it', '/root');
    frame?.({ type: 'assistant.delta', id: 'a1', text: 'Running' });
    frame?.({ type: 'tool.start', id: 'a1', call_id: 'c0', name: 'bash', input: { command: 'x' } });

    const stopping = agent.abort();
    await Promise.resolve();
    stopHost();
    await stopping;

    const [message, card] = agent.items().filter((i) => i.kind !== 'user');
    expect(message).toMatchObject({ kind: 'assistant', streaming: false, text: 'Running' });
    expect(card).toMatchObject({ kind: 'tool', status: 'error', summary: 'stopped' });
  });

  it('迟到的 turn.end 不关闭已经开始的下一轮', async () => {
    // 这就是停止必须带轮次号的原因：被停止的轮次由停止本身结算，
    // 而宣布它结束的那一帧可能还在路上。落进下一轮就等于把正在跑的
    // 轮次标成结束，发送键会在 agent 还在工作的时候变回来。
    installBridge();
    const agent = createAgent();

    await agent.send('first', '/root');
    frame?.({ type: 'turn.end', turn: 1, reason: 'aborted' });
    await agent.send('second', '/root');

    frame?.({ type: 'turn.end', turn: 1, reason: 'aborted' });
    expect(agent.busy()).toBe(true);
    expect(agent.stoppable()).toBe(true);

    frame?.({ type: 'turn.end', turn: 2, reason: 'stop' });
    expect(agent.busy()).toBe(false);
  });

  it('错误帧不结束轮次：它后面一定跟着 turn.end', async () => {
    // 两处结算会让一个轮次被关两次，其中一次落在下一轮头上。
    installBridge();
    const agent = createAgent();

    await agent.send('go', '/root');
    frame?.({ type: 'error', message: 'model stream was silent' });

    expect(agent.busy()).toBe(true);
    expect(agent.items().filter((i) => i.kind === 'notice')).toHaveLength(1);

    frame?.({ type: 'turn.end', turn: 1, reason: 'error' });
    expect(agent.busy()).toBe(false);
  });

  it('停止期间不接受再次点击停止', async () => {
    installBridge();
    const agent = createAgent();

    await agent.send('go', '/root');
    const stopping = agent.abort();
    await Promise.resolve();
    await agent.abort();
    stopHost();
    await stopping;

    // 一次就够：第二次点击只会对着同一个已经在拆除的轮次再问一遍，
    // 而一个排在它后面的提示词会悄悄地被这次停止一起带走。
    expect(calls.filter((c) => c.cmd === 'agent_abort')).toHaveLength(1);
  });
});

describe('agent store: 上下文与消耗', () => {
  const usage = (context: number, tokens: number) => ({ type: 'usage', context, tokens });

  it('轮次以自己的耗时和速率收尾，并留在那一轮的最后', async () => {
    installBridge();
    const agent = createAgent();

    await turn(agent, 'one', [usage(8_300, 21_000), { type: 'turn.end', turn: 1, reason: 'stop' }]);
    await turn(agent, 'two', [usage(9_100, 12_000), { type: 'turn.end', turn: 2, reason: 'stop' }]);

    const stats = agent.items().filter((i): i is Extract<Item, { kind: 'stat' }> => i.kind === 'stat');
    // 每一轮各留一份，且各记各的消耗——统计属于它描述的那一轮，
    // 而不是「最近一轮」这一个随轮次改写的值。
    expect(stats).toHaveLength(2);
    expect(stats.map((s) => s.tokens)).toEqual([21_000, 12_000]);
    expect(stats[0].ms).toBeGreaterThanOrEqual(0);
    // 第二轮的统计行落在第二轮的末尾，而不是被挪到最前面。
    expect(agent.items().map((i) => i.kind)).toEqual([
      'user', 'stat',
      'user', 'stat',
    ]);
  });

  it('显示的是当次对话长度，不跨轮累加', async () => {
    installBridge();
    const agent = createAgent();

    await agent.send('go', '/root');
    // 后端每一步都发当次的上下文长度，到达即可显示，不必等轮次结束。
    frame?.(usage(5_500, 5_500));
    expect(agent.context()).toBe(5_500);
    // 下一次请求带着全部历史，所以它更大——是对话变长了，
    // 不是上一轮的数被重复计了一遍。
    frame?.(usage(11_000, 21_000));
    expect(agent.context()).toBe(11_000);

    // 轮次收尾：本轮的消耗清零，对话长度留着——transcript 还在。
    frame?.({ type: 'turn.end', turn: 1, reason: 'stop' });
    expect(agent.context()).toBe(11_000);
    expect(agent.spent().tokens).toBe(0);

    await turn(agent, 'again', [usage(12_000, 5_000), { type: 'turn.end', turn: 2, reason: 'stop' }]);
    expect(agent.context()).toBe(12_000);
  });

  it('新 store 从 0 开始，不继承上一会话的任何数', async () => {
    installBridge();
    const first = createAgent();
    await turn(first, 'one', [usage(11_000, 21_000), { type: 'turn.end', turn: 1, reason: 'stop' }]);
    expect(first.context()).toBe(11_000);

    // 没有任何东西落盘，所以重开窗口就是从零开始。
    expect(createAgent().context()).toBe(0);
  });
});
