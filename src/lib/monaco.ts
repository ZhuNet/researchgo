import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { shikiToMonaco } from '@shikijs/monaco';

import { highlighter, SHIKI_LANGS } from './highlight';

/**
 * Monaco, set up exactly once.
 *
 * Two things have to be settled before the first editor exists, and both of them
 * are invisible until they are wrong:
 *
 * - The workers. Monaco runs its language engines in web workers, and a bundled
 *   build cannot guess their URLs, so each one is imported through Vite's worker
 *   loader and handed over here. Without this the editor still renders and then
 *   quietly reports errors for every language that has a service.
 * - The colours. Monaco ships its own theme. Handing it shiki means the editor is
 *   coloured by the same theme the large-file view and the file tree already use,
 *   so the two views of one file cannot disagree about what a keyword looks like.
 *
 * `ready` is a module-level promise so that a second editor created later — a split
 * pane, a tab switch back from a PDF — waits on the same setup rather than repeating
 * it or racing it.
 */
let ready: Promise<void> | null = null;

export function initMonaco(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
        getWorker(_id: string, label: string): Worker {
          if (label === 'json') return new jsonWorker();
          if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
          if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
          if (label === 'typescript' || label === 'javascript') return new tsWorker();
          return new editorWorker();
        },
      };
      // The bridge only colours languages Monaco has heard of, and it reads that
      // list once. Monaco happens to name a language differently from shiki often
      // enough to matter — it has `shell`, not `bash`; `dockerfile`, not `docker` —
      // so a shiki language whose id Monaco does not recognise is declared here,
      // before the bridge looks. Without this those files open uncoloured, which
      // looks like the highlighter being broken rather than like a missing name.
      const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
      for (const lang of SHIKI_LANGS) {
        if (!known.has(lang)) monaco.languages.register({ id: lang });
      }
      shikiToMonaco(await highlighter(), monaco);
    })();
  }
  return ready;
}

export { monaco };
