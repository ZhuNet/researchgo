import { describe, expect, it } from 'vitest';

import { fakeBackend, FakeFs } from './fakefs';

function fsWith(files: Record<string, string>): FakeFs {
  const fs = new FakeFs({ '/': [] });
  for (const [path, content] of Object.entries(files)) {
    fs.files.set(path, content);
  }
  return fs;
}

describe('工作区搜索', () => {
  it('搜索整个工作区，而不只是打开的文件', async () => {
    const fs = fsWith({
      '/a.md': 'hello world\nfoo bar\n',
      '/src/b.rs': 'fn main() {}\n// hello again\n',
      '/c.txt': 'nothing here',
    });
    const hits = await fakeBackend(fs).searchWorkspace('/', 'hello', false);
    expect(hits.map((h) => h.path)).toEqual(['/a.md', '/src/b.rs']);
    expect(hits[0]).toEqual({ path: '/a.md', line: 1, text: 'hello world' });
    expect(hits[1]).toEqual({ path: '/src/b.rs', line: 2, text: '// hello again' });
  });

  it('默认大小写不敏感，可切换为敏感', async () => {
    const fs = fsWith({ '/a.md': 'Readme says README\n' });
    const backend = fakeBackend(fs);
    expect(await backend.searchWorkspace('/', 'readme', false)).toHaveLength(1);
    expect(await backend.searchWorkspace('/', 'readme', true)).toHaveLength(0);
    expect(await backend.searchWorkspace('/', 'Readme', true)).toHaveLength(1);
  });

  it('限定在根目录之内', async () => {
    const fs = fsWith({ '/proj/a.md': 'hello\n', '/other/b.md': 'hello\n' });
    const hits = await fakeBackend(fs).searchWorkspace('/proj', 'hello', false);
    expect(hits.map((h) => h.path)).toEqual(['/proj/a.md']);
  });

  it('命中行文本去掉首尾空白并截断', async () => {
    const fs = fsWith({ '/a.md': `   ${'x'.repeat(300)}hello${'y'.repeat(300)}   \n` });
    const [hit] = await fakeBackend(fs).searchWorkspace('/', 'hello', false);
    expect(hit.text.startsWith('xxx')).toBe(true);
    expect(hit.text.length).toBeLessThanOrEqual(200);
  });
});
