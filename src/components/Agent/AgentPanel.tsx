import { createSignal, Show } from 'solid-js';

import { Icon } from '../Icon';
import { copyText, openMenu, toast } from '../../store/ui';
import type { Agent } from '../../store/agent';
import type { Workspace } from '../../store/workspace';
import { AgentThread } from './AgentThread';
import { Composer } from './Composer';

const MODELS = [
  'claude-sonnet-4.6',
  'claude-opus-4.1',
  'gpt-5.1-codex',
  'qwen3-coder-30b',
];

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function AgentPanel(props: { agent: Agent; ws: Workspace }) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const usage = () => props.agent.usage();
  const total = () => usage().input + usage().output;
  const pct = () => Math.min(100, (total() / 200_000) * 100);

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
            onClick={() => toast('ok', 'Session started', 'sidecar spawned omp-sidecar')}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            class="icon-btn"
            title="Session options"
            onClick={(e) =>
              openMenu(
                e.clientX,
                e.clientY,
                [
                  { label: 'Export transcript (jsonl)', run: () => toast('info', 'Export queued', 'researchgo.session.jsonl') },
                  { label: 'Copy session id', run: () => void copyText(props.agent.session().id, 'Session id copied') },
                  { separator: true, label: '' },
                  { label: 'Clear thread', danger: true, run: () => props.agent.clear() },
                ],
              )
            }
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </header>

      <div class="agent__meta">
        <button
          class="modelbtn"
          onClick={(e) => {
            setMenuOpen(!menuOpen());
            if (!menuOpen()) return;
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(
              rect.left,
              rect.bottom + 6,
              MODELS.map((m) => ({
                label: m,
                hint: m === props.agent.session().model ? '✓' : undefined,
                run: () => {
                  props.agent.session().model = m;
                  toast('ok', 'Model switched', m);
                },
              })),
            );
          }}
        >
          <Icon name="cpu" size={12} />
          <span class="truncate">{props.agent.session().model}</span>
          <Icon name="chevronDown" size={12} />
        </button>
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

      <Composer agent={props.agent} />
    </aside>
  );
}
