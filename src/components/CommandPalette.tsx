import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';

import { Icon, LANG_COLOR } from './Icon';
import { fileIconLang } from '../lib/fs';
import { fuzzyScore } from '../lib/tree';
import {
  agentCollapsed,
  paletteOpen,
  paletteQuery,
  setAgentCollapsed,
  setExplorerW,
  setPaletteOpen,
  setPaletteQuery,
  setRailView,
  setTheme,
  setTreeCmd,
  theme,
  toast,
} from '../store/ui';
import type { Workspace } from '../store/workspace';
import type { Agent } from '../store/agent';

interface Entry {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: string;
  color?: string;
  run: () => void;
}

export function CommandPalette(props: { ws: Workspace; agent: Agent }) {
  const [active, setActive] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;

  const commands = createMemo<Entry[]>(() => {
    const ws = props.ws;
    return [
      { id: 'c1', group: 'View', label: 'Toggle theme', hint: '⌘⇧L', icon: theme() === 'dark' ? 'sun' : 'moon', run: () => setTheme(theme() === 'dark' ? 'light' : 'dark') },
      { id: 'c2', group: 'View', label: 'Focus explorer', hint: '⌘1', icon: 'panelLeft', run: () => { setRailView('files'); setExplorerW(300); } },
      { id: 'c3', group: 'View', label: 'Search in files', hint: '⌘2', icon: 'search', run: () => setRailView('search') },
      { id: 'c4', group: 'View', label: 'Source view', icon: 'code', run: () => ws.setStageMode('code') },
      { id: 'c5', group: 'View', label: 'PDF preview', icon: 'book', run: () => ws.setStageMode('pdf') },
      { id: 'c6', group: 'View', label: 'Split view', icon: 'columns', run: () => ws.setStageMode('split') },
      { id: 'c7', group: 'View', label: 'Toggle agent panel', hint: '⌘I', icon: 'panelRight', run: () => setAgentCollapsed(!agentCollapsed()) },
      { id: 'c8', group: 'Folder', label: 'Open Folder…', icon: 'folder', run: () => void ws.pickFolder().then((ok) => { if (ok) toast('ok', 'Folder opened', ws.rootName()); }) },
      { id: 'c8b', group: 'Folder', label: 'New file…', hint: '⌘N', icon: 'file', run: () => ws.root() && ws.setCreating({ dir: ws.root()!, kind: 'file' }) },
      { id: 'c9', group: 'Folder', label: 'New folder…', icon: 'folder', run: () => ws.root() && ws.setCreating({ dir: ws.root()!, kind: 'dir' }) },
      { id: 'c9b', group: 'Folder', label: 'Close folder', icon: 'trash', run: () => ws.closeFolder() },
      { id: 'c10', group: 'Tree', label: 'Expand all', icon: 'chevronDown', run: () => setTreeCmd({ kind: 'expand-all' }) },
      { id: 'c11', group: 'Tree', label: 'Collapse all', icon: 'chevronUpDown', run: () => setTreeCmd({ kind: 'collapse-all' }) },
      { id: 'c16', group: 'View', label: 'Show cache stats', icon: 'sliders', run: () => { const s2 = ws.stats(); toast('info', 'Tree cache', `${s2.dirs}/${s2.maxDirs} dirs · ${s2.entries.toLocaleString()}/${s2.maxEntries.toLocaleString()} entries`); } },
      { id: 'c14', group: 'Agent', label: 'Clear agent thread', icon: 'trash', run: () => props.agent.clear() },
      { id: 'c15', group: 'Agent', label: 'Ask: why is the tree slow?', icon: 'sparkles', run: () => props.agent.send('Why does the tree slow down past 50k nodes?') },
    ];
  });

  const files = createMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const base = props.ws.root();
    if (!base) return out;
    const dirs: string[] = [base];
    const seen = new Set<string>();
    while (dirs.length) {
      const dir = dirs.shift() as string;
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const entry of props.ws.entriesOf(dir)) {
        if (entry.kind === 'dir') {
          if (props.ws.expanded().has(entry.path)) dirs.push(entry.path);
          continue;
        }
        out.push({
          id: entry.path,
          group: 'Files',
          label: entry.name,
          hint: dir,
          icon: fileIconLang(entry.path),
          color: LANG_COLOR[fileIconLang(entry.path)],
          run: () => void props.ws.openFile(entry.path),
        });
      }
      if (out.length > 5000) break;
    }
    return out;
  });

  const results = createMemo(() => {
    const q = paletteQuery().trim();
    const pool = [...commands(), ...files()];
    if (!q) return pool.slice(0, 40);
    return pool
      .map((e) => ({ e, s: Math.max(fuzzyScore(q, e.label), fuzzyScore(q, e.hint ?? '') - 60) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.e);
  });

  const grouped = createMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of results()) {
      const list = map.get(e.group);
      if (list) list.push(e);
      else map.set(e.group, [e]);
    }
    return [...map.entries()];
  });

  let flat: Entry[] = [];
  createEffect(() => {
    const r = results();
    flat = r;
    setActive(0);
  });

  createEffect(() => {
    if (paletteOpen()) {
      setPaletteQuery('');
      queueMicrotask(() => input?.focus());
    }
  });

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    setPaletteOpen(false);
    entry.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!paletteOpen()) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPaletteOpen(false);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setPaletteOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(flat.length, 1));
      scrollActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + flat.length) % Math.max(flat.length, 1));
      scrollActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(flat[active()]);
    }
  };

  const scrollActive = () => {
    const el = list?.querySelector<HTMLElement>('.cmd--on');
    el?.scrollIntoView({ block: 'nearest' });
  };

  window.addEventListener('keydown', onKey, true);
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  return (
    <Show when={paletteOpen()}>
      <div class="palette-backdrop fade-in" onPointerDown={() => setPaletteOpen(false)}>
        <div class="palette rise-in" onPointerDown={(e) => e.stopPropagation()}>
          <div class="palette__input">
            <Icon name="search" size={15} class="palette__icon" />
            <input
              ref={input}
              class="palette__field"
              placeholder="Search files or run a command…"
              value={paletteQuery()}
              onInput={(e) => setPaletteQuery(e.currentTarget.value)}
            />
            <span class="kbd">esc</span>
          </div>
          <div class="palette__list scroll" ref={list}>
            <For each={grouped()}>
              {([group, entries]) => (
                <div class="palette__group">
                  <div class="palette__grouplabel">{group}</div>
                  <For each={entries}>
                    {(entry) => (
                      <button
                        class="cmd"
                        classList={{ 'cmd--on': flat[active()] === entry }}
                        onPointerEnter={() => setActive(flat.indexOf(entry))}
                        onClick={() => run(entry)}
                      >
                        <span class="cmd__icon" style={{ color: entry.color ?? 'var(--tx-3)' }}>
                          <Icon name={entry.icon} size={14} />
                        </span>
                        <span class="cmd__label truncate">{entry.label}</span>
                        <Show when={entry.hint}>
                          <span class="cmd__hint truncate">{entry.hint}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
            <Show when={results().length === 0}>
              <div class="palette__empty">Nothing matches “{paletteQuery()}”</div>
            </Show>
          </div>
          <div class="palette__foot">
            <span>
              <span class="kbd">↑</span>
              <span class="kbd">↓</span> navigate
            </span>
            <span>
              <span class="kbd">⏎</span> open
            </span>
            <span class="palette__foot-right">{flat.length} results</span>
          </div>
        </div>
      </div>
    </Show>
  );
}
