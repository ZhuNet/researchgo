import { describe, expect, it } from 'vitest';

import { translate, type UiEvent } from '../src/lib/bridge';

const one = (line: unknown): UiEvent => {
  const events = translate(typeof line === 'string' ? line : JSON.stringify(line));
  expect(events).toHaveLength(1);
  return events[0];
};

describe('translate: 会话', () => {
  it('session.start 的 snake_case 字段映射成 camelCase', () => {
    expect(
      one({
        type: 'session.start',
        session_id: 'abc',
        model: 'claude-sonnet-4.6',
        cwd: '~/researchgo',
        tools: ['Shell', 'Read'],
      }),
    ).toEqual({
      kind: 'session',
      sessionId: 'abc',
      model: 'claude-sonnet-4.6',
      cwd: '~/researchgo',
      tools: ['Shell', 'Read'],
    });
  });

  it('tools 缺失时降级为空数组而不是崩', () => {
    const ev = one({ type: 'session.start', session_id: 'x', model: 'm', cwd: '/' });
    expect(ev).toMatchObject({ tools: [] });
  });
});

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
  it('file.patch 保留 op 与字节数', () => {
    expect(
      one({ type: 'file.patch', path: '/a.tex', op: 'modify', bytes: 128 }),
    ).toEqual({ kind: 'patch', path: '/a.tex', op: 'modify', bytes: 128 });
  });

  it('usage 的 cache_read 映射成 cacheRead', () => {
    expect(one({ type: 'usage', input: 10, output: 20, cache_read: 30 })).toEqual({
      kind: 'usage',
      input: 10,
      output: 20,
      cacheRead: 30,
    });
  });

  it('turn.end 保留原因', () => {
    for (const reason of ['stop', 'aborted', 'error'] as const) {
      expect(one({ type: 'turn.end', reason })).toEqual({ kind: 'turn.end', reason });
    }
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

  it('未知事件类型被忽略（向前兼容）', () => {
    expect(translate(JSON.stringify({ type: 'future.thing', payload: 1 }))).toEqual([]);
  });

  it('缺 type 的帧被忽略', () => {
    expect(translate(JSON.stringify({ id: 'x' }))).toEqual([]);
  });
});

describe('translate: 一行一帧的线协议假设', () => {
  it('多行 JSONL 逐行独立解析', () => {
    const stream = [
      JSON.stringify({ type: 'session.start', session_id: 's', model: 'm', cwd: '/', tools: [] }),
      JSON.stringify({ type: 'assistant.delta', id: 'a', text: 'he' }),
      JSON.stringify({ type: 'assistant.delta', id: 'a', text: 'llo' }),
      JSON.stringify({ type: 'turn.end', reason: 'stop' }),
    ].join('\n');
    const events = stream.split('\n').flatMap((line) => translate(line));
    expect(events.map((e) => e.kind)).toEqual(['session', 'text.delta', 'text.delta', 'turn.end']);
    const text = events
      .filter((e) => e.kind === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('hello');
  });
});