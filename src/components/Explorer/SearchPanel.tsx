import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';

import { FileGlyph, Icon } from '../Icon';
import { fuzzyScore } from '../../lib/tree';
import type { Workspace } from '../../store/workspace';

interface Hit {
  path: string;
  line: number;
  text: string;
  score: number;
}

/** Typing cadence: a keystroke every 100ms should not launch a search each time. */
const DEBOUNCE_MS = 180;

export function SearchPanel(props: { ws: Workspace }) {
  const [query, setQuery] = createSignal('');
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  const [hits, setHits] = createSignal<Hit[]>([]);
  const [searching, setSearching] = createSignal(false);
  let seq = 0;
  let timer: number | undefined;
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  /**
   * The search runs on the host over the whole workspace. The old version
   * only saw files already open as tabs, so it answered "no results" for
   * anything the reader had not happened to open. Bounds live on the Rust
   * side; here the concerns are cadence (debounce) and staleness (a newer
   * query's answer wins even when an older one lands late).
   */
  createEffect(() => {
    const q = query().trim();
    const cs = caseSensitive();
    const root = props.ws.root();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (q.length < 2 || !root) {
      seq++;
      setSearching(false);
      setHits([]);
      return;
    }
    const mine = ++seq;
    setSearching(true);
    timer = setTimeout(() => {
      timer = undefined;
      void props.ws.backend
        .searchWorkspace(root, q, cs)
        .then((found) => {
          if (mine !== seq) return;
          const needle = cs ? q : q.toLowerCase();
          const ranked = found
            .map((hit) => {
              const name = hit.path.slice(hit.path.lastIndexOf('/') + 1);
              const hay = cs ? hit.text : hit.text.toLowerCase();
              return {
                ...hit,
                score:
                  fuzzyScore(needle, name.toLowerCase()) +
                  500 -
                  Math.max(hay.indexOf(needle), 0),
              };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 120);
          setHits(ranked);
          setSearching(false);
        })
        .catch(() => {
          if (mine !== seq) return;
          setHits([]);
          setSearching(false);
        });
    }, DEBOUNCE_MS);
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
                <span>Searches file contents across the workspace</span>
              </div>
            }
          >
          <Show
            when={grouped().length > 0}
            fallback={
              <div class="panel__empty">
                <Icon name="inbox" size={22} />
                <p>{searching() ? 'Searching…' : `No results for “${query()}”`}</p>
              </div>
            }
          >
            <div class="results__meta">
              {searching()
                ? 'searching…'
                : `${hits().length} results in ${grouped().length} files`}
            </div>
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
