import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';

import { MonacoDocuments } from '../src/lib/monacoDocuments';

describe('Monaco 文档生命周期', () => {
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
});
