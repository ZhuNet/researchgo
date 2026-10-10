import { createRoot } from 'solid-js';
import { beforeEach, describe, expect, it } from 'vitest';

import { createWorkspace, type Workspace } from '../src/store/workspace';
import { emitToolchainChange, fakeBackend, FakeFs, SAMPLE_TREE } from './fakefs';

function withWs(
  fn: (ws: Workspace, fs: FakeFs) => void | Promise<void>,
  tree = SAMPLE_TREE,
  limits?: Parameters<typeof createWorkspace>[2],
) {
  return createRoot(() => {
    const fs = new FakeFs(tree);
    const ws = createWorkspace(fakeBackend(fs), {}, limits);
    return Promise.resolve(fn(ws, fs)).then(() => ws.dispose());
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const paths = (ws: Workspace) => {
  const out: string[] = [];
  for (let i = 0; i < ws.rowCount(); i++) out.push(ws.rowAt(i)?.path ?? '?');
  return out;
};

describe('打开文件夹', () => {
  it('openFolder 装载根目录并默认展开', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      expect(ws.root()).toBe('/');
      expect(paths(ws)).toEqual(['/docs', '/src', '/README.md']);
      expect(ws.expanded().has('/')).toBe(true);
    });
  });

  it('打开后清空旧的 tab 与 dirty', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.openFile('/README.md');
      expect(ws.tabs()).toHaveLength(1);
      await ws.openFolder('/src');
      expect(ws.tabs()).toHaveLength(0);
      expect(ws.dirty().size).toBe(0);
    });
  });

  it('展开时才加载子目录（懒加载）', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      expect(fs.listCalls).toEqual([]);
      ws.setExpanded('/src', true);
      await flush();
      expect(fs.listCalls).toEqual(['/src']);
    });
  });

  it('关闭文件夹回到空状态', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.closeFolder();
      expect(ws.root()).toBeNull();
      expect(ws.rowCount()).toBe(0);
    });
  });
});

describe('文件树导航', () => {
  it('展开后行数增加，折叠后恢复', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      const before = ws.rowCount();
      ws.setExpanded('/src', true);
      await flush();
      expect(ws.rowCount()).toBe(before + 3);
      ws.setExpanded('/src', false);
      expect(ws.rowCount()).toBe(before);
    });
  });

  it('多层嵌套逐级展开', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      ws.setExpanded('/src/util', true);
      await flush();
      expect(paths(ws)).toContain('/src/util/helper.rs');
    });
  });

  it('indexOf 能在未展开时定位到文件', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      expect(paths(ws)[ws.indexOf('/src/lib.rs')]).toBe('/src/lib.rs');
    });
  });

  it('sliceRows 只返回窗口内的行', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      const slice = ws.sliceRows(0, 2);
      expect(slice).toHaveLength(2);
      expect(slice[0].path).toBe('/docs');
    });
  });
});

describe('打开文件与内容', () => {
  it('打开文件会加入 tab 并载入内容', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.files.set('/README.md', '# hello\nworld\n');
      await ws.openFile('/README.md');
      expect(ws.tabs()).toEqual(['/README.md']);
      expect(ws.active()).toBe('/README.md');
      expect(ws.contentOf('/README.md')).toBe('# hello\nworld\n');
    });
  });

  it('openFile 打开目录只负责加载，不改变展开状态', async () => {
    // 展开权只归 toggleDir。早期 openFile 内部也 toggle，而点击行与点击箭头
    // 各触发一次，导致"展开后立刻收起"——这正是回归的根源。
    await withWs(async (ws) => {
      await ws.openFolder('/');
      expect(ws.expanded().has('/src')).toBe(false);
      await ws.openFile('/src');
      expect(ws.tabs()).toHaveLength(0);
      expect(ws.expanded().has('/src')).toBe(false);
    });
  });

  it('连续两次 toggleDir 得到展开态，不会互相抵消', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.toggleDir('/src');
      expect(ws.expanded().has('/src')).toBe(true);
      await ws.toggleDir('/src');
      expect(ws.expanded().has('/src')).toBe(false);
    });
  });

  it('未加载的目录 toggleDir 也能展开，并补齐条目', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      const before = ws.rowCount();
      await ws.toggleDir('/docs');
      expect(ws.expanded().has('/docs')).toBe(true);
      expect(ws.rowCount()).toBeGreaterThan(before);
      expect(paths(ws)).toContain('/docs/guide.md');
    });
  });

  it('打开不存在的路径静默失败', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.openFile('/nope.rs');
      expect(ws.tabs()).toHaveLength(0);
    });
  });

  it('保存写回后端并清dirty', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      await ws.openFile('/README.md');
      ws.setDirty((prev) => new Set(prev).add('/README.md'));
      await ws.saveFile('/README.md', 'edited\n');
      expect(fs.files.get('/README.md')).toBe('edited\n');
      expect(ws.contentOf('/README.md')).toBe('edited\n');
      expect(ws.dirty().has('/README.md')).toBe(false);
    });
  });

  it('closeTab 后 active 指向剩余 tab', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.openFile('/README.md');
      await ws.openFile('/docs/guide.md');
      ws.closeTab('/docs/guide.md');
      expect(ws.active()).toBe('/README.md');
    });
  });
  it('打开一个 PDF 只是开一个 tab，不切到预览', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.openFile('/paper.pdf');
      expect(ws.tabs()).toEqual(['/paper.pdf']);
      expect(ws.active()).toBe('/paper.pdf');
      // 预览是编译产物通道，由人显式切过去。
      expect(ws.stageMode()).toBe('code');
      // 而且 PDF 不被当文本读。
      expect(ws.editor.modeOf('/paper.pdf')).toBe('binary');
      expect(ws.contentOf('/paper.pdf')).toBe('');
    }, { '/': ['paper.pdf', 'main.tex'] });
  });
});

describe('文件操作', () => {
  it('新建文件出现在树里', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      const created = await ws.createEntry('/src', 'new.rs', 'file');
      expect(created).toBe('/src/new.rs');
      expect(paths(ws)).toContain('/src/new.rs');
    });
  });

  it('重名时报错而不是静默返回 null', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.createEntry('/src', 'dup.rs', 'file');
      // 静默失败过一次：没有文件、没有任何提示。现在必须抛出可显示的原因。
      await expect(ws.createEntry('/src', 'dup.rs', 'file')).rejects.toThrow(
        /already exists/,
      );
    });
  });

  it('重命名会更新 tab、active 与缓存', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      await ws.openFile('/README.md');
      const renamed = await ws.renameEntry('/README.md', 'GUIDE.md');
      expect(renamed).toBe('/GUIDE.md');
      expect(ws.tabs()).toEqual(['/GUIDE.md']);
      expect(ws.active()).toBe('/GUIDE.md');
      expect(paths(ws)).toContain('/GUIDE.md');
      expect(fs.dirs.get('/')?.has('GUIDE.md')).toBe(true);
    });
  });

  it('删除文件会从树和 tab 中移除', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.openFile('/README.md');
      await ws.removeEntry('/README.md');
      expect(paths(ws)).not.toContain('/README.md');
      expect(ws.tabs()).toHaveLength(0);
    });
  });

  it('删除目录连同展开状态一起清掉', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      await ws.removeEntry('/src');
      expect(ws.expanded().has('/src')).toBe(false);
      expect(paths(ws)).not.toContain('/src');
    });
  });

  it('移动文件到另一个目录并重映射 tab', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.openFile('/README.md');
      const moved = await ws.move('/README.md', '/docs');
      expect(moved).toBe('/docs/README.md');
      expect(ws.active()).toBe('/docs/README.md');
      ws.setExpanded('/docs', true);
      await flush();
      expect(paths(ws)).toContain('/docs/README.md');
    });
  });

  it('移动到自身所在目录是 no-op', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      expect(await ws.move('/README.md', '/')).toBe('/README.md');
    });
  });

  it('移动到已存在同名文件会被拒绝', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.createEntry('/docs', 'guide.md', 'file');
      // /docs/guide.md 已存在，尝试把 /docs 下的同名文件移入自身
      expect(await ws.move('/docs/guide.md', '/docs')).toBe('/docs/guide.md');
    });
  });
});

describe('拖入文件', () => {
  it('拖入的文件出现在目标目录里', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.files.set('/tmp/paper.pdf', '%PDF\n');
      const copied = await ws.importInto('/docs', ['/tmp/paper.pdf']);
      expect(copied).toEqual(['/docs/paper.pdf']);
      expect(fs.copyCalls).toEqual([{ dest: '/docs', sources: ['/tmp/paper.pdf'] }]);
      ws.setExpanded('/docs', true);
      await flush();
      expect(paths(ws)).toContain('/docs/paper.pdf');
    });
  });

  it('同名时自动加序号而不是覆盖', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.files.set('/tmp/guide.md', 'new\n');
      const copied = await ws.importInto('/docs', ['/tmp/guide.md']);
      expect(copied).toEqual(['/docs/guide (1).md']);
      expect(fs.files.get('/docs/guide.md')).toBe('placeholder\n');
      expect(fs.files.get('/docs/guide (1).md')).toBe('new\n');
    });
  });

  it('拖入整个文件夹会递归复制', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.mkdir('/tmp/assets', ['logo.png', 'fonts']);
      fs.mkdir('/tmp/assets/fonts', ['mono.woff2']);
      const copied = await ws.importInto('/', ['/tmp/assets']);
      expect(copied).toEqual(['/assets']);
      ws.setExpanded('/assets', true);
      await flush();
      ws.setExpanded('/assets/fonts', true);
      await flush();
      expect(paths(ws)).toContain('/assets/logo.png');
      expect(paths(ws)).toContain('/assets/fonts/mono.woff2');
    });
  });

  it('无写入权限时报错', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.readOnly.add('/docs');
      fs.files.set('/tmp/x.md', 'x\n');
      await expect(ws.importInto('/docs', ['/tmp/x.md'])).rejects.toThrow(/Permission denied/);
    });
  });

  it('未打开文件夹时不复制', async () => {
    await withWs(async (ws, fs) => {
      fs.files.set('/tmp/x.md', 'x\n');
      expect(await ws.importInto('/docs', ['/tmp/x.md'])).toEqual([]);
      expect(fs.copyCalls).toEqual([]);
    });
  });
});

describe('磁盘同步', () => {
  it('展开目录会注册 watcher', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      expect(fs.watching).toEqual(['/']);
      ws.setExpanded('/src', true);
      await new Promise((r) => setTimeout(r, 0));
      expect(fs.watching).toEqual(['/', '/src']);
      ws.setExpanded('/src', false);
      await new Promise((r) => setTimeout(r, 0));
      expect(fs.watching).toEqual(['/']);
    });
  });

  it('外部新建文件后行立刻出现，且不产生读盘', async () => {
    // 事件本身就带类型，直接就地补丁即可；一次 listDirPage 都不该发生。
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      const before = fs.pageCalls.filter((c) => c.startsWith('/src@')).length;
      expect(paths(ws)).not.toContain('/src/fromdisk.rs');
      fs.addEntry('/src', 'fromdisk.rs', 'file');
      fs.emit({ dir: '/src', name: 'fromdisk.rs', kind: 'created', isDir: false });
      await flush();
      expect(paths(ws)).toContain('/src/fromdisk.rs');
      expect(fs.pageCalls.filter((c) => c.startsWith('/src@')).length).toBe(before);
    });
  });

  it('五百个事件不会变成五百次读盘', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      const before = fs.pageCalls.filter((c) => c.startsWith('/src@')).length;
      for (let i = 0; i < 500; i++) {
        fs.addEntry('/src', `gen${i}.rs`, 'file');
        fs.emit({ dir: '/src', name: `gen${i}.rs`, kind: 'created', isDir: false });
      }
      await flush();
      expect(paths(ws)).toContain('/src/gen499.rs');
      expect(fs.pageCalls.filter((c) => c.startsWith('/src@')).length).toBe(before);
    });
  });

  it('带旧名的重命名就地换位', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      const before = fs.pageCalls.filter((c) => c.startsWith('/src@')).length;
      fs.rename('/src/lib.rs', '/src/lib2.rs');
      fs.emit({
        dir: '/src',
        name: 'lib2.rs',
        from: 'lib.rs',
        kind: 'renamed',
        isDir: false,
      });
      await flush();
      expect(paths(ws)).toContain('/src/lib2.rs');
      expect(paths(ws)).not.toContain('/src/lib.rs');
      expect(fs.pageCalls.filter((c) => c.startsWith('/src@')).length).toBe(before);
    });
  });

  it('文件内容变化只重读打开中的缓冲', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.files.set('/README.md', '# hello\nworld\n');
      await ws.openFile('/README.md');
      expect(ws.contentOf('/README.md')).toBe('# hello\nworld\n');
      fs.files.set('/README.md', 'edited outside\n');
      fs.emit({ dir: '/', name: 'README.md', kind: 'changed' });
      await flush();
      expect(ws.contentOf('/README.md')).toBe('edited outside\n');
    });
  });

  it('外部删除文件后树会移除该行', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      expect(paths(ws)).toContain('/src/lib.rs');
      fs.removeEntry('/src/lib.rs');
      fs.emit({ dir: '/src', name: 'lib.rs', kind: 'removed' });
      await flush();
      expect(paths(ws)).not.toContain('/src/lib.rs');
    });
  });

  it('未缓存目录的事件被忽略（不产生无谓读盘）', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      const before = fs.listCalls.length;
      fs.emit({ dir: '/src', name: 'x.rs', kind: 'created' });
      await new Promise((r) => setTimeout(r, 0));
      expect(fs.listCalls.length).toBe(before);
    });
  });
});

describe('内存上限', () => {
  it('大量目录时缓存不超过上限', async () => {
    const tree: Record<string, string[]> = { '/': [] };
    for (let i = 0; i < 3000; i++) {
      const name = `d${i}`;
      tree['/'].push(name);
      tree[`/${name}`] = ['a.rs'];
    }
    await withWs(async (ws) => {
      await ws.openFolder('/');
      for (const entry of ws.entriesOf('/')) {
        await ws.ensureLoaded(entry.path);
      }
      const stats = ws.stats();
      expect(stats.dirs).toBeLessThanOrEqual(stats.maxDirs);
    }, tree);
  });

  it('未展开的目录被淘汰后重新展开能恢复', async () => {
    const tree: Record<string, string[]> = { '/': [] };
    for (let i = 0; i < 2500; i++) {
      const name = `d${i}`;
      tree['/'].push(name);
      tree[`/${name}`] = ['a.rs'];
    }
    await withWs(async (ws) => {
      await ws.openFolder('/');
      // 加载的目录数远超上限，队列头部（最早进入的）被挤出去。
      for (let i = 0; i < 2500; i++) await ws.ensureLoaded(`/d${i}`);
      const stats = ws.stats();
      expect(stats.dirs).toBeLessThanOrEqual(stats.maxDirs);
      const target = '/d10';
      expect(ws.entriesOf(target)).toHaveLength(0);
      ws.setExpanded(target, true);
      await flush();
      expect(paths(ws)).toContain('/d10/a.rs');
    }, tree);
  });
});

describe('超大项目：分页的行空间', () => {
  const bigTree = (dirs: number): Record<string, string[]> => {
    const tree: Record<string, string[]> = { '/': [] };
    for (let i = 0; i < dirs; i++) {
      tree['/'].push(`d${i}`);
      tree[`/d${i}`] = ['a.rs', 'b.rs'];
    }
    return tree;
  };

  it('打开目录只取一页，滚动高度不按总数虚报', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      const listing = ws.listingOf('/')!;
      expect(listing.total).toBe(2500);
      expect(listing.entries).toHaveLength(512);
      expect(listing.complete).toBe(false);
      // 512 个子项 + 一行"还有更多"，而不是 2500 行。
      expect(ws.rowCount()).toBe(513);
      expect(ws.rowAt(512)?.more).toBe(true);
      expect(ws.rowAt(512)?.moreCount).toBe(2500 - 512);
    }, bigTree(2500));
  });

  it('载入下一页只追加在末尾，已有的行号不动', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      const before = paths(ws);
      await ws.loadMore('/');
      const after = paths(ws);
      expect(after).toHaveLength(513 + 512);
      expect(after.slice(0, 512)).toEqual(before.slice(0, 512));
      expect(ws.listingOf('/')!.complete).toBe(false);
      expect(ws.rowAt(1024)?.more).toBe(true);
    }, bigTree(2500));
  });

  it('取完后哨兵消失，最后一行就是目录的真实末项', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      for (let page = 0; page < 6; page++) await ws.loadMore('/');
      const listing = ws.listingOf('/')!;
      expect(listing.complete).toBe(true);
      expect(ws.rowCount()).toBe(2500);
      // 排序是字典序（与 Rust 索引一致），所以最后一项是 d999 而不是 d2499。
      expect(paths(ws)[2499]).toBe('/d999');
      expect(paths(ws)[2498]).toBe('/d998');
      await ws.loadMore('/');
      expect(ws.rowCount()).toBe(2500);
    }, bigTree(2500));
  });

  it('超过目录上限后，行号保持稳定且被淘汰的目录标为 pending', async () => {
    // 2500 个子目录，缓存上限远小于此。逐个加载到超出上限之后：
    //  - 行号不能错乱（这是"无限树"的前提）
    //  - 被淘汰的目录降级为一行 pending，滚回去会重新加载
    await withWs(async (ws) => {
      await ws.openFolder('/');
      for (let i = 0; i < 2500; i++) {
        const dir = `/d${i}`;
        await ws.ensureLoaded(dir);
        ws.setExpanded(dir, true);
      }
      await flush();

      const stats = ws.stats();
      expect(stats.dirs).toBeLessThanOrEqual(stats.maxDirs);

      const total = ws.rowCount();
      expect(total).toBeGreaterThan(40);
      const at = paths(ws);
      for (const i of [0, 1, 7, 29, total - 1]) {
        expect(ws.rowAt(i)?.path).toBe(at[i]);
      }
      const pending = at.map((_, i) => ws.rowAt(i)).filter((r) => r?.pending);
      expect(pending.length).toBeGreaterThan(0);
      for (const row of pending.slice(0, 5)) {
        await ws.ensureLoaded(row!.path);
        expect(ws.rowAt(row!.index)?.pending).toBe(false);
      }
    }, bigTree(2500));
  });
});

describe('新建条目的输入校验', () => {
  it('拒绝含路径分隔符的名字，避免写到目录之外', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      await expect(ws.createEntry('/src', 'a/b.rs', 'file')).rejects.toThrow(/invalid name/);
      await expect(ws.createEntry('/src', '..', 'dir')).rejects.toThrow(/invalid name/);
      await ws.createEntry('/src', 'ok.rs', 'file');
      expect(fs.files.has('/src/ok.rs')).toBe(true);
    });
  });
});

describe('钉住：活动文件不会被淘汰', () => {
  it('文本缓冲按 FIFO 淘汰，但活动文件与未保存的留在内存里', async () => {
    const tree: Record<string, string[]> = { '/': [] };
    for (let i = 0; i < 200; i++) tree['/'].push(`f${i}.rs`);
    await withWs(async (ws) => {
      await ws.openFolder('/');
      await ws.openFile('/f0.rs');
      ws.setDirty((prev) => new Set(prev).add('/f1.rs'));
      await ws.openFile('/f1.rs');
      for (let i = 2; i < 160; i++) await ws.openFile(`/f${i}.rs`);
      expect(ws.active()).toBe('/f159.rs');
      // 活动文件：必须还在。
      expect(ws.isLoaded('/f159.rs')).toBe(true);
      // 未保存的：丢了就是丢编辑，必须还在。
      expect(ws.isLoaded('/f1.rs')).toBe(true);
      // 早就打开、又不活动也没改的：按 FIFO 让位。
      expect(ws.isLoaded('/f0.rs')).toBe(false);
    }, tree, { maxBytes: 400 });
  });

  it('活动文件的祖先目录在大量加载中留在内存里', async () => {
    const tree: Record<string, string[]> = { '/': ['src'], '/src': ['deep'], '/src/deep': ['a.rs'] };
    for (let i = 0; i < 3000; i++) {
      tree['/'].push(`d${i}`);
      tree[`/d${i}`] = ['x.rs'];
    }
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.setExpanded('/src', true);
      await flush();
      ws.setExpanded('/src/deep', true);
      await flush();
      await ws.openFile('/src/deep/a.rs');
      // 组件每次窗口变化都会重算保护集合；这里手动模拟一次。
      ws.protectWindow(0, 20);
      for (let i = 0; i < 3000; i++) await ws.ensureLoaded(`/d${i}`);
      expect(ws.stats().dirs).toBeLessThanOrEqual(ws.stats().maxDirs);
      expect(ws.entriesOf('/src')).toHaveLength(1);
      expect(ws.entriesOf('/src/deep')).toHaveLength(1);
    }, tree);
  });

  it('打开常驻页之外的路径时向宿主问一次，而不是猜', async () => {
    const tree: Record<string, string[]> = { '/': [] };
    for (let i = 0; i < 2000; i++) tree['/'].push(`f${i}.rs`);
    await withWs(async (ws) => {
      await ws.openFolder('/');
      expect(ws.entriesOf('/')).toHaveLength(512);
      // f1999.rs 在第 1999 个偏移，本地根本没读过这一页。
      await ws.openFile('/f1999.rs');
      expect(ws.tabs()).toEqual(['/f1999.rs']);
      expect(ws.contentOf('/f1999.rs')).toBe('placeholder\n');
    }, tree);
  });
});

describe('读不动的目录', () => {
  it('读盘失败会被记住，不会每次滚动都重试', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.failList.add('/src');
      await ws.toggleDir('/src');
      await flush();
      // 组件每次渲染都会交出窗口范围，状态集合也在这里算出来。
      ws.protectWindow(0, 20);

      // 明确说出"读不了"，而不是永远停在 loading。
      expect([...ws.unreadable()]).toEqual(['/src']);
      expect([...ws.missing()]).toEqual([]);
      const after = fs.pageCalls.filter((c) => c.startsWith('/src@')).length;
      expect(after).toBe(1);

      // 再滚动几次也不会变成请求风暴。
      for (let i = 0; i < 3; i++) {
        ws.protectWindow(0, 20);
        await flush();
      }
      expect(fs.pageCalls.filter((c) => c.startsWith('/src@')).length).toBe(after);
    });
  });

  it('refresh 是明确的用户动作，所以会重试并报出错误', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.failList.add('/src');
      await ws.toggleDir('/src');
      await flush();
      ws.protectWindow(0, 20);
      expect([...ws.unreadable()]).toEqual(['/src']);

      fs.failList.clear();
      await ws.refresh('/src');
      await flush();
      expect([...ws.unreadable()]).toEqual([]);
      expect(ws.entriesOf('/src').length).toBeGreaterThan(0);
    });
  });
});

describe('展开不该闪一下 loading', () => {
  it('预热之后再展开，不再产生新的读盘', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      const before = fs.pageCalls.filter((c) => c.startsWith('/src@')).length;

      // 指针停在目录上：预热第一页。
      await ws.prefetch('/src');
      expect(fs.pageCalls.filter((c) => c.startsWith('/src@')).length).toBe(before + 1);
      expect([...ws.missing()]).toEqual([]);

      // 接着点开：数据已经在内存里，这一行不需要再说 loading。
      fs.pageCalls.length = 0;
      await ws.toggleDir('/src');
      expect(fs.pageCalls.filter((c) => c.startsWith('/src@')).length).toBe(0);
      expect(paths(ws)).toContain('/src/lib.rs');
    });
  });

  it('常驻但已过期的目录照常展开，重读在背后进行', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      await ws.toggleDir('/src');
      await flush();
      expect(paths(ws)).toContain('/src/lib.rs');

      // 磁盘动了一下 → 这份 listing 过期，但行还在屏幕上。
      fs.addEntry('/src', 'mystery.rs', 'file');
      fs.emit({ dir: '/src', name: 'mystery.rs', kind: 'renamed' });
      await flush();
      expect(ws.listingOf('/src')!.stale).toBe(true);

      ws.setExpanded('/src', false);
      fs.pageCalls.length = 0;
      await ws.toggleDir('/src');

      // 展开是同步可见的：已有的行立刻在，不用等重读回来。
      expect(paths(ws)).toContain('/src/lib.rs');
      expect([...ws.missing()]).toEqual([]);

      await flush();
      expect(ws.listingOf('/src')!.stale).toBe(false);
      expect(fs.pageCalls.filter((c) => c.startsWith('/src@')).length).toBeGreaterThan(0);
      expect(paths(ws)).toContain('/src/mystery.rs');
    });
  });

  it('预热读不动的目录不会弹提示，但失败仍被记住', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.failList.add('/src');
      await ws.prefetch('/src');
      // 折叠状态下不打扰任何人：失败先记着，等真的要展开它才说出来。
      ws.protectWindow(0, 20);
      expect([...ws.unreadable()]).toEqual([]);

      await ws.toggleDir('/src');
      await flush();
      ws.protectWindow(0, 20);
      expect([...ws.unreadable()]).toEqual(['/src']);

      // 记住了就不会一直重试。
      const after = fs.pageCalls.length;
      await ws.prefetch('/src');
      await ws.ensureLoaded('/src');
      expect(fs.pageCalls.length).toBe(after);
    });
  });
});

describe('刷新不越界', () => {
  const wide = (n: number): Record<string, string[]> => ({
    '/': Array.from({ length: n }, (_, i) => `f${i}.rs`),
  });

  it('refresh 只重读已常驻的页，不会顺手把整个目录拉下来', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      await ws.loadMore('/');
      expect(ws.listingOf('/')!.entries).toHaveLength(1024);
      fs.pageCalls.length = 0;
      await ws.refresh('/');
      // 常驻了两页，就只重读这两页。
      expect(fs.pageCalls).toEqual(['/@0', '/@512']);
      expect(ws.listingOf('/')!.entries).toHaveLength(1024);
      expect(ws.listingOf('/')!.total).toBe(2000);
    }, wide(2000));
  });

  it('常驻深度不会因为一次刷新而变浅', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      for (let i = 0; i < 2; i++) await ws.loadMore('/');
      expect(ws.listingOf('/')!.entries).toHaveLength(1536);
      fs.pageCalls.length = 0;
      await ws.refresh('/');
      expect(fs.pageCalls).toEqual(['/@0', '/@512', '/@1024']);
      expect(ws.listingOf('/')!.entries).toHaveLength(1536);
      expect(paths(ws)).toHaveLength(1537); // 1536 项 + 一行哨兵
    }, wide(2000));
  });
});

describe('写入权限', () => {
  it('canWrite 如实反映目录可写性，并在内容刷新后失效缓存', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      expect(await ws.canWrite('/src')).toBe(true);
      expect(await ws.canWrite('/')).toBe(true);

      fs.readOnly.add('/src');
      // 缓存命中时不会重新探测，刷新该目录后必须重新判断。
      await ws.refresh('/src');
      expect(await ws.canWrite('/src')).toBe(false);
      expect(await ws.canWrite('/')).toBe(true);
    });
  });

  it('往只读目录创建会被拒绝并给出可读原因', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');
      fs.readOnly.add('/src');
      await expect(ws.createEntry('/src', 'x.rs', 'file')).rejects.toThrow();
      expect(fs.files.has('/src/x.rs')).toBe(false);
    });
  });
});

describe('本机编译环境变了', () => {
  it('装好 xelatex 后会重新问一遍能不能构建', async () => {
    await withWs(async (ws, fs) => {
      await ws.openFolder('/');

      // 打开项目时工具链还没装：预览会据此把 Build 置灰。
      fs.plan = {
        buildable: false,
        command: 'xelatex -interaction=nonstopmode main.tex  (2 passes)',
        reason: 'XeLaTeX',
        artifact: '/.rg/build/main.pdf',
        passes: 2,
        detail: 'xelatex was not found on PATH',
      };
      await ws.editor.loadPlan('/');
      expect(ws.editor.plan()?.buildable).toBe(false);

      // 用户在终端里装完 MiKTeX，宿主发出 PATH 变化。
      fs.plan = { ...fs.plan, buildable: true, detail: null };
      emitToolchainChange(fs);
      await flush();

      // 不重启 app，Build 自己恢复可点。
      expect(ws.editor.plan()?.buildable).toBe(true);
    });
  });

  it('没有打开项目时不追问', async () => {
    await withWs(async (ws, fs) => {
      fs.plan = {
        buildable: true,
        command: 'xelatex main.tex  (2 passes)',
        reason: 'XeLaTeX',
        artifact: '/.rg/build/main.pdf',
        passes: 2,
        detail: null,
      };
      emitToolchainChange(fs);
      await flush();

      // 没有 root 就没有可构建的对象，这次事件没有可问的东西。
      expect(ws.editor.plan()).toBeNull();
    });
  });
});

describe('打开文件回到源码', () => {
  it('在预览里点开文件会切回 Source', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.setStageMode('pdf');
      expect(ws.stageMode()).toBe('pdf');

      await ws.openFile('/README.md');

      // 否则读者要点开文件、再发现编辑器被预览挡着、再手动点回 Source。
      expect(ws.stageMode()).toBe('code');
      expect(ws.active()).toBe('/README.md');
    });
  });

  it('在分屏里点开文件也会切回 Source', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.setStageMode('split');

      await ws.openFile('/README.md');

      expect(ws.stageMode()).toBe('code');
    });
  });

  it('打开目录不会切走当前视图', async () => {
    await withWs(async (ws) => {
      await ws.openFolder('/');
      ws.setStageMode('pdf');

      // 目录不是文件：展开它不代表想读什么，不该把预览换掉。
      await ws.openFile('/src');

      expect(ws.stageMode()).toBe('pdf');
    });
  });
});
