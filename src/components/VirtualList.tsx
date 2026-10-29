import { createSignal, For, onCleanup, onMount } from 'solid-js';

/** Fixed-row virtual window. The input array remains complete; only visible rows mount. */
export function VirtualList<T>(props: {
  items: T[];
  rowHeight: number;
  height: number;
  class?: string;
  overscan?: number;
  render: (item: T, index: number) => unknown;
}) {
  const [scrollTop, setScrollTop] = createSignal(0);
  let element!: HTMLDivElement;
  const overscan = () => props.overscan ?? 5;
  const start = () => Math.max(0, Math.floor(scrollTop() / props.rowHeight) - overscan());
  const end = () => Math.min(props.items.length, Math.ceil((scrollTop() + props.height) / props.rowHeight) + overscan());
  const visible = () => props.items.slice(start(), end());
  onMount(() => {
    const observer = new ResizeObserver(() => setScrollTop(element.scrollTop));
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div
      ref={element}
      class={props.class}
      style={{ height: `${props.height}px`, overflow: 'auto' }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: `${props.items.length * props.rowHeight}px`, position: 'relative' }}>
        <For each={visible()}>
          {(item, offset) => (
            <div style={{ position: 'absolute', top: `${(start() + offset()) * props.rowHeight}px`, height: `${props.rowHeight}px`, left: '0', right: '0' }}>
              {props.render(item, start() + offset()) as never}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
