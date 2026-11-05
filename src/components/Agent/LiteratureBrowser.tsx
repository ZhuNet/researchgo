import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Icon } from '../Icon';

/** The native child follows this slot; it is never a separate browser window. */
export function LiteratureBrowser(props: { browser: { label: string; downloading: boolean } }) {
  let slot!: HTMLDivElement;
  const [closing, setClosing] = createSignal(false);
  const [error, setError] = createSignal('');
  const invoke = (globalThis as { __TAURI__?: { core: { invoke: (command: string, args: unknown) => Promise<unknown> } } }).__TAURI__?.core.invoke;
  const close = async () => {
    if (!invoke || closing()) return;
    setClosing(true);
    setError('');
    try { await invoke('close_browser', { label: props.browser.label }); }
    catch { setClosing(false); setError('关闭失败，请重试'); }
  };
  onMount(() => {
    const label = props.browser.label;
    let frame = 0;
    let disposed = false;
    let previous = '';
    let syncing = false;
    const hidden = () => closing() || props.browser.downloading;
    const sync = async () => {
      if (disposed || syncing) return;
      syncing = true;
      if (hidden()) {
        if (previous !== 'null' && invoke) {
          try {
            await invoke('position_browser', { label, bounds: null });
            previous = 'null';
          } catch { /* The browser may already have been closed. */ }
        }
        syncing = false;
        if (!disposed && !hidden()) frame = requestAnimationFrame(() => { void sync(); });
        return;
      }
      const rect = slot.getBoundingClientRect();
      let visible = !closing() && !props.browser.downloading && rect.width > 0 && rect.height > 0;
      let top = 0, left = 0, right = innerWidth, bottom = innerHeight;
      for (let parent = slot.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clip = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
      }
      // Native children cannot inherit DOM clipping. Hide when the slot is clipped
      // rather than paint over adjacent messages or the composer.
      visible &&= rect.top >= top && rect.bottom <= bottom && rect.left >= left && rect.right <= right;
      if (visible) {
        visible = [[rect.left + 2, rect.top + 2], [rect.right - 2, rect.bottom - 2]].every(([x, y]) => slot.contains(document.elementFromPoint(x, y)));
      }
      const bounds = visible ? [rect.x, rect.y, rect.width, rect.height] : null;
      const key = JSON.stringify(bounds);
      if (key !== previous && invoke) {
        try {
          await invoke('position_browser', { label, bounds });
          previous = key;
        } catch { /* The download may finish while a layout update is in flight. */ }
      }
      syncing = false;
      if (!disposed) frame = requestAnimationFrame(() => { void sync(); });
    };
    createEffect(() => {
      hidden();
      cancelAnimationFrame(frame);
      void sync();
    });
    onCleanup(() => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (invoke) void invoke('position_browser', { label, bounds: null }).catch(() => {});
    });
  });
  return <div class="literature-browser">
    <div class="literature-browser__head">
      <Icon name={props.browser.downloading ? 'book' : 'globe'} size={13} />
      <span>{closing() ? '正在关闭…' : props.browser.downloading ? '正在下载文献' : '文献网页'}</span>
      <button class="literature-browser__close" aria-label="关闭当前文献网页" title="关闭当前文献网页" disabled={closing()} onClick={() => { void close(); }}><Icon name="x" size={14} /></button>
    </div>
    <div ref={slot} class="literature-browser__body" classList={{ 'literature-browser__body--downloading': props.browser.downloading }}>
      <Show when={props.browser.downloading} fallback={<span class="literature-browser__placeholder">文献网页</span>}>
        <div class="literature-browser__progress" role="progressbar" aria-label="正在下载文献">
          <span class="literature-browser__progress-beam" />
        </div>
        <span class="literature-browser__hint">文件下载中，完成后自动保存</span>
      </Show>
    </div>
    <Show when={error()}><span role="alert" class="literature-browser__hint">{error()}</span></Show>
  </div>;
}
