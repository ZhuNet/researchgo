import { For, Show } from 'solid-js';

import { Icon } from './Icon';
import { dismissToast, toasts } from '../store/ui';

export function Toaster() {
  return (
    <div class="toaster">
      <For each={toasts()}>
        {(toast) => (
          <div
            class="toast rise-in"
            classList={{ [`toast--${toast.kind}`]: true }}
            role="button"
            tabIndex={0}
            aria-label="Dismiss"
            data-tooltip="Dismiss"
            onClick={() => dismissToast(toast.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                dismissToast(toast.id);
              }
            }}
          >
            <span class="toast__icon">
              <Icon
                name={toast.kind === 'ok' ? 'check' : toast.kind === 'error' ? 'alert' : 'info'}
                size={13}
                stroke={2}
              />
            </span>
            <div class="toast__body">
              <span class="toast__title">{toast.title}</span>
              {/* No .truncate: an error you cannot read in full is not a
                  message, it is a rumour. Wrapping is handled in CSS. */}
              <Show when={toast.detail}>
                <span class="toast__detail">{toast.detail}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
