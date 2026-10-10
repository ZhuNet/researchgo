import { createMemo, createSignal, For, Show } from 'solid-js';

import { FileGlyph, Icon } from '../Icon';
import { fuzzyScore } from '../../lib/tree';
import type { Workspace } from '../../store/workspace';

interface Hit {
  path: string;
  line: number;
  text: string;
  score: number;
}

export function SearchPanel(props: { ws: Workspace }) {
  const [query, setQuery] = createSignal('');
  const [caseSensitive, setCaseSensitive] = createSignal(false);

  /**
   * Full-text search is inherently unbounded, so it runs over a bounded slice:
   * files already loaded into the text cache. Anything wider needs a real index
   * (ripgrep on the Rust side), which is the next step, not a frontend loop.
   */
  const hits = createMemo<Hit[]>(() => {
    const q = query().trim();
    if (q.length < 2) return [];
    const needle = caseSensitive() ? q : q.toLowerCase();
    const out: Hit[] = [];
    const seen = new Set<string>();
    const files: string[] = [];
    for (const path of props.ws.tabs()) files.push(path);
    if (props.ws.active()) files.push(props.ws.active() as string);
    for (const path of files) {
      if (seen.has(path)) continue;
      seen.add(path);
      const content = props.ws.contentOf(path);
      if (!content) continue;
      const name = path.slice(path.lastIndexOf('/') + 1);
      const nameScore = fuzzyScore(needle, name.toLowerCase());
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const hay = caseSensitive() ? lines[i] : lines[i].toLowerCase();
        const at = hay.indexOf(needle);
        if (at < 0) continue;
        out.push({
          path,
          line: i + 1,
          text: lines[i].trim().slice(0, 200),
          score: nameScore + 500 - at,
        });
        if (out.length > 400) break;
      }
      if (out.length > 400) break;
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 120);
  });

  const grouped = createMemo(() => {
    const map = new Map<string, Hit[]>();
    for (const hit of hits()) {
      const list = map.get(hit.path);
      if (list) list.push(hit);
      else map.set(hit.path, [hit]);
    }
    return [...map.entries()];
  });

  return (
    <div class="panel">
      <div class="panel__search">
        <div class="searchbox">
          <Icon name="search" size={13} class="searchbox__icon" />
          <input
            class="searchbox__input"
            placeholder="Search in files"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button
            class="searchbox__toggle"
            classList={{ 'searchbox__toggle--on': caseSensitive() }}
            onClick={() => setCaseSensitive(!caseSensitive())}
            title="Match case"
          >
            Aa
          </button>
        </div>
      </div>

      <div class="scroll panel__body">
        <Show
          when={query().trim().length >= 2}
          fallback={
            <div class="panel__empty">
              <Icon name="search" size={22} />
              <p>Type at least two characters</p>
              <span>Searches names and file contents</span>
            </div>
          }
        >
          <Show
            when={grouped().length > 0}
            fallback={
              <div class="panel__empty">
                <Icon name="inbox" size={22} />
                <p>No results for “{query()}”</p>
              </div>
            }
          >
            <div class="results__meta">{hits().length} results in {grouped().length} files</div>
            <For each={grouped()}>
              {([path, list]) => (
                <div class="result">
                  <button class="result__head" onClick={() => props.ws.openFile(path)}>
                    <FileGlyph path={path} size={13} />
                    <span class="truncate">{path.split('/').pop()}</span>
                    <span class="result__dir truncate">{path}</span>
                    <span class="result__count">{list.length}</span>
                  </button>
                  <For each={list.slice(0, 6)}>
                    {(hit) => (
                      <button class="result__line" onClick={() => props.ws.openFile(path)}>
                        <span class="result__no">{hit.line}</span>
                        <span class="truncate">{hit.text}</span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
