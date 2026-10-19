import { describe, expect, it } from 'vitest';

import { translate, type UiEvent } from '../src/lib/bridge';

const one = (line: unknown): UiEvent => {
  const events = translate(typeof line === 'string' ? line : JSON.stringify(line));
  expect(events).toHaveLength(1);
  return events[0];
};

describe('translate: 文本流', () => {
  it('assistant.message 展开为 start/delta/end 三帧', () => {
    const events = translate(
      JSON.stringify({ type: 'assistant.message', id: 'm1', role: 'assistant', text: 'hi' }),
    );
    expect(events.map((e) => e.kind)).toEqual(['text.start', 'text.delta', 'text.end']);
  });

  it('assistant.delta 只产生一帧增量', () => {
    expect(one({ type: 'assistant.delta', id: 'm1', text: 'chunk' })).toEqual({
      kind: 'text.delta',
      id: 'm1',
      text: 'chunk',
    });
  });

  it('assistant.done 只收尾，不带文本', () => {
    expect(one({ type: 'assistant.done', id: 'm1' })).toEqual({ kind: 'text.end', id: 'm1' });
  });
});

describe('translate: 工具调用', () => {
  it('call_id 映射为 callId 并保留 input 原文', () => {
    const input = { cmd: 'ls -la', nested: { a: 1 } };
    expect(one({ type: 'tool.start', id: 't1', call_id: 'c1', name: 'Shell', input })).toEqual({
      kind: 'tool.start',
      id: 't1',
      callId: 'c1',
      name: 'Shell',
      input,
    });
  });

  it('output 分片原样透传', () => {
    expect(one({ type: 'tool.output', id: 't1', call_id: 'c1', chunk: 'line\n' })).toEqual({
      kind: 'tool.output',
      id: 't1',
      callId: 'c1',
      chunk: 'line\n',
    });
  });

  it('end 携带 ok 与 summary', () => {
    expect(
      one({ type: 'tool.end', id: 't1', call_id: 'c1', ok: false, summary: 'exit 1' }),
    ).toEqual({ kind: 'tool.end', id: 't1', callId: 'c1', ok: false, summary: 'exit 1' });
  });
});

describe('translate: 补丁与用量', () => {
  it('file.patch 保留 op、字节数与完整 diff', () => {
    expect(
      one({ type: 'file.patch', path: '/a.tex', op: 'modify', bytes: 128, diff: '@@ -1 +1 @@\n-old\n+new\n' }),
    ).toEqual({
      kind: 'patch',
      path: '/a.tex',
      op: 'modify',
      bytes: 128,
      diff: '@@ -1 +1 @@\n-old\n+new\n',
    });
  });

  it('usage 同时带过上下文长度与本轮消耗', () => {
    expect(one({ type: 'usage', context: 8_300, tokens: 21_000 })).toEqual({
      kind: 'usage',
      context: 8_300,
      tokens: 21_000,
    });
  });

  it('agent.status carries the authoritative control snapshot', () => {
    expect(one({ type: 'agent.status', turn: 7, phase: 'stopping', age_ms: 8300, context: 4200, records: 5 })).toEqual({
      kind: 'status', turn: 7, phase: 'stopping', ageMs: 8300, context: 4200, records: 5,
    });
  });

  it('turn.end 保留轮次与原因', () => {
    // The turn number is what lets the panel tell a late `turn.end` from one
    // that closes the turn it is running, so it has to survive translation.
    for (const reason of ['stop', 'aborted', 'error'] as const) {
      expect(one({ type: 'turn.end', turn: 7, reason })).toEqual({
        kind: 'turn.end',
        turn: 7,
        reason,
      });
    }
  });

  it('turn.start 把宿主分配的轮次号原样带过', () => {
    // 面板不再自己数 prompt，这个数就是它唯一知道的轮次身份。它在帧流
    // 上以帧的形式出现，而不是某个计数器的自增结果，所以翻译必须原样保留。
    expect(one({ type: 'turn.start', turn: 12 })).toEqual({
      kind: 'turn.start',
      turn: 12,
    });
  });
});

describe('translate: 容错', () => {
  it('坏 JSON 变成 error 事件而不是抛出', () => {
    const ev = one('{not json');
    expect(ev.kind).toBe('error');
    expect(ev).toMatchObject({ message: expect.stringContaining('malformed jsonl') });
  });

  it('坏 JSON 的错误信息截断到 120 字符', () => {
    const ev = one('{' + 'x'.repeat(500));
    expect(ev).toMatchObject({ message: expect.stringContaining('malformed jsonl') });
    const message = (ev as { message: string }).message;
    expect(message.length).toBeLessThanOrEqual('malformed jsonl: '.length + 120);
  });

  it('未知事件类型报错而不是被静默丢弃', () => {
    // 静默丢弃曾让一次协议漂移（点号 → 下划线）无声地吞掉除 error/usage 外的
    // 所有帧，每个 turn 都变成永不停止的转圈。漂移必须一出现就可见。
    const ev = one(JSON.stringify({ type: 'future.thing', payload: 1 }));
    expect(ev.kind).toBe('error');
    expect(ev).toMatchObject({ message: expect.stringContaining('future.thing') });
  });

  it('缺 type 的帧报错', () => {
    const ev = one(JSON.stringify({ id: 'x' }));
    expect(ev.kind).toBe('error');
  });

  it('被删掉的会话帧现在是响亮的协议漂移', () => {
    // 后端已经没有会话这个概念了，`session.start` 也就不存在了。它要是还从
    // 哪条路径发出来，这里必须是看得见的错误，而不是被静默吞掉的一帧。
    const ev = one(JSON.stringify({ type: 'session.start', session_id: 's' }));
    expect(ev.kind).toBe('error');
    expect(ev).toMatchObject({ message: expect.stringContaining('session.start') });
  });
});

describe('translate: 一行一帧的线协议假设', () => {
  it('多行 JSONL 逐行独立解析', () => {
    const stream = [
      JSON.stringify({ type: 'assistant.delta', id: 'a', text: 'he' }),
      JSON.stringify({ type: 'assistant.delta', id: 'a', text: 'llo' }),
      JSON.stringify({ type: 'turn.end', turn: 1, reason: 'stop' }),
    ].join('\n');
    const events = stream.split('\n').flatMap((line) => translate(line));
    expect(events.map((e) => e.kind)).toEqual(['text.delta', 'text.delta', 'turn.end']);
    const text = events
      .filter((e) => e.kind === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('hello');
  });
});
