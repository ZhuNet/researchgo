import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';

/** Shared tooltip layer, outside scroll containers so long paths stay readable. */
export function Tooltip() {
  const [text, setText] = createSignal('');
  const [position, setPosition] = createSignal({ left: 0, top: 0 });
  let bubble: HTMLDivElement | undefined;
  let anchor: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousDescription: string | null = null;

  const hide = () => {
    clearTimeout(timer);
    observe.disconnect();
    if (anchor && previousDescription !== null) {
      anchor.setAttribute('aria-describedby', previousDescription);
    } else {
      anchor?.removeAttribute('aria-describedby');
    }
    anchor = null;
    previousDescription = null;
    setText('');
  };

  const observe = new MutationObserver(() => {
    if (anchor && text()) setText(anchor.dataset.tooltip ?? '');
  });

  const show = (target: EventTarget | null, immediate = false) => {
    const next = target instanceof Element
      ? target.closest<HTMLElement>('[data-tooltip]')
      : null;
    if (next === anchor) return;
    hide();
    if (!next?.dataset.tooltip) return;
    anchor = next;
    previousDescription = next.getAttribute('aria-describedby');
    observe.observe(next, { attributes: true, attributeFilter: ['data-tooltip'] });
    timer = setTimeout(() => {
      if (!next.isConnected || !next.dataset.tooltip) return;
      next.setAttribute('aria-describedby', [previousDescription, 'app-tooltip'].filter(Boolean).join(' '));
      setText(next.dataset.tooltip);
    }, immediate ? 0 : 500);
  };

  createEffect(() => {
    if (!text() || !bubble || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = bubble.getBoundingClientRect();
    const below = rect.bottom + 8;
    setPosition({
      left: Math.max(8, Math.min(rect.left + (rect.width - width) / 2, window.innerWidth - width - 8)),
      top: Math.max(8, below + height <= window.innerHeight - 8 ? below : rect.top - height - 8),
    });
  });

  onMount(() => {
    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') show(event.target);
    };
    const onOut = (event: PointerEvent) => show(event.relatedTarget);
    const onFocus = (event: FocusEvent) => show(event.target, true);
    const onBlur = (event: FocusEvent) => show(event.relatedTarget, true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    onCleanup(() => {
      hide();
      observe.disconnect();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    });
  });

  return (
    <Portal>
      <Show when={text()}>
        <div
          ref={bubble}
          id="app-tooltip"
          role="tooltip"
          class="tooltip"
          style={{ left: `${position().left}px`, top: `${position().top}px` }}
        >
          {text()}
        </div>
      </Show>
    </Portal>
  );
}
