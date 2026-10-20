import { batch, createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type * as Monaco from 'monaco-editor';

import { Icon } from '../Icon';
import { langOf } from '../../lib/fs';
import { SHIKI_LANGS, SHIKI_THEME } from '../../lib/highlight';
import { initMonaco, monaco } from '../../lib/monaco';
import { monacoDocuments } from '../../lib/monacoDocuments';
import { setWrap, theme, toast, wrap } from '../../store/ui';
import type { EditorSelection, Workspace } from '../../store/workspace';

/**
 * Text editing, by Monaco.
 *
 * Monaco owns editing, scrolling, selection, wrapping, undo, line numbers and the
 * minimap. What remains here is only what is specific to this app: which file is
 * open, when a buffer is unsaved, saving through the workspace, and the status bar.
 */

/** The Monaco language id for a path; anything uncolourable is plain text. */
function languageFor(path: string): string {
  const lang = langOf(path);
  return SHIKI_LANGS.has(lang) ? lang : 'plaintext';
}

/**
 * Above this many characters the editor turns off the parts that cost the most per
 * line — the minimap, folding, occurrence highlighting — so a big file still types
 * and scrolls smoothly. It is far above any source file and well below the 64 MB
 * ceiling the store refuses to open past.
 */
const LARGE_FILE_CHARS = 2 * 1024 * 1024;

export function MonacoText(props: { ws: Workspace; path: string }) {
  const listenerOwner = Symbol('monaco-text');
  let host: HTMLDivElement | undefined;
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  let unregisterEditor: (() => void) | undefined;
  let current = '';
  /** Whether the file on screen is big enough that the heavy options are off. */
  let large = false;

  const [caret, setCaret] = createSignal({ line: 1, col: 1 });
  const [lineCount, setLineCount] = createSignal(1);
  const [selected, setSelected] = createSignal(0);
  const dirty = () => props.ws.dirty().has(props.path);

  function markDirty(path: string): void {
    props.ws.setDirty((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }

  /**
   * Turns the expensive decorations on or off for the size of what is loaded.
   *
   * Called on every adopt, so switching from a large file back to a small one
   * restores the minimap and wrapping rather than leaving the editor in its sparse
   * mode.
   */
  function density(size: number): void {
    large = size > LARGE_FILE_CHARS;
    editor?.updateOptions({
      minimap: { enabled: !large, renderCharacters: false },
      folding: !large,
      occurrencesHighlight: large ? 'off' : 'singleFile',
      renderWhitespace: large ? 'none' : 'selection',
      renderLineHighlight: large ? 'none' : 'all',
      wordWrap: large || !wrap() ? 'off' : 'on',
    });
  }

  function modelFor(path: string, content: string): Monaco.editor.ITextModel {
    const uri = monaco.Uri.file(path);
    let model = monacoDocuments.model(path);
    if (!model) {
      // Monaco's registry outlives editor views. A model that is not in this
      // document registry has no current workspace owner or change listener, so
      // adopting it would join this tab to stale data. Remove the orphan instead.
      monaco.editor.getModel(uri)?.dispose();
      model = monaco.editor.createModel(content, languageFor(path), uri);
    }
    monacoDocuments.setModel(path, model);
    if (model.getValue() !== content) {
      monacoDocuments.writeExternal(model, () => model.setValue(content));
    }
    // Models deliberately outlive this component, but the workspace store does
    // not necessarily do so: a dev refresh can rebuild the app while Monaco keeps
    // the model. Rebind on every adoption so edits are delivered to the current
    // workspace rather than to the store captured by the old component instance.
    const subscription = model.onDidChangeContent(() => {
      if (monacoDocuments.isExternal(model)) return;
      batch(() => {
        markDirty(path);
        props.ws.editor.setContent(path, model.getValue());
      });
    });
    monacoDocuments.bind(model, listenerOwner, subscription);
    return model;
  }

  function countLines(): void {
    const model = editor?.getModel();
    setLineCount(model ? model.getLineCount() : 1);
  }

  function readSelection(): EditorSelection | null {
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    if (!model || !selection || !current) return null;
    const text = model.getValueInRange(selection);
    if (!text.trim()) return null;
    return {
      path: current,
      text,
      startLine: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLine: selection.endLineNumber,
      endColumn: selection.endColumn,
    };
  }

  function publishSelection(): void {
    const selection = readSelection();
    if (!selection) {
      setSelected(0);
      props.ws.setEditorSelection(null);
      return;
    }
    setSelected(selection.text.length);
    props.ws.setEditorSelection(selection);
  }

  /**
   * Points the editor at a file, or at content that changed underneath it.
   *
   * The two cases are separated on purpose. A different path is a different model,
   * and keeps whatever the reader left in the last one. The same path with different
    * content is a change from outside. Disk content replaces even unsaved edits.
   */
  function adopt(path: string, content: string, loaded: boolean): void {
    if (!editor) return;
    if (path !== current) {
      if (current) {
        const saved = editor.saveViewState();
        if (props.ws.tabs().includes(current)) {
          monacoDocuments.saveView(current, saved as Monaco.editor.ICodeEditorViewState | null);
        }
      }
      current = path;
      editor.setModel(modelFor(path, content));
      const view = monacoDocuments.view(path);
      if (view) editor.restoreViewState(view);
      else editor.setPosition({ lineNumber: 1, column: 1 });
      publishSelection();
      density(content.length);
      // Restoring a view restores the caret's position, but not DOM focus. A tab
      // click leaves focus on the tab button, so Monaco keeps the restored caret
      // hidden until the reader clicks inside the text again. Run after the
      // activation event has settled so the editor, rather than the tab button,
      // owns focus and paints the caret immediately.
      queueMicrotask(() => {
        if (editor && current === path && props.ws.tabs().includes(path)) editor.focus();
      });
      return;
    }
    const model = editor.getModel();
    if (!model) return;
    // The buffer is dropped before every re-read (save, external change), so for a
    // moment `content` is empty because the fresh copy is on its way, not because
    // the file is empty. Applying that empty string is what blanked and refilled
    // the editor — once per reload. Skip until the content is actually resident.
    if (!loaded && content === '') return;
    if (model.getValue() === content) return;
    monacoDocuments.writeExternal(model, () => model.setValue(content));
    density(content.length);
  }

  function save(): void {
    if (!editor || !current) return;
    const value = editor.getValue();
    void props.ws.saveFile(current, value).then(() => {
      toast('ok', 'Saved', current);
    });
  }

  onMount(() => {
    let alive = true;
    void initMonaco().then(() => {
      if (!alive || !host) return;
      const style = getComputedStyle(document.documentElement);
      const px = (name: string, fallback: number) => {
        const value = Number.parseFloat(style.getPropertyValue(name));
        return Number.isFinite(value) && value > 0 ? value : fallback;
      };
      editor = monaco.editor.create(host, {
        model: null,
        theme: theme() === 'dark' ? SHIKI_THEME.dark : SHIKI_THEME.light,
        automaticLayout: true,
        fontFamily: style.getPropertyValue('--font-mono').trim() || 'monospace',
        fontSize: px('--code-font-size', 12),
        lineHeight: px('--code-line-h', 20),
        tabSize: 4,
        minimap: { enabled: true, renderCharacters: false },
        wordWrap: wrap() ? 'on' : 'off',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      unregisterEditor = monacoDocuments.registerEditor(editor);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
      editor.onDidChangeCursorPosition((e) =>
        setCaret({ line: e.position.lineNumber, col: e.position.column }),
      );
      editor.onDidChangeCursorSelection(publishSelection);
      editor.onDidChangeModel(countLines);
      editor.onDidChangeModelContent(countLines);
      adopt(props.path, props.ws.contentOf(props.path), props.ws.isLoaded(props.path));
    });
    onCleanup(() => {
      alive = false;
      if (current && editor && props.ws.tabs().includes(current)) {
        const saved = editor.saveViewState();
        monacoDocuments.saveView(current, saved as Monaco.editor.ICodeEditorViewState | null);
      }
      // A replacement component may already have adopted the same model. Only
      // remove subscriptions that still belong to this instance, otherwise an
      // overlapping HMR cleanup would disconnect the new workspace again.
      monacoDocuments.unbind(listenerOwner);
      unregisterEditor?.();
      unregisterEditor = undefined;
      editor?.dispose();
      editor = undefined;
      current = '';
    });
  });

  // A file's content can arrive after its tab: the workspace activates the tab and
  // then reads the file, so the first value seen here is often still empty.
  createEffect(() => {
    const path = props.path;
    const content = props.ws.contentOf(path);
    const loaded = props.ws.isLoaded(path);
    if (editor) adopt(path, content, loaded);
  });

  createEffect(() => {
    const next = theme();
    if (editor) monaco.editor.setTheme(next === 'dark' ? SHIKI_THEME.dark : SHIKI_THEME.light);
  });

  createEffect(() => {
    const on = wrap();
    editor?.updateOptions({ wordWrap: on && !large ? 'on' : 'off' });
  });

  return (
    <div class="viewer">
      <div class="viewer__monaco" ref={host} />
      <div class="statusbar">
        <div class="statusbar__left">
          <button class="statusbar__btn" title="Problems">0 errors</button>
          <Show when={selected() > 0}>
            <span class="statusbar__btn" title="Selection">
              {selected()} selected
            </span>
          </Show>
        </div>
        <div class="statusbar__right">
          <span>Ln {caret().line}, Col {caret().col}</span>
          <span>{lineCount()} lines</span>
          <button
            class="statusbar__btn"
            classList={{ 'statusbar__btn--on': wrap() }}
            onClick={() => setWrap(!wrap())}
            title="Toggle word wrap"
          >
            <Icon name="wrapText" size={12} />
            Wrap
          </button>
          <Show when={dirty()}>
            <button class="statusbar__btn statusbar__btn--warn" onClick={save} title="Save  ⌘S">
              <Icon name="save" size={12} />
              Save
            </button>
          </Show>
          <span class="statusbar__lang">{langOf(props.path)}</span>
          <span>UTF-8</span>
          <span>LF</span>
        </div>
      </div>
    </div>
  );
}
