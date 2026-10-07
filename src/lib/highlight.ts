import type { HighlighterCore, LanguageInput } from 'shiki/core';

const DARK = 'github-dark-default';
const LIGHT = 'github-light-default';

const LANGS: Record<string, () => Promise<{ default: LanguageInput }>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  rust: () => import('@shikijs/langs/rust'),
  json: () => import('@shikijs/langs/json'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  html: () => import('@shikijs/langs/html'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  markdown: () => import('@shikijs/langs/markdown'),
  latex: () => import('@shikijs/langs/latex'),
  bibtex: () => import('@shikijs/langs/bibtex'),
  python: () => import('@shikijs/langs/python'),
  bash: () => import('@shikijs/langs/bash'),
  docker: () => import('@shikijs/langs/docker'),
  dotenv: () => import('@shikijs/langs/dotenv'),
  sql: () => import('@shikijs/langs/sql'),
  go: () => import('@shikijs/langs/go'),
  diff: () => import('@shikijs/langs/diff'),
};

let pending: Promise<HighlighterCore> | null = null;

function instance(): Promise<HighlighterCore> {
  if (!pending) {
    pending = (async () => {
      const [core, engine, dark, light] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('@shikijs/themes/github-dark-default'),
        import('@shikijs/themes/github-light-default'),
      ]);
      const langs = await Promise.all(Object.values(LANGS).map((load) => load()));
      return core.createHighlighterCore({
        themes: [dark.default, light.default],
        langs: langs.map((m) => m.default),
        engine: engine.createJavaScriptRegexEngine(),
      });
    })();
  }
  return pending;
}

export function warm(): void {
  void instance();
}

/** The shared highlighter, for a caller that needs to register it with an editor. */
export function highlighter(): Promise<HighlighterCore> {
  return instance();
}

/** The languages this app can colour; anything else is shown as plain text. */
export const SHIKI_LANGS: ReadonlySet<string> = new Set(Object.keys(LANGS));

/**
 * The two themes, by their shiki ids.
 *
 * These are also the Monaco theme ids: registering the highlighter with Monaco
 * defines a theme under the same name, so the editor's colours come from the theme
 * the rest of the app already uses rather than from a second one that has to be kept
 * in step by hand.
 */
export const SHIKI_THEME = { dark: DARK, light: LIGHT } as const;
