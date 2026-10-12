import { createEffect, createResource, on, onCleanup, Show } from 'solid-js';

import { Icon } from '../Icon';
import { copyText, openMenu, setSettingsOpen, settingsOpen, toast } from '../../store/ui';
import { agentApi, onLlmConfigChange } from '../../lib/agent';
import type { Agent } from '../../store/agent';
import type { Workspace } from '../../store/workspace';
import { AgentThread } from './AgentThread';
import { Composer } from './Composer';

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function AgentPanel(props: { agent: Agent; ws: Workspace }) {
  const [config, { refetch }] = createResource(async () => {
    try {
      return await agentApi.getConfig();
    } catch {
      return { configs: [] };
    }
  });

  // The config can change in two ways while this panel sits mounted: a save
  // from Settings, or a hand edit of `llm.json` on disk. Closing the dialog
  // covers the first even when the file watcher fails; the watcher covers the
  // second even when the dialog was never opened.
  createEffect(
    on(
      settingsOpen,
      (open, wasOpen) => {
        if (wasOpen && !open) refetch();
      },
      { defer: true },
    ),
  );
  onCleanup(onLlmConfigChange(() => refetch()));

  const usage = () => props.agent.usage();
  const total = () => usage().input + usage().output;
  const pct = () => Math.min(100, (total() / 200_000) * 100);

  /** The entry the agent would call next, if any. */
  const active = () => config()?.configs.find((c) => c.active);

  return (
    <aside class="agent">
      <header class="agent__head">
        <div class="agent__title">
          <span class="agent__glyph">
            <Icon name="sparkles" size={13} />
          </span>
          <h2>Agent</h2>
          <span class="chip agent__sess">{props.agent.session().id}</span>
        </div>
        <div class="agent__actions">
          <button
            class="icon-btn"
            title="New session"
            onClick={() => {
              props.agent.clear();
              toast('info', 'Session cleared', 'the next prompt starts a fresh transcript');
            }}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            class="icon-btn"
            title="Session options"
            onClick={(e) => {
              // Re-read on the way in: a model may have been added or removed
              // since the panel last looked.
              refetch();
              openMenu(
                e.clientX,
                e.clientY,
                [
                  { label: 'Export transcript (jsonl)', run: () => toast('info', 'Export queued', 'researchgo.session.jsonl') },
                  { label: 'Copy session id', run: () => void copyText(props.agent.session().id, 'Session id copied') },
                  { separator: true, label: '' },
                  { label: 'Settings…', run: () => setSettingsOpen(true) },
                  { label: 'Clear thread', danger: true, run: () => props.agent.clear() },
                ],
              );
            }}
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </header>

      <div class="agent__meta">
        {/* Not a menu. Switching models is a configuration change, and it lives
            in Settings behind the overflow above — next to the thing it
            changes, instead of duplicated as a shortcut here that would drift
            from the list it mirrors. */}
        <div class="modelbtn" classList={{ 'modelbtn--unset': !active() }}>
          <Icon name="cpu" size={12} />
          <span class="truncate">{active()?.model ?? 'no model'}</span>
        </div>
      </div>

      <div class="agent__usage">
        <div class="agent__usagebar">
          <span style={{ width: `${pct()}%` }} />
        </div>
        <div class="agent__usagetext">
          <span>{compact(total())} ctx</span>
          <span>{compact(usage().output)} out</span>
          <Show when={props.agent.busy()}>
            <span class="agent__spin">
              <span class="spinner" />
              {props.agent.elapsed() || 0}ms
            </span>
          </Show>
        </div>
      </div>

      <AgentThread agent={props.agent} ws={props.ws} />

      <Composer agent={props.agent} ws={props.ws} />
    </aside>
  );
}
