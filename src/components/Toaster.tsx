import { For, Show } from 'solid-js';

import { Icon } from './Icon';
import { toasts } from '../store/ui';

export function Toaster() {
  return (
    <div class="toaster">
      <For each={toasts()}>
        {(toast) => (
          <div class="toast rise-in" classList={{ [`toast--${toast.kind}`]: true }}>
            <span class="toast__icon">
              <Icon
                name={toast.kind === 'ok' ? 'check' : toast.kind === 'error' ? 'alert' : 'info'}
                size={13}
                stroke={2}
              />
            </span>
            <div class="toast__body">
              <span class="toast__title">{toast.title}</span>
              <Show when={toast.detail}>
                <span class="toast__detail truncate">{toast.detail}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
