import { For } from 'solid-js';

import { Icon } from '../Icon';
import { railView, setRailView, setAgentCollapsed, agentCollapsed } from '../../store/ui';

const TOP = [
  { id: 'files', icon: 'listTree', label: 'Explorer', hint: '⌘1' },
  { id: 'search', icon: 'search', label: 'Search', hint: '⌘2' },
  { id: 'changes', icon: 'diff', label: 'Changes', hint: '⌘3' },
] as const;

export function Rail() {
  return (
    <nav class="rail">
      <div class="rail__group">
        <For each={TOP}>
          {(item) => (
            <button
              class="rail__btn"
              classList={{ 'rail__btn--on': railView() === item.id }}
              onClick={() => setRailView(item.id)}
              title={`${item.label}  ${item.hint}`}
            >
              <span class="rail__indicator" />
              <Icon name={item.icon} size={17} />
              <span class="rail__label">{item.label}</span>
            </button>
          )}
        </For>
      </div>

      <div class="rail__group rail__group--bottom">
        <button
          class="rail__btn"
          classList={{ 'rail__btn--on': !agentCollapsed() }}
          onClick={() => setAgentCollapsed(!agentCollapsed())}
          title="Agent workspace"
        >
          <span class="rail__indicator" />
          <Icon name="sparkles" size={17} />
          <span class="rail__label">Agent</span>
        </button>
        <button class="rail__btn" title="Settings">
          <span class="rail__indicator" />
          <Icon name="sliders" size={17} />
          <span class="rail__label">Settings</span>
        </button>
      </div>
    </nav>
  );
}
