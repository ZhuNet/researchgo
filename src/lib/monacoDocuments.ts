import type * as Monaco from 'monaco-editor';

/**
 * The process-local state of every open Monaco document.
 *
 * A document's model and view state have one owner and one release operation. The
 * workspace calls that operation when a tab closes, so disposal does not depend on
 * an editor component being mounted (notably while the PDF-only view is showing).
 */
export class MonacoDocuments {
  private readonly models = new Map<string, Monaco.editor.ITextModel>();
  private readonly paths = new Map<Monaco.editor.ITextModel, string>();
  private readonly views = new Map<string, Monaco.editor.ICodeEditorViewState>();
  private readonly external = new Set<Monaco.editor.ITextModel>();
  private readonly listeners = new Map<Monaco.editor.ITextModel, {
    owner: symbol;
    subscription: Monaco.IDisposable;
  }>();
  private readonly editors = new Set<Monaco.editor.IStandaloneCodeEditor>();

  model(path: string): Monaco.editor.ITextModel | undefined {
    return this.models.get(path);
  }

  setModel(path: string, model: Monaco.editor.ITextModel): void {
    this.models.set(path, model);
    this.paths.set(model, path);
  }

  path(model: Monaco.editor.ITextModel): string | undefined {
    return this.paths.get(model);
  }

  /** A path change keeps the model, undo history, listeners and live view. */
  move(from: string, to: string): void {
    if (from === to) return;
    const model = this.models.get(from);
    let view = this.views.get(from);
    if (model) {
      for (const editor of this.editors) {
        if (editor.getModel() === model) view = editor.saveViewState() ?? view;
      }
    }
    this.release(to);
    this.models.delete(from);
    this.views.delete(from);
    if (model) this.setModel(to, model);
    if (view) this.views.set(to, view);
  }

  view(path: string): Monaco.editor.ICodeEditorViewState | undefined {
    return this.views.get(path);
  }

  saveView(path: string, view: Monaco.editor.ICodeEditorViewState | null): void {
    if (view) this.views.set(path, view);
  }

  bind(
    model: Monaco.editor.ITextModel,
    owner: symbol,
    subscription: Monaco.IDisposable,
  ): void {
    this.listeners.get(model)?.subscription.dispose();
    this.listeners.set(model, { owner, subscription });
  }

  unbind(owner: symbol): void {
    for (const [model, binding] of this.listeners) {
      if (binding.owner !== owner) continue;
      binding.subscription.dispose();
      this.listeners.delete(model);
    }
  }

  registerEditor(editor: Monaco.editor.IStandaloneCodeEditor): () => void {
    this.editors.add(editor);
    return () => this.editors.delete(editor);
  }

  /** Gives an already visible document keyboard focus, including a repeated tab click. */
  focus(path: string): void {
    const model = this.models.get(path);
    if (!model) return;
    queueMicrotask(() => {
      if (this.models.get(path) !== model) return;
      for (const editor of this.editors) {
        if (editor.getModel() === model) {
          editor.focus();
          return;
        }
      }
    });
  }

  isExternal(model: Monaco.editor.ITextModel): boolean {
    return this.external.has(model);
  }

  writeExternal(model: Monaco.editor.ITextModel, write: () => void): void {
    this.external.add(model);
    try {
      write();
    } finally {
      this.external.delete(model);
    }
  }

  /** Releases the complete editor-side state of one closed tab synchronously. */
  release(path: string): void {
    const model = this.models.get(path);
    if (model) {
      for (const editor of this.editors) {
        if (editor.getModel() === model) editor.setModel(null);
      }
      this.listeners.get(model)?.subscription.dispose();
      this.listeners.delete(model);
      this.external.delete(model);
      model.dispose();
      this.models.delete(path);
      this.paths.delete(model);
    }
    this.views.delete(path);
  }

  /** Releases every document through the same per-document exit path. */
  clear(): void {
    const paths = new Set([...this.models.keys(), ...this.views.keys()]);
    for (const path of paths) this.release(path);
  }
}

export const monacoDocuments = new MonacoDocuments();
