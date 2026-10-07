import { createRoot } from 'solid-js';
import { describe, expect, it } from 'vitest';

import { createEditor, type EditorLimits } from '../src/store/editor';
import { FakeFs, fakeBackend } from './fakefs';

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
      const out = await editor.build('/p', true);
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
      await editor.build('/p', true);
      expect(editor.artifact()?.path).toBe('/.rg/build/main.pdf');

      fs.buildResults.push({
        ok: false,
        command: 'xelatex',
        code: 1,
        output: '! LaTeX Error: File `refs.tex` not found.',
        durationMs: 12,
        artifact: null,
      });
      await editor.build('/p', true);
      // 失败不把上一份文档顶回来：屏幕上留着它，但明确标记为失败。
      expect(editor.artifact()?.path).toBe('/.rg/build/main.pdf');
      expect(editor.buildState()?.phase).toBe('failed');
    });
  });
});