import { afterEach, describe, expect, it } from 'vitest';

import type { AgentStatus } from '../src/lib/agent';
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
/**
 * The host's own turn counter, as the real one behaves: allocated on the host,
 * never reset by the renderer, and surviving a panel that did not exist yet.
 * The stub `agent_send` increments it exactly as `AgentState::begin_turn` does.
 */
let hostSerial = 0;
/** When set, `agent_send` parks before answering, so a test can finish a turn
 *  before the host's reply to the prompt has made it back to the panel. */
let holdSend = false;
let answerSend: () => void = () => {};
let hostTools = 0;

/** What the host answers when a panel asks what it is doing. */
let status: Partial<AgentStatus> | undefined;

function installBridge() {
  frame = undefined;
  calls = [];
  stopHost = () => {};
  hostSerial = 0;
  holdSend = false;
  answerSend = () => {};
  hostTools = 0;
  // Nothing to adopt: a host with no turn and an empty transcript, which is what
  // a panel starting before anything has happened actually finds.
  status = { turn: 0, phase: 'idle', ageMs: 0, context: 0, records: 0 };
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'agent_status') return status;
        if (cmd === 'agent_send') {
          hostSerial += 1;
          if (holdSend) await new Promise<void>((resolve) => (answerSend = resolve));
        }
        if (cmd === 'agent_abort') {
          frame?.({ type: 'agent.status', turn: hostSerial, phase: 'stopping', age_ms: 1, context: 0, records: 1 });
          await new Promise<void>((resolve) => (stopHost = resolve));
          frame?.({ type: 'agent.status', turn: hostSerial, phase: 'idle', age_ms: 0, context: 0, records: 1 });
        }
        if (cmd === 'agent_clear') {
          frame?.({ type: 'agent.status', turn: hostSerial, phase: 'idle', age_ms: 0, context: 0, records: 0 });
        }
      },
    },
    event: {
      listen: async (_name: string, cb: (msg: { payload: unknown }) => void) => {
        frame = (payload: unknown) => {
          const event = payload as { type?: string; tools?: number };
          if (event.type === 'turn.start') hostTools = 0;
          if (event.type === 'tool.start') hostTools += 1;
          cb({ payload: event.type === 'turn.end' && event.tools === undefined
            ? { ...event, tools: hostTools }
            : payload });
        };
        return () => {};
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI__;
  frame = undefined;
});

/**
 * What the host says in the same operation that registers a turn, and before
 * any frame of that turn. Tests that call `send` directly announce it the same
 * way, because that announcement is the only thing that tells the panel what the
 * turn is called.
 */
const started = () => {
  frame?.({ type: 'turn.start', turn: hostSerial });
  frame?.({ type: 'agent.status', turn: hostSerial, phase: 'running', age_ms: 0, context: 0, records: 1 });
};

/** Lets the microtasks behind a handover or a stop drain, so a test can assert
 *  on the state between two awaits that are each waiting on the other. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/**
 * A panel that has read the host and got on with it — which is where a real one
 * is long before anyone could type a prompt. The calls it makes on its way up are
 * cleared, so what a test asserts on is what that test provoked.
 */
async function panel() {
  const agent = createAgent();
  await flush();
  calls = [];
  return agent;
}

async function turn(agent: ReturnType<typeof createAgent>, prompt: string, frames: unknown[]) {
  await agent.send(prompt, '/root');
  started();
  let context = 0;
  for (const f of frames) {
    frame?.(f);
    if ((f as { type?: string; context?: number }).type === 'usage') context = (f as { context: number }).context;
    if ((f as { type?: string }).type === 'turn.end') {
      frame?.({ type: 'agent.status', turn: (f as { turn: number }).turn, phase: 'idle', age_ms: 0, context, records: 1 });
    }
  }
}

const idle = (turn: number, context = 0, records = 1) =>
  frame?.({ type: 'agent.status', turn, phase: 'idle', age_ms: 0, context, records });

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
    expect(agent.items().find((i) => i.kind === 'stat')).toMatchObject({ tools: 1 });

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

  it('面板中途重建后仍认得宿主的轮次号，不会永远停在运行中', async () => {
    // 这就是合盖睡眠那一次：宿主进程活着，webview 被重载。渲染端此前会从 1
    // 重新数自己的 prompt，宿主却继续从它自己的数字往下走，于是每一个
    // turn.end 都像是别人的、都被当成过期丢掉。而 turn.end 是唯一能结算
    // 一轮的东西，于是没有任何一轮能自己结束——面板卡在运行中，发送键停在
    // Interrupt 上，Enter 和发送点击都被 busy() 拒掉。
    installBridge();
    hostSerial = 4; // 宿主已经跑过四轮，这一个面板一轮都没参与
    const agent = createAgent();

    // 睡眠前那一轮的尾巴流进了这个全新的面板。它没有 turn.start 可言，
    // 它的 turn.end 也就没有任何轮次可以结算——而这里确实无事可做。
    frame?.({ type: 'assistant.delta', id: 'a1', text: '上一轮' });
    frame?.({ type: 'turn.end', turn: 4, reason: 'stop' });
    expect(agent.busy()).toBe(false);

    await turn(agent, '再来一次', [
      { type: 'assistant.delta', id: 'a1', text: '这一轮' },
      { type: 'assistant.done', id: 'a1' },
      { type: 'turn.end', turn: 5, reason: 'stop' },
    ]);

    expect(agent.busy()).toBe(false);
    expect(agent.stoppable()).toBe(false);
    // 两段各自成行：宿主每轮都从 a1 重新数，所以轮次号既用来结算，
    // 也用来给帧分段——这正是这个数必须只有一个来源的原因。
    expect(texts(agent)).toEqual(['上一轮', '这一轮']);
  });

  it('上一轮的尾巴当时还没到，重载后的第一轮照样收得干净', async () => {
    // 同一个故障的另一副面孔：合盖时上一轮还没吐出任何东西，于是它被
    // 停止后的收尾帧是重载之后才到的。卡不卡跟尾巴显不显示无关——旧代码
    // 里两种情形都会卡，因为错位发生在重载之后的第一次发送那一刻，而不是
    // 在尾巴到达的时候。这里锁住的是"没有尾巴"这一半。
    installBridge();
    hostSerial = 2; // 宿主还有一轮在手，面板一行都没见过
    const agent = createAgent();

    expect(agent.busy()).toBe(false);
    expect(agent.stoppable()).toBe(false);

    // 面板建好之后才到的收尾帧，属于一个它从未参与过的轮次。
    frame?.({ type: 'turn.end', turn: 2, reason: 'stop' });
    expect(agent.busy()).toBe(false);

    await turn(agent, '第一轮', [
      { type: 'assistant.delta', id: 'a1', text: '答' },
      { type: 'assistant.done', id: 'a1' },
      { type: 'turn.end', turn: 3, reason: 'stop' },
    ]);

    expect(agent.busy()).toBe(false);
    expect(agent.stoppable()).toBe(false);
    expect(texts(agent)).toEqual(['答']);
  });

  it('一轮比 agent_send 的应答先结束，迟到的应答不会把面板按回运行中', async () => {
    // 和重载毫无关系的第二条卡死路径：宿主可能在 invoke 的应答回到渲染
    // 进程之前就把这一轮跑完了——没配好模型时，一帧 error 加一帧 turn.end
    // 就是全部，比应答先到是很平常的事。结算完的轮次又被一个迟到的
    // `running` 盖回运行中，按钮就永远停在 Interrupt 上。
    installBridge();
    holdSend = true;
    const agent = createAgent();

    const sending = agent.send('go', '/root');
    expect(agent.busy()).toBe(true);
    expect(agent.stoppable()).toBe(false);
    started();
    frame?.({ type: 'error', message: 'No model configured.' });
    frame?.({ type: 'turn.end', turn: 1, reason: 'error' });
    idle(1);
    expect(agent.busy()).toBe(false);

    answerSend();
    await sending;

    expect(agent.busy()).toBe(false);
    expect(agent.stoppable()).toBe(false);
  });

  it('运行中是由 turn.start 决定的，不是由宿主对 prompt 的应答', async () => {
    // 应答只说明宿主收下了请求，不说明有轮次。而 turn.start 是"轮次确实
    // 存在"的那一帧：收到它，就等于收到一个必然还在将来的 turn.end——因为
    // 一轮不可能在它被宣告之前就结束，而宣告它的时候监听器已经在听了。
    // 靠应答进入运行中等的是另一样东西，它可能早就发完了，漏掉就没有任何
    // 东西能把面板带回空闲，也就没有任何东西能把用户解锁。
    installBridge();
    holdSend = true;
    const agent = createAgent();

    const sending = agent.send('go', '/root');
    // 应答还在路上，轮次尚未登记：还不能停，也没有轮次在跑。
    expect(agent.busy()).toBe(true);
    expect(agent.stoppable()).toBe(false);

    started();
    expect(agent.stoppable()).toBe(true);

    // 应答随后才回来，不能把它按回别的状态去。
    answerSend();
    await sending;
    expect(agent.stoppable()).toBe(true);
    expect(agent.busy()).toBe(true);
  });
});

describe('agent store: 清空', () => {
  it('清空先把在途的一轮停下来，而不是让它把面板重新填满', async () => {
    // `agent_send` 在收尾上一轮时最多停十秒，面板这段时间一直是 sending。
    // 此时直接清空有两个后果：面板被清空后这一轮继续往里写；而且宿主整轮
    // 持有 transcript 的锁，清空会排在它后面，于是屏幕空了、模型还记得。
    installBridge();
    holdSend = true;
    const agent = await panel();

    const sending = agent.send('go', '/root');
    started();
    frame?.({ type: 'assistant.delta', id: 'a1', text: '半句' });
    expect(agent.busy()).toBe(true);

    const clearing = agent.clear();
    answerSend();
    await sending;
    await flush();
    stopHost();
    await clearing;

    expect(calls.map((c) => c.cmd)).toEqual(['agent_send', 'agent_clear']);
    // 空的 transcript，而不是一条孤零零的统计行。
    expect(agent.items()).toEqual([]);
    expect(agent.busy()).toBe(false);
  });

  it('空闲时清空不多做任何事', async () => {
    installBridge();
    const agent = await panel();
    await turn(agent, 'one', [
      { type: 'assistant.delta', id: 'a1', text: '答' },
      { type: 'turn.end', turn: 1, reason: 'stop' },
    ]);

    await agent.clear();

    // 没有轮次在跑，所以不必先去停一个不存在的轮次。
    expect(calls.map((c) => c.cmd)).toEqual(['agent_send', 'agent_clear']);
    expect(agent.items()).toEqual([]);
  });
});

describe('agent store: 与宿主对齐', () => {
  it('把编辑器选区作为独立上下文发送，用户消息仍只显示输入文本', async () => {
    installBridge();
    const agent = await panel();
    const context = {
      path: '/root/main/t.txt',
      text: 'selected text',
      startLine: 2,
      startColumn: 3,
      endLine: 2,
      endColumn: 16,
    };

    await agent.send('explain this', '/root', context);

    expect(calls).toEqual([{ cmd: 'agent_send', args: {
      prompt: 'explain this',
      root: '/root',
      context,
    } }]);
    expect(agent.items()).toEqual([
      expect.objectContaining({ kind: 'user', text: 'explain this' }),
    ]);
  });

  it('重载后不谎报上下文：meter 用的是宿主实际的对话长度', async () => {
    // 面板自己的 `spent` 是空的，宿主的 transcript 不是。开机显示 0 而模型
    // 手里有六万 token，是同一类谎话——只是这一次谎的是上下文条。
    installBridge();
    hostSerial = 3;
    status = { turn: 3, phase: 'idle', ageMs: 0, context: 61_000, records: 14 };
    const agent = await panel();

    expect(agent.context()).toBe(61_000);
  });

  it('宿主还在跑，面板就认下这一轮：按钮是停止，计时接得上', async () => {
    installBridge();
    hostSerial = 3;
    status = { turn: 3, phase: 'running', ageMs: 42_000, context: 48_000, records: 12 };
    const agent = await panel();

    expect(agent.busy()).toBe(true);
    expect(agent.stoppable()).toBe(true);
    // 接的是宿主说的时长，不是从零开始数——把跑了四十秒的一轮显示成刚起步，
    // 和把它显示成空的一样是谎。
    expect(agent.elapsed()).toBeGreaterThanOrEqual(42_000);
  });

  it('认下来的这一轮收得干净：它的 turn.end 就是面板自己那一轮的', async () => {
    // 以前这里会出现"卡片在转、按钮是发送"的组合：尾巴来了，turn.end 却因为
    // 轮次号对不上被丢掉，面板自始至终不知道有轮次在跑。认下之后两边说的是
    // 同一件事。
    installBridge();
    hostSerial = 3;
    status = { turn: 3, phase: 'running', ageMs: 1_000, context: 48_000, records: 12 };
    const agent = await panel();

    frame?.({ type: 'assistant.delta', id: 'a1', text: '尾巴' });
    frame?.({ type: 'turn.end', turn: 3, reason: 'stop' });
    frame?.({ type: 'agent.status', turn: 3, phase: 'idle', age_ms: 0, context: 48_000, records: 12 });

    expect(agent.busy()).toBe(false);
    expect(texts(agent)).toEqual(['尾巴']);
  });

  it('刷新后不为未展示的历史增加特殊提示', async () => {
    installBridge();
    status = { turn: 0, phase: 'idle', ageMs: 0, context: 9_000, records: 4 };
    const agent = await panel();

    expect(agent.items()).toEqual([]);
    expect(agent.context()).toBe(9_000);
  });

  it('清空过的宿主不说这句话：transcript 空着就是没有对话', async () => {
    installBridge();
    status = { turn: 4, phase: 'idle', ageMs: 0, context: 800, records: 0 };
    const agent = await panel();

    // 轮次号还在，但记录数是 0——清空过。系统提示不算记录。
    expect(agent.items()).toEqual([]);
  });

  it('面板自己发出的 prompt 胜过任何一次对齐', async () => {
    // 对齐是一次异步读取。用户在这中间点了发送，面板就知道得比读回来的多，
    // 认下 7 号反而会把 1 号这一轮换成别人的名字。
    installBridge();
    holdSend = true;
    status = { turn: 7, phase: 'running', ageMs: 30_000, context: 90_000, records: 20 };
    const agent = createAgent();

    const sending = agent.send('go', '/root');
    answerSend();
    await sending;
    await flush();

    started();
    frame?.({ type: 'turn.end', turn: 1, reason: 'stop' });
    idle(1);
    expect(agent.busy()).toBe(false);
    expect(agent.context()).toBe(0);
  });

  it('宿主答不上来时，面板保持它本来的样子', async () => {
    installBridge();
    status = undefined;
    const agent = createAgent();
    await flush();

    expect(agent.context()).toBe(0);
    expect(agent.busy()).toBe(false);
    expect(agent.items()).toEqual([]);
  });
});

describe('agent store: 终止是串行的', () => {
  it('停止在 host 确认之前不放行：按钮禁用，且不接受下一条消息', async () => {
    installBridge();
    const agent = await panel();

    await agent.send('first', '/root');
    started();
    frame?.({ type: 'assistant.delta', id: 'a1', text: 'thinking' });
    expect(agent.stoppable()).toBe(true);

    // The host tears the turn down and only answers once it is gone. Until it
    // does, the stop is still in flight: the button is not pressable and a
    // second prompt would land on a transcript the host is still writing.
    const stopping = agent.abort();
    expect(agent.stoppable()).toBe(false);
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
    started();
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
    started();
    frame?.({ type: 'turn.end', turn: 1, reason: 'aborted' });
    frame?.({ type: 'agent.status', turn: 1, phase: 'idle', age_ms: 0, context: 0, records: 1 });
    await agent.send('second', '/root');
    started();

    frame?.({ type: 'turn.end', turn: 1, reason: 'aborted' });
    expect(agent.busy()).toBe(true);
    expect(agent.stoppable()).toBe(true);

    frame?.({ type: 'turn.end', turn: 2, reason: 'stop' });
    frame?.({ type: 'agent.status', turn: 2, phase: 'idle', age_ms: 0, context: 0, records: 1 });
    expect(agent.busy()).toBe(false);
  });

  it('错误帧不结束轮次：它后面一定跟着 turn.end', async () => {
    // 两处结算会让一个轮次被关两次，其中一次落在下一轮头上。
    installBridge();
    const agent = createAgent();

    await agent.send('go', '/root');
    started();
    frame?.({ type: 'error', message: 'model stream was silent' });

    expect(agent.busy()).toBe(true);
    expect(agent.items().filter((i) => i.kind === 'notice')).toHaveLength(1);

    frame?.({ type: 'turn.end', turn: 1, reason: 'error' });
    idle(1);
    expect(agent.busy()).toBe(false);
  });

  it('停止期间不接受再次点击停止', async () => {
    installBridge();
    const agent = createAgent();

    await agent.send('go', '/root');
    started();
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
    expect(stats.map((s) => s.tools)).toEqual([0, 0]);
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
    started();
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
