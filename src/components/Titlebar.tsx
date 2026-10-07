import { Show } from 'solid-js';

import { Icon } from './Icon';
import {
  agentCollapsed,
  setAgentCollapsed,
  setPaletteOpen,
  setTheme,
  theme,
} from '../store/ui';
import { isDesktop, windowCtl } from '../lib/bridge';
import type { Workspace } from '../store/workspace';
import type { Agent } from '../store/agent';

const desktop = isDesktop();

export function Titlebar(props: { ws: Workspace; agent: Agent }) {
  const modes = [
    { id: 'code', label: 'Source', icon: 'code' },
    { id: 'pdf', label: 'Preview', icon: 'book' },
    { id: 'split', label: 'Split', icon: 'columns' },
  ] as const;

  return (
    <header class="titlebar drag" data-tauri-drag-region>
      <div class="titlebar__left no-drag">
        <div class="mark" title="ResearchGO">
          <svg viewBox="0 0 1024 1024" width="17" height="17" aria-hidden="true">
            <path
              d="M364 728V296h132a100 100 0 0 1 0 200H364"
              fill="none"
              stroke="currentColor"
              stroke-width="80"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M496 496L660 728"
              fill="none"
              stroke="currentColor"
              stroke-width="80"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>

        <span class="wsname">ResearchGO</span>

      </div>

      <div class="titlebar__center no-drag">
        <div class="segmented" role="tablist" aria-label="Stage mode">
          {modes.map((m) => (
            <button
              class="segmented__item"
              classList={{ 'segmented__item--on': props.ws.stageMode() === m.id }}
              onClick={() => props.ws.setStageMode(m.id)}
              title={`${m.label} view`}
            >
              <Icon name={m.icon} size={13} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <button class="omni" onClick={() => setPaletteOpen(true)} title="Search or run a command">
          <Icon name="search" size={13} />
          <span class="omni__text">Search files, run commands</span>
          <span class="kbd">⌘K</span>
        </button>
      </div>

      <div class="titlebar__right no-drag">
        <button
          class="icon-btn"
          classList={{ 'icon-btn--on': agentCollapsed() }}
          onClick={() => setAgentCollapsed(!agentCollapsed())}
          title="Toggle agent panel"
        >
          <Icon name="panelRight" size={15} />
        </button>

        <button
          class="icon-btn"
          onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')}
          title="Toggle theme"
        >
          <Show when={theme() === 'dark'} fallback={<Icon name="sun" size={15} />}>
            <Icon name="moon" size={15} />
          </Show>
        </button>

        <div class="winctl" classList={{ 'winctl--mock': !desktop }}>
          <button
            class="winctl__btn"
            onClick={() => windowCtl.minimize()}
            title={desktop ? 'Minimize' : 'Minimize (needs the desktop shell)'}
            disabled={!desktop}
          >
            <Icon name="minus" size={15} stroke={1.4} />
          </button>
          <button
            class="winctl__btn"
            onClick={() => windowCtl.toggleMaximize()}
            title={desktop ? 'Maximize' : 'Maximize (needs the desktop shell)'}
            disabled={!desktop}
          >
            <Icon name="maximize" size={13} stroke={1.4} />
          </button>
          <button
            class="winctl__btn winctl__btn--danger"
            onClick={() => windowCtl.close()}
            title={desktop ? 'Close' : 'Close (needs the desktop shell)'}
            disabled={!desktop}
          >
            <Icon name="x" size={14} stroke={1.5} />
          </button>
        </div>
      </div>
    </header>
  );
}
