import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';

import { MonacoDocuments } from '../src/lib/monacoDocuments';

describe('Monaco 文档生命周期', () => {
  it('连续改名保留 model、监听和实时视图，并将文档所有权迁往新路径', () => {
    const documents = new MonacoDocuments();
    const dispose = vi.fn();
    const subscription = { dispose: vi.fn() };
    const model = { dispose } as unknown as Monaco.editor.ITextModel;
    const view = { cursorState: [], viewState: { scrollTop: 240 } } as unknown as Monaco.editor.ICodeEditorViewState;
    const editor = {
      getModel: () => model,
      saveViewState: () => view,
      setModel: vi.fn(),
    } as unknown as Monaco.editor.IStandaloneCodeEditor;
    documents.setModel('/a.txt', model);
    documents.bind(model, Symbol('owner'), subscription);
    documents.registerEditor(editor);

    documents.move('/a.txt', '/b.txt');
    documents.move('/b.txt', '/c.txt');

    expect(documents.model('/a.txt')).toBeUndefined();
    expect(documents.model('/b.txt')).toBeUndefined();
    expect(documents.model('/c.txt')).toBe(model);
    expect(documents.path(model)).toBe('/c.txt');
    expect(documents.view('/c.txt')).toBe(view);
    expect(editor.setModel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(subscription.dispose).not.toHaveBeenCalled();
    documents.release('/c.txt');
    expect(dispose).toHaveBeenCalledOnce();
    expect(subscription.dispose).toHaveBeenCalledOnce();
    expect(documents.path(model)).toBeUndefined();
  });

  it('关闭一个文档原子释放 model、监听、编辑器绑定和 view state', () => {
    const documents = new MonacoDocuments();
    const disposeModel = vi.fn();
    const disposeListener = vi.fn();
    const setModel = vi.fn();
    const model = { dispose: disposeModel } as unknown as Monaco.editor.ITextModel;
    const editor = {
      getModel: () => model,
      setModel,
    } as unknown as Monaco.editor.IStandaloneCodeEditor;

    documents.setModel('/a.txt', model);
    documents.saveView('/a.txt', { cursorState: [], viewState: {} } as unknown as Monaco.editor.ICodeEditorViewState);
    documents.bind(model, Symbol('owner'), { dispose: disposeListener });
    documents.registerEditor(editor);

    documents.release('/a.txt');

    expect(setModel).toHaveBeenCalledOnce();
    expect(setModel).toHaveBeenCalledWith(null);
    expect(disposeListener).toHaveBeenCalledOnce();
    expect(disposeModel).toHaveBeenCalledOnce();
    expect(documents.model('/a.txt')).toBeUndefined();
    expect(documents.view('/a.txt')).toBeUndefined();
  });

  it('没有编辑器挂载时仍释放 PDF 视角下留下的完整状态', () => {
    const documents = new MonacoDocuments();
    const disposeModel = vi.fn();
    const disposeListener = vi.fn();
    const model = { dispose: disposeModel } as unknown as Monaco.editor.ITextModel;

    documents.setModel('/paper.tex', model);
    documents.saveView('/paper.tex', { cursorState: [], viewState: {} } as unknown as Monaco.editor.ICodeEditorViewState);
    documents.bind(model, Symbol('owner'), { dispose: disposeListener });

    documents.release('/paper.tex');

    expect(disposeListener).toHaveBeenCalledOnce();
    expect(disposeModel).toHaveBeenCalledOnce();
    expect(documents.model('/paper.tex')).toBeUndefined();
    expect(documents.view('/paper.tex')).toBeUndefined();
  });

  it('重复点击当前 tab 时重新聚焦绑定该文档的编辑器', async () => {
    const documents = new MonacoDocuments();
    const focus = vi.fn();
    const model = { dispose: vi.fn() } as unknown as Monaco.editor.ITextModel;
    const editor = {
      getModel: () => model,
      focus,
    } as unknown as Monaco.editor.IStandaloneCodeEditor;

    documents.setModel('/a.txt', model);
    documents.registerEditor(editor);
    documents.focus('/a.txt');
    await Promise.resolve();

    expect(focus).toHaveBeenCalledOnce();
  });
});
