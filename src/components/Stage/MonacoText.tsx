import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type * as Monaco from 'monaco-editor';

import { Icon } from '../Icon';
import { langOf } from '../../lib/fs';
import { SHIKI_LANGS, SHIKI_THEME } from '../../lib/highlight';
import { initMonaco, monaco } from '../../lib/monaco';
import { setWrap, theme, toast, wrap } from '../../store/ui';
import type { Workspace } from '../../store/workspace';

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
 * Models outlive the view.
 *
 * A model holds the buffer, the undo stack and the language, and it is what makes a
 * tab switch instant. Keeping them outside the component means a view that is torn
 * down and rebuilt — switching the stage to the PDF preview and back — does not take
 * unsaved edits with it. They are released when their tab closes.
 */
const models = new Map<string, Monaco.editor.ITextModel>();
const views = new Map<string, Monaco.editor.ICodeEditorViewState>();

/**
 * Above this many characters the editor turns off the parts that cost the most per
 * line — the minimap, folding, occurrence highlighting — so a big file still types
 * and scrolls smoothly. It is far above any source file and well below the 64 MB
 * ceiling the store refuses to open past.
 */
const LARGE_FILE_CHARS = 2 * 1024 * 1024;

export function MonacoText(props: { ws: Workspace; path: string }) {
  let host: HTMLDivElement | undefined;
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  let current = '';
  /** Set while this app writes to a model, so a write is not mistaken for an edit. */
  let external = false;
  /** True once the reader has typed in the current model. */
  let touched = false;
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
    let model = models.get(path);
    if (!model) {
      model = monaco.editor.createModel(content, languageFor(path), monaco.Uri.file(path));
      model.onDidChangeContent(() => {
        if (external) return;
        touched = true;
        markDirty(path);
      });
      models.set(path, model);
    }
    return model;
  }

  function countLines(): void {
    const model = editor?.getModel();
    setLineCount(model ? model.getLineCount() : 1);
  }

  /**
   * Points the editor at a file, or at content that changed underneath it.
   *
   * The two cases are separated on purpose. A different path is a different model,
   * and keeps whatever the reader left in the last one. The same path with different
   * content is a change from outside — the file was edited on disk — and is applied
   * only when nothing here is unsaved, because an external change is not a reason to
   * throw away what someone is in the middle of typing.
   */
  function adopt(path: string, content: string, loaded: boolean): void {
    if (!editor) return;
    if (path !== current) {
      if (current) {
        const saved = editor.saveViewState();
        if (saved) views.set(current, saved as Monaco.editor.ICodeEditorViewState);
      }
      current = path;
      touched = false;
      editor.setModel(modelFor(path, content));
      const view = views.get(path);
      if (view) editor.restoreViewState(view);
      else editor.setPosition({ lineNumber: 1, column: 1 });
      density(content.length);
      countLines();
      return;
    }
    const model = editor.getModel();
    if (!model || touched) return;
    // The buffer is dropped before every re-read (save, external change), so for a
    // moment `content` is empty because the fresh copy is on its way, not because
    // the file is empty. Applying that empty string is what blanked and refilled
    // the editor — once per reload. Skip until the content is actually resident.
    if (!loaded && content === '') return;
    if (model.getValue() === content) return;
    external = true;
    model.setValue(content);
    external = false;
    density(content.length);
    countLines();
  }

  function save(): void {
    if (!editor || !current) return;
    const value = editor.getValue();
    void props.ws.saveFile(current, value).then(() => {
      touched = false;
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
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
      editor.onDidChangeCursorPosition((e) =>
        setCaret({ line: e.position.lineNumber, col: e.position.column }),
      );
      editor.onDidChangeCursorSelection((e) => {
        const model = editor?.getModel();
        setSelected(model ? model.getValueLengthInRange(e.selection) : 0);
      });
      adopt(props.path, props.ws.contentOf(props.path), props.ws.isLoaded(props.path));
    });
    onCleanup(() => {
      alive = false;
      if (current && editor) {
        const saved = editor.saveViewState();
        if (saved) views.set(current, saved as Monaco.editor.ICodeEditorViewState);
      }
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

  // Letting go of a closed tab's model is what keeps this from becoming a record of
  // every file ever opened. Until then, keeping it is what preserves unsaved edits.
  createEffect(() => {
    const open = new Set(props.ws.tabs());
    for (const [path, model] of models) {
      if (open.has(path)) continue;
      model.dispose();
      models.delete(path);
      views.delete(path);
    }
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
