import { Show } from 'solid-js';

import { Icon } from './Icon';

/** Place beside the search input, inside its positioned container. */
export function SearchClear(props: { value: string; onClear: () => void }) {
  return (
    <Show when={props.value.length > 0}>
      <button
        type="button"
        class="search-clear"
        aria-label="Clear search"
        data-tooltip="Clear search"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          const input = event.currentTarget.parentElement?.querySelector('input');
          props.onClear();
          input?.focus();
        }}
      >
        <Icon name="x" size={12} />
      </button>
    </Show>
  );
}
