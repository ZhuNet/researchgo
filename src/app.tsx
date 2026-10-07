import { onCleanup, onMount, Show } from 'solid-js';

import { AgentPanel } from './components/Agent/AgentPanel';
import { CommandPalette } from './components/CommandPalette';
import { ContextMenu } from './components/ContextMenu';
import { Explorer } from './components/Explorer/Explorer';
import { Rail } from './components/Explorer/Rail';
import { Splitter } from './components/Splitter';
import { Stage } from './components/Stage/Stage';
import { Titlebar } from './components/Titlebar';
import { Toaster } from './components/Toaster';
import { warm } from './lib/highlight';
import { createAgent } from './store/agent';
import { createWorkspace } from './store/workspace';
import {
  agentCollapsed,
  agentW,
  applyStoredTheme,
  explorerW,
  setAgentCollapsed,
  setAgentW,
  setExplorerW,
  setPaletteOpen,
  setRailView,
  setTheme,
  theme,
} from './store/ui';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function App() {
  const ws = createWorkspace();
  const agent = createAgent();

  onMount(() => {
    applyStoredTheme();
    warm();

    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (key === 'p') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (key === 'b') {
        e.preventDefault();
        setExplorerW(explorerW() > 120 ? 0 : 268);
      } else if (key === 'i') {
        e.preventDefault();
        setAgentCollapsed(!agentCollapsed());
      } else if (key === 'l' && e.shiftKey) {
        e.preventDefault();
        setTheme(theme() === 'dark' ? 'light' : 'dark');
      } else if (key === '1' || key === '2' || key === '3') {
        e.preventDefault();
        setRailView(key === '1' ? 'files' : key === '2' ? 'search' : 'changes');
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <div class="app">
      <div class="app__glow" />

      <Titlebar ws={ws} agent={agent} />

      <div class="app__body">
        <Rail />

        <Show when={explorerW() > 60}>
          <div class="app__explorer" style={{ width: `${explorerW()}px` }}>
            <Explorer ws={ws} />
          </div>
          <Splitter
            side="left"
            onDrag={(d) => setExplorerW(clamp(explorerW() + d, 0, 560))}
            onDone={() => explorerW() < 160 && setExplorerW(0)}
          />
        </Show>

        <main class="app__stage">
          <Stage ws={ws} />
        </main>

        <Show when={!agentCollapsed()}>
          <Splitter
            side="right"
            onDrag={(d) => setAgentW(clamp(agentW() + d, 320, 760))}
          />
          <div class="app__agent" style={{ width: `${agentW()}px` }}>
            <AgentPanel ws={ws} agent={agent} />
          </div>
        </Show>
      </div>

      <ContextMenu />
      <CommandPalette ws={ws} agent={agent} />
      <Toaster />
    </div>
  );
}
