import { createSignal, onCleanup, onMount, Show } from 'solid-js';

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
  const [maximized, setMaximized] = createSignal(false);
  onMount(() => {
    if (!desktop) return;
    let disposed = false;
    const updateIcon = async () => {
      try {
        const value = await windowCtl.isMaximized();
        if (!disposed) setMaximized(value ?? false);
      } catch (error) {
        console.error('Cannot read maximized state', error);
      }
    };
    void updateIcon();
    window.addEventListener('resize', updateIcon);
    onCleanup(() => {
      disposed = true;
      window.removeEventListener('resize', updateIcon);
    });
  });

  let pending: PointerEvent | null = null;
  let capture: { element: HTMLElement; id: number } | null = null;
  let frame: number | undefined;
  let drag: {
    pointerX: number;
    pointerY: number;
    windowX: number;
    windowY: number;
    targetX: number;
    targetY: number;
    applying: boolean;
    released: boolean;
    scale: number;
  } | null = null;

  const stopTracking = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    pending = null;
    drag = null;
    window.removeEventListener('pointermove', trackDrag);
    window.removeEventListener('pointerup', finishDrag);
    window.removeEventListener('pointercancel', stopTracking);
    window.removeEventListener('blur', stopTracking);
    const held = capture;
    capture = null;
    if (held) {
      held.element.removeEventListener('lostpointercapture', stopTracking);
      if (held.element.hasPointerCapture(held.id)) held.element.releasePointerCapture(held.id);
    }
  };

  const moveWindow = async () => {
    const current = drag;
    if (!current || current.applying) return;
    current.applying = true;
    try {
      while (drag === current || current.released) {
        const x = current.targetX;
        const y = current.targetY;
        await windowCtl.setPosition({ type: 'Physical', x, y });
        if (x === current.targetX && y === current.targetY) break;
      }
    } catch (error) {
      if (drag === current) stopTracking();
      console.error('Window drag failed', error);
    } finally {
      current.applying = false;
    }
  };

  const finishDrag = (event: PointerEvent) => {
    if (drag && event.isPrimary) {
      drag.targetX = Math.round(drag.windowX + (event.screenX - drag.pointerX) * drag.scale);
      drag.targetY = Math.round(drag.windowY + (event.screenY - drag.pointerY) * drag.scale);
      // An in-flight update also delivers the final target after release.
      drag.released = true;
      void moveWindow();
    }
    stopTracking();
  };

  const trackDrag = (event: PointerEvent) => {
    if (!drag || !event.isPrimary || (event.buttons & 1) === 0) {
      stopTracking();
      return;
    }
    drag.targetX = Math.round(drag.windowX + (event.screenX - drag.pointerX) * drag.scale);
    drag.targetY = Math.round(drag.windowY + (event.screenY - drag.pointerY) * drag.scale);
    if (frame === undefined) {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        void moveWindow();
      });
    }
  };

  const beginDrag = async (event: PointerEvent) => {
    if (!desktop || event.button !== 0 || !event.isPrimary) return;
    const target = event.target as Element | null;
    if (target?.closest("button, input, textarea, select, a, [role='button']")) return;
    stopTracking();
    pending = event;
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(event.pointerId);
    capture = { element, id: event.pointerId };
    element.addEventListener('lostpointercapture', stopTracking);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', stopTracking);
    window.addEventListener('blur', stopTracking);
    let origin;
    try {
      origin = await windowCtl.outerPosition();
    } catch (error) {
      if (pending === event) stopTracking();
      console.error('Cannot read window position', error);
      return;
    }
    if (pending !== event) return;
    if (!origin) {
      stopTracking();
      return;
    }
    pending = null;
    const scale = window.devicePixelRatio || 1;
    drag = {
      pointerX: event.screenX,
      pointerY: event.screenY,
      windowX: origin.x,
      windowY: origin.y,
      targetX: origin.x,
      targetY: origin.y,
      applying: false,
      released: false,
      scale,
    };
    window.addEventListener('pointermove', trackDrag);
  };

  onCleanup(stopTracking);

  const modes = [
    { id: 'code', label: 'Source', icon: 'code' },
    { id: 'pdf', label: 'Preview', icon: 'book' },
    { id: 'split', label: 'Split', icon: 'columns' },
  ] as const;

  return (
    <header
      class="titlebar"
      onPointerDown={beginDrag}
      onDblClick={(event) => {
        const target = event.target as Element | null;
        if (desktop && !target?.closest("button, input, textarea, select, a, [role='button']")) {
          windowCtl.toggleMaximize();
        }
      }}
    >
      <div class="titlebar__left">
        <div class="mark" data-tooltip="ResearchGO">
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

      <div class="titlebar__center">
        <div class="segmented" role="tablist" aria-label="Stage mode">
          {modes.map((m) => (
            <button
              class="segmented__item"
              classList={{ 'segmented__item--on': props.ws.stageMode() === m.id }}
              onClick={() => props.ws.setStageMode(m.id)}
              aria-label={`${m.label} view`}
              data-tooltip={`${m.label} view`}
            >
              <Icon name={m.icon} size={13} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        <button class="omni" onClick={() => setPaletteOpen(true)} aria-label="Search or run a command" data-tooltip="Search or run a command">
          <Icon name="search" size={13} />
          <span class="omni__text">Search files, run commands</span>
          <span class="kbd">⌘K</span>
        </button>
      </div>

      <div class="titlebar__right">
        <button
          class="icon-btn"
          classList={{ 'icon-btn--on': agentCollapsed() }}
          onClick={() => setAgentCollapsed(!agentCollapsed())}
          aria-label="Toggle agent panel"
          data-tooltip="Toggle agent panel"
        >
          <Icon name="panelRight" size={15} />
        </button>

        <button
          class="icon-btn"
          onClick={() => setTheme(theme() === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
          data-tooltip="Toggle theme"
        >
          <Show when={theme() === 'dark'} fallback={<Icon name="sun" size={15} />}>
            <Icon name="moon" size={15} />
          </Show>
        </button>

        <div class="winctl" classList={{ 'winctl--mock': !desktop }}>
          <button
            class="winctl__btn"
            onClick={() => windowCtl.minimize()}
            aria-label="Minimize"
            data-tooltip={desktop ? 'Minimize' : 'Minimize (needs the desktop shell)'}
            disabled={!desktop}
          >
            <Icon name="minus" size={15} stroke={1.4} />
          </button>
          <button
            class="winctl__btn"
            onClick={() => windowCtl.toggleMaximize()}
            aria-label="Maximize"
            data-tooltip={desktop ? 'Maximize' : 'Maximize (needs the desktop shell)'}
            disabled={!desktop}
          >
            <Icon name={maximized() ? 'restore' : 'maximize'} size={13} stroke={1.4} />
          </button>
          <button
            class="winctl__btn winctl__btn--danger"
            onClick={() => windowCtl.close()}
            aria-label="Close"
            data-tooltip={desktop ? 'Close' : 'Close (needs the desktop shell)'}
            disabled={!desktop}
          >
            <Icon name="x" size={14} stroke={1.5} />
          </button>
        </div>
      </div>
    </header>
  );
}
