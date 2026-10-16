import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';

import { createEditor, type EditorLimits } from '../src/store/editor';
import { FakeFs, fakeBackend } from './fakefs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The content layer's contract: how a file is decided to be shown, what stays
 * resident, and what a build reports.
 */

function withEditor(
  fn: (editor: ReturnType<typeof createEditor>, fs: FakeFs) => void | Promise<void>,
  limits?: Partial<EditorLimits>,
  tree: Record<string, string[]> = { '/': ['a.txt', 'big.txt', 'blob.bin'] },
) {
  return createRoot(() => {
    const fs = new FakeFs(tree);
    const editor = createEditor(fakeBackend(fs), limits);
    return Promise.resolve(fn(editor, fs)).then(() => editor.bump());
  });
}

describe('文件模式：先探测，再决定怎么显示', () => {
  it('关闭或清空后，未完成的读取不能重新写入缓存', async () => {
    const fs = new FakeFs({ '/': ['a.txt'] });
    const backend = fakeBackend(fs);
    const originalRead = backend.readFile;
    const held = deferred<string>();
    backend.readFile = async (path) => path === '/a.txt' ? held.promise : originalRead(path);
    const editor = createEditor(backend);
    const opening = editor.open('/a.txt');
    await Promise.resolve();
    editor.forget('/a.txt');
    held.resolve('late content');
    await opening;
    expect(editor.contentOf('/a.txt')).toBeUndefined();
    expect(editor.modeOf('/a.txt')).toBe('probing');

    const heldProbe = deferred<Awaited<ReturnType<typeof backend.fileInfo>>>();
    const originalInfo = backend.fileInfo;
    backend.fileInfo = (path) => path === '/a.txt' ? heldProbe.promise : originalInfo(path);
    const next = editor.open('/a.txt');
    editor.clearAll();
    heldProbe.resolve(await originalInfo('/a.txt'));
    await next;
    expect(editor.modeOf('/a.txt')).toBe('probing');
    expect(editor.contentOf('/a.txt')).toBeUndefined();
  });

  it('已淘汰文本的旧刷新不能在另一文件读入后复活', async () => {
    const fs = new FakeFs({ '/': ['a.txt', 'b.txt'] });
    fs.files.set('/a.txt', 'a'.repeat(40));
    fs.files.set('/b.txt', 'b'.repeat(40));
    const backend = fakeBackend(fs);
    const originalRead = backend.readFile;
    const held = deferred<string>();
    let delay = false;
    backend.readFile = (path) => path === '/a.txt' && delay ? held.promise : originalRead(path);
    const editor = createEditor(backend, { maxBytes: 90 });
    await editor.open('/a.txt');
    delay = true;
    const refreshing = editor.refresh('/a.txt');
    await Promise.resolve();
    await editor.open('/b.txt');
    expect(editor.contentOf('/a.txt')).toBeUndefined();
    held.resolve('stale');
    await refreshing;
    expect(editor.contentOf('/a.txt')).toBeUndefined();
    expect(editor.contentOf('/b.txt')).toBe('b'.repeat(40));
  });
  it('文本文件整份读入', async () => {
    await withEditor(async (editor, fs) => {
      fs.files.set('/a.txt', 'hello\nworld\n');
      expect(await editor.open('/a.txt')).toBe('text');
      expect(editor.contentOf('/a.txt')).toBe('hello\nworld\n');
      expect(fs.readCalls).toEqual(['/a.txt']);
    });
  });

  it('PDF 不当作文本读，哪怕它的开头看起来像文本', async () => {
    await withEditor(async (editor, fs) => {
      // 一个头部全是 ASCII 的 PDF：NUL 嗅探抓不到它，所以不能只靠嗅探。
      fs.files.set('/paper.pdf', '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n');
      expect(await editor.open('/paper.pdf')).toBe('binary');
      expect(editor.modeOf('/paper.pdf')).toBe('binary');
      // 一个字节都没读。
      expect(fs.readCalls).toEqual([]);
      // 并且说清楚该去哪里看，而不是只说“不是文本”。
      expect(editor.reasonOf('/paper.pdf')).toContain('preview');
    });
  });

  it('打开 PDF 不改变当前显示什么', async () => {
    await withEditor(async (editor, fs) => {
      fs.files.set('/paper.pdf', '%PDF-1.7\n');
      expect(await editor.open('/paper.pdf')).toBe('binary');
      // 预览是编译产物通道，由人显式切过去，不是点一个文件就跳过去。
      expect(editor.artifact()).toBeNull();
    });
  });

  it('二进制文件不硬读，而是报为 binary', async () => {
    await withEditor(async (editor, fs) => {
      fs.binaryFiles.add('/blob.bin');
      expect(await editor.open('/blob.bin')).toBe('binary');
      // 一个字节的内容都没读：探测器说它不是文本。
      expect(editor.contentOf('/blob.bin')).toBeUndefined();
      expect(fs.readCalls).toEqual([]);
    });
  });

  it('超过内存上限的文件不读入，而是报 oversized', async () => {
    await withEditor(async (editor, fs) => {
      fs.oversized.add('/big.txt');
      expect(await editor.open('/big.txt')).toBe('oversized');
      expect(editor.contentOf('/big.txt')).toBeUndefined();
      // 一个字节都没读：连试都不试，因为根本放不下。
      expect(fs.readCalls).toEqual([]);
      // 说清楚有多大，而不是只说“打不开”。
      expect(editor.reasonOf('/big.txt')).toMatch(/MB/);
      expect(editor.modeOf('/big.txt')).toBe('oversized');
    });
  });

  it('读不到的文件给出原因，而不是空页面', async () => {
    await withEditor(async (editor, fs) => {
      fs.failList.add('/a.txt');
      expect(await editor.open('/a.txt')).toBe('missing');
      expect(editor.reasonOf('/a.txt')).toContain('stat failed');
      // 模式必须和 open 的结论一致：否则界面会去画一个空视图。
      expect(editor.modeOf('/a.txt')).toBe('missing');
    });
  });

  it('重新打开会再试一次，而不是记住失败', async () => {
    await withEditor(async (editor, fs) => {
      fs.failList.add('/a.txt');
      expect(await editor.open('/a.txt')).toBe('missing');
      fs.failList.delete('/a.txt');
      fs.files.set('/a.txt', 'back\n');
      expect(await editor.open('/a.txt')).toBe('missing');
      editor.invalidate('/a.txt');
      expect(await editor.open('/a.txt')).toBe('text');
      expect(editor.contentOf('/a.txt')).toBe('back\n');
    });
  });
});

describe('内容驻留：活动文件和未保存的文件留下', () => {
  it('预算内的文件按 FIFO 让位', async () => {
    await withEditor(
      async (editor, fs) => {
        for (let i = 0; i < 8; i++) {
          fs.files.set(`/f${i}.txt`, 'x'.repeat(50));
          await editor.open(`/f${i}.txt`);
        }
        expect(editor.contentOf('/f0.txt')).toBeUndefined();
        expect(editor.contentOf('/f7.txt')).toBe('x'.repeat(50));
      },
      { maxBytes: 500 },
    );
  });

  it('活动文件被钉住，别的文件为它让位', async () => {
    await withEditor(
      async (editor, fs) => {
        for (let i = 0; i < 8; i++) fs.files.set(`/f${i}.txt`, 'x'.repeat(50));
        // 顺序与工作区一致：先定住要看的那一个，再读它。
        editor.syncPins('/f3.txt', new Set());
        await editor.open('/f3.txt');
        for (let i = 0; i < 8; i++) {
          if (i !== 3) await editor.open(`/f${i}.txt`);
        }
        expect(editor.contentOf('/f3.txt')).toBe('x'.repeat(50));
        expect(editor.contentOf('/f7.txt')).toBe('x'.repeat(50));
        // 预算之外的那些让位了，包括最早那个。
        expect(editor.contentOf('/f0.txt')).toBeUndefined();
      },
      { maxBytes: 500 },
    );
  });

  it('未保存的文件被钉住，即使它不活动', async () => {
    await withEditor(
      async (editor, fs) => {
        for (let i = 0; i < 8; i++) fs.files.set(`/f${i}.txt`, 'x'.repeat(50));
        editor.syncPins('/f7.txt', new Set(['/f1.txt']));
        await editor.open('/f1.txt');
        for (let i = 0; i < 8; i++) {
          if (i !== 1) await editor.open(`/f${i}.txt`);
        }
        expect(editor.contentOf('/f1.txt')).toBe('x'.repeat(50));
      },
      { maxBytes: 500 },
    );
  });

  it('换项目时不会带出上一个项目的内容', async () => {
    await withEditor(async (editor, fs) => {
      fs.files.set('/a.txt', 'from the old project');
      await editor.open('/a.txt');
      editor.clearAll();
      expect(editor.contentOf('/a.txt')).toBeUndefined();
      // 探测也一起清掉：下一次打开才是重新判断。
      expect(editor.modeOf('/a.txt')).toBe('probing');
    });
  });
});

describe('编译：结果与原因都在预览里', () => {
  it('成功时报出命令、耗时和产出的 PDF', async () => {
    await withEditor(async (editor, fs) => {
      fs.buildResults.push({
        ok: true,
        command: 'npm run pdf',
        code: 0,
        output: 'wrote out/main.pdf',
        durationMs: 1234,
        artifact: { path: '/out/main.pdf', absPath: '/p/out/main.pdf', size: 2048, builtMs: 9 },
      });
      const out = await editor.build('/p');
      expect(out?.ok).toBe(true);
      expect(editor.buildState()?.phase).toBe('ok');
      expect(editor.buildCommand()).toBe('npm run pdf');
      expect(editor.buildDuration()).toBe(1234);
      expect(editor.artifact()?.path).toBe('/out/main.pdf');
      // 预览要能真的把它打开，所以要走字节通道。
      expect(fs.artifactCalls).toEqual([]);
    });
  });

  it('失败时保留原因，并且不假装有产物', async () => {
    await withEditor(async (editor, fs) => {
      fs.buildResults.push({
        ok: false,
        command: 'make',
        code: 2,
        output: 'error: undefined reference to \\x',
        durationMs: 90,
        artifact: null,
      });
      const out = await editor.build('/p');
      expect(out?.ok).toBe(false);
      expect(editor.buildState()?.phase).toBe('failed');
      expect(editor.buildOutput()).toContain('undefined reference');
      // 上一次成功的产物不能在失败之后还挂在预览上。
      expect(editor.artifact()).toBeNull();
      expect(fs.buildCalls).toEqual([{ root: '/p' }]);
    });
  });

  it('编译命令本身跑不起来时，说明原因而不是空白', async () => {
    await withEditor(async (editor, fs) => {
      fs.buildThrows = 'no build command found';
      const out = await editor.build('/p');
      expect(out).toBeNull();
      expect(editor.buildState()?.phase).toBe('failed');
      expect(editor.buildState()?.error).toContain('no build command');
      expect(editor.buildOutput()).toContain('no build command');
    });
  });

  it('空占位说明将要执行什么，而不是假装已经编译过', async () => {
    await withEditor(async (editor, fs) => {
      fs.plan = {
        buildable: true,
        command: 'xelatex -interaction=nonstopmode main.tex  (2 passes)',
        reason: 'XeLaTeX',
        artifact: '/.rg/build/main.pdf',
        passes: 2,
        detail: null,
      };
      const plan = await editor.loadPlan('/p');
      expect(plan?.buildable).toBe(true);
      expect(editor.plan()?.reason).toBe('XeLaTeX');
      // 关键：占位不是内容。树里躺着一个 PDF 也不等于编译过。
      expect(editor.artifact()).toBeNull();
    });
  });

  it('切换目标只预检，旧响应不能覆盖当前目标，也不清空预览', async () => {
    const fs = new FakeFs({ '/': [] });
    const backend = fakeBackend(fs);
    type Plan = Awaited<ReturnType<typeof backend.buildPlan>>;
    const first = deferred<Plan>();
    const second = deferred<Plan>();
    backend.buildPlan = (path) => path === '/a/main.tex' ? first.promise : second.promise;
    const editor = createEditor(backend);
    fs.buildResults.push({
      ok: true, command: 'xelatex', code: 0, output: '', durationMs: 5,
      artifact: { path: '/main.pdf', absPath: '/a/main.pdf', size: 10, builtMs: 5 },
    });
    await editor.build('/a');
    const artifact = editor.artifact();
    const state = editor.buildState();
    const old = editor.loadPlan('/a/main.tex');
    const current = editor.loadPlan('/b');
    expect(editor.buildTarget()).toBeNull();
    expect(editor.plan()).toBeNull();
    first.resolve({ buildable: true, command: 'old', reason: null, artifact: null, passes: 2, detail: null });
    await old;
    expect(editor.plan()).toBeNull();
    expect(editor.buildTarget()).toBeNull();
    second.resolve({ buildable: false, command: null, reason: null, artifact: null, passes: 1, detail: 'Multiple .tex files' });
    await current;
    expect(editor.buildTarget()).toBe('/b');
    expect(editor.plan()?.detail).toBe('Multiple .tex files');
    expect(editor.artifact()).toBe(artifact);
    expect(editor.buildState()).toBe(state);
    expect(fs.buildCalls).toEqual([{ root: '/a' }]);
  });

  it('预检完成后一次替换目标与方案，期间保留上一组完整结果', async () => {
    const backend = fakeBackend(new FakeFs({ '/': [] }));
    type Plan = Awaited<ReturnType<typeof backend.buildPlan>>;
    const editor = createEditor(backend);
    const valid: Plan = { buildable: true, command: 'xelatex main.tex', reason: 'XeLaTeX', artifact: '/main.pdf', passes: 2, detail: null };
    const invalid: Plan = { buildable: false, command: null, reason: null, artifact: null, passes: 1, detail: 'No .tex file' };
    backend.buildPlan = async () => valid;
    await editor.loadPlan('/a');

    const first = deferred<Plan>();
    backend.buildPlan = () => first.promise;
    const checkingInvalid = editor.loadPlan('/b');
    expect(editor.buildTarget()).toBe('/a');
    expect(editor.plan()).toBe(valid);
    first.resolve(invalid);
    await checkingInvalid;
    expect(editor.buildTarget()).toBe('/b');
    expect(editor.plan()).toBe(invalid);

    const second = deferred<Plan>();
    backend.buildPlan = () => second.promise;
    const checkingValid = editor.loadPlan('/c');
    expect(editor.buildTarget()).toBe('/b');
    expect(editor.plan()).toBe(invalid);
    second.resolve(valid);
    await checkingValid;
    expect(editor.buildTarget()).toBe('/c');
    expect(editor.plan()).toBe(valid);
  });

  it('清空项目后，旧预检响应不能重新填入构建状态', async () => {
    const backend = fakeBackend(new FakeFs({ '/': [] }));
    const held = deferred<Awaited<ReturnType<typeof backend.buildPlan>>>();
    backend.buildPlan = () => held.promise;
    const editor = createEditor(backend);
    const pending = editor.loadPlan('/old');
    editor.clearAll();
    held.resolve({ buildable: true, command: 'old', reason: null, artifact: null, passes: 2, detail: null });
    await pending;
    expect(editor.buildTarget()).toBeNull();
    expect(editor.plan()).toBeNull();
  });

  it('没有可执行的构建时，占位直说而不是给一个会失败的按钮', async () => {
    await withEditor(async (editor, fs) => {
      fs.plan = {
        buildable: false,
        command: null,
        reason: null,
        artifact: null,
        passes: 1,
        detail: 'no build command found',
      };
      await editor.loadPlan('/p');
      expect(editor.plan()?.buildable).toBe(false);
      expect(editor.plan()?.detail).toContain('no build command');
    });
  });

  it('编译失败后，已经有的旧产物也不回填到预览', async () => {
    await withEditor(async (editor, fs) => {
      fs.buildResults.push({
        ok: true,
        command: 'xelatex',
        code: 0,
        output: '',
        durationMs: 10,
        artifact: { path: '/.rg/build/main.pdf', absPath: '/p/.rg/build/main.pdf', size: 10, builtMs: 5 },
      });
      await editor.build('/p');
      expect(editor.artifact()?.path).toBe('/.rg/build/main.pdf');

      fs.buildResults.push({
        ok: false,
        command: 'xelatex',
        code: 1,
        output: '! LaTeX Error: File `refs.tex` not found.',
        durationMs: 12,
        artifact: null,
      });
      await editor.build('/p');
      // 失败不把上一份文档顶回来：屏幕上留着它，但明确标记为失败。
      expect(editor.artifact()?.path).toBe('/.rg/build/main.pdf');
      expect(editor.buildState()?.phase).toBe('failed');
    });
  });

  it('重试保留失败页和旧错误，完成后才发布新页面', async () => {
    const fs = new FakeFs({ '/': [] });
    const backend = fakeBackend(fs);
    const editor = createEditor(backend);
    const success = {
      ok: true, command: 'xelatex', code: 0, output: 'done', durationMs: 10,
      artifact: { path: '/main.pdf', absPath: '/a/main.pdf', size: 10, builtMs: 5 },
    };
    fs.buildResults.push(success);
    await editor.build('/a');
    expect(editor.previewState()?.page).toBe('pdf');
    fs.buildThrows = 'original error';
    await editor.build('/a');
    const previous = editor.previewState();
    expect(previous).toEqual({ page: 'failed', error: 'original error' });
    expect(editor.artifact()).not.toBeNull();

    const held = deferred<typeof success>();
    backend.buildProject = () => held.promise;
    const retry = editor.build('/a');
    expect(editor.buildState()?.phase).toBe('running');
    expect(editor.previewState()).toBe(previous);
    expect(editor.buildOutput()).toBe('original error');
    held.resolve(success);
    await retry;
    expect(editor.previewState()).toEqual({ page: 'pdf', error: null });
    expect(editor.buildOutput()).toBe('done');

    const failed = deferred<typeof success>();
    backend.buildProject = () => failed.promise;
    const rebuild = editor.build('/a');
    expect(editor.previewState()?.page).toBe('pdf');
    failed.resolve({ ...success, ok: false, code: 1, output: 'new error' });
    await rebuild;
    expect(editor.previewState()?.page).toBe('failed');
    expect(editor.buildOutput()).toBe('new error');
    editor.clearAll();
    expect(editor.previewState()).toBeNull();
  });

  it('每次成功编译都换上新的 artifact 对象：预览的重开靠它触发', async () => {
    await withEditor(async (editor, fs) => {
      const artifact = () => ({
        path: '/out/main.pdf',
        absPath: '/p/out/main.pdf',
        size: 2048,
        builtMs: 9,
      });
      fs.buildResults.push({ ok: true, command: 'xelatex', code: 0, output: '', durationMs: 5, artifact: artifact() });
      await editor.build('/p');
      const first = editor.artifact();

      fs.buildResults.push({ ok: true, command: 'xelatex', code: 0, output: '', durationMs: 5, artifact: artifact() });
      await editor.build('/p');
      const second = editor.artifact();

      // 同一路径、同样大小：对象也必须是新的。预览不比较路径——它把
      // “artifact 信号被 set 了”当作“编译成功”事件本身。哪天有人把这里
      // 优化成路径相等就跳过 set，刷新就会悄悄地再坏一次。
      expect(second).not.toBe(first);
      expect(second?.absPath).toBe(first?.absPath);
    });
  });

  it('clearAll 把编译预览状态清干净，切换项目不残留旧 PDF', async () => {
    await withEditor(async (editor, fs) => {
      fs.buildResults.push({
        ok: true,
        command: 'xelatex',
        code: 0,
        output: 'wrote out/main.pdf',
        durationMs: 5,
        artifact: { path: '/out/main.pdf', absPath: '/p/out/main.pdf', size: 10, builtMs: 5 },
      });
      await editor.build('/p');
      await editor.loadPlan('/p');
      expect(editor.artifact()).not.toBeNull();

      editor.clearAll();

      // 打开另一个项目时 clearAll 会跑：上一个项目的产物、失败原因和
      // 构建计划都不能跟着过去，否则预览会展示一个不属于当前项目的文档。
      expect(editor.artifact()).toBeNull();
      expect(editor.buildState()).toBeNull();
      expect(editor.buildOutput()).toBe('');
      expect(editor.buildCommand()).toBe('');
      expect(editor.buildDuration()).toBeNull();
      expect(editor.plan()).toBeNull();
    });
  });
});
