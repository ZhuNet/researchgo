import { createEffect, createResource, on, onCleanup, Show } from 'solid-js';

import { Icon } from '../Icon';
import { openMenu, setSettingsOpen, settingsOpen, toast } from '../../store/ui';
import { agentApi, onLlmConfigChange } from '../../lib/agent';
import type { Agent } from '../../store/agent';
import { CONTEXT_WINDOW } from '../../store/agent';
import type { Workspace } from '../../store/workspace';
import { AgentThread, secs } from './AgentThread';
import { Composer } from './Composer';
import { ModelMenu } from './ModelMenu';

/**
 * A token count at the resolution the panel prints: tenths of a thousand below
 * a million, whole tokens below that, where a tenth of a thousand would be a
 * rounding of a number too small to have one.
 */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * The context meter's ceiling, in the form the bar names it.
 *
 * Written out rather than run through `compact`, which would print `1.0M` for a
 * window that is exactly a million.
 */
const SCALE = `/${CONTEXT_WINDOW / 1_000_000}M`;

/**
 * The bar's percentage at a resolution that survives the low end.
 *
 * A whole number under a tenth of the ceiling is mostly `0`: a turn that has
 * just started would report no progress at all and look broken. So a value
 * below ten keeps its decimal and anything larger rounds to something that
 * reads at 10px.
 */
const percent = (p: number) => (p > 0 && p < 10 ? p.toFixed(1) : `${Math.round(p)}`);

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

  const total = () => props.agent.context();
  const pct = () => Math.min(100, (total() / CONTEXT_WINDOW) * 100);

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
            title="Agent options"
            onClick={(e) => {
              // Re-read on the way in: a model may have been added or removed
              // since the panel last looked.
              refetch();
              openMenu(
                e.clientX,
                e.clientY,
                [
                  // Placeholders for now: the log is on disk either way, but
                  // neither of these moves a byte yet.
                  {
                    label: 'Import transcript',
                    run: () => toast('info', 'Import', 'a jsonl file back into the log'),
                  },
                  {
                    label: 'Export transcript (jsonl)',
                    run: () => toast('info', 'Export', 'the interaction log as one jsonl file'),
                  },
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
          <span>{compact(total())} ({percent(pct())}%)</span>
          <span class="agent__meterend">
            <Show when={props.agent.busy()}>
              <span class="agent__spin">
                <span class="spinner" />
                {secs(props.agent.elapsed())}
              </span>
            </Show>
            <span class="agent__scale">{SCALE}</span>
          </span>
        </div>
      </div>

      <AgentThread agent={props.agent} ws={props.ws} />

      <Composer agent={props.agent} ws={props.ws} />
    </aside>
  );
}
