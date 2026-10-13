import { createEffect, createResource, on, onCleanup, Show } from 'solid-js';

import { Icon } from '../Icon';
import { copyText, openMenu, setSettingsOpen, settingsOpen, toast } from '../../store/ui';
import { agentApi, onLlmConfigChange } from '../../lib/agent';
import type { Agent } from '../../store/agent';
import type { Workspace } from '../../store/workspace';
import { AgentThread } from './AgentThread';
import { Composer } from './Composer';
import { ModelMenu } from './ModelMenu';

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function AgentPanel(props: { agent: Agent; ws: Workspace }) {
  const [config, { mutate, refetch }] = createResource(async () => {
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

  /** Points the agent at one model of one entry, and lands the result here. */
  const switchModel = async (name: string, model: string) => {
    try {
      mutate(await agentApi.setActive(name, model));
    } catch (err) {
      toast('error', 'Could not switch', String(err));
    }
  };

  return (
    <aside class="agent">
      <header class="agent__head">
        <div class="agent__title">
          <span class="agent__glyph">
            <Icon name="sparkles" size={13} />
          </span>
          <h2>Agent</h2>
        </div>
        <div class="agent__actions">
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
                  {
                    label: 'Clear session',
                    danger: true,
                    run: () => {
                      props.agent.clear();
                      toast('info', 'Session cleared', 'the next prompt starts a fresh transcript');
                    },
                  },
                ],
              );
            }}
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </header>

      <div class="agent__meta">
        <ModelMenu
          configs={config()?.configs ?? []}
          onOpen={() => void refetch()}
          onPick={(name, model) => void switchModel(name, model)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
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
