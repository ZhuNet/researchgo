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

function installBridge() {
  frame = undefined;
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: { invoke: async () => undefined },
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
      { type: 'turn.end', reason: 'stop' },
    ]);

    expect(agent.items().map((i) => i.kind)).toEqual(['user', 'assistant', 'tool']);
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
      { type: 'turn.end', reason: 'stop' },
    ]);

    expect(agent.items().map((i) => i.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
      'assistant',
      'tool',
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
      { type: 'turn.end', reason: 'stop' },
    ]);

    const cards = tools(agent);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ output: 'A', status: 'ok' });
    expect(cards[1]).toMatchObject({ output: 'B', status: 'error' });
    expect(cards[0].id).not.toBe(cards[1].id);
  });
});
