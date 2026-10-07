import { createSignal, onCleanup } from 'solid-js';

export function Splitter(props: {
  side: 'left' | 'right';
  onDrag: (deltaPx: number) => void;
  onDone?: () => void;
}) {
  const [hot, setHot] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  let last = 0;

  const down = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    last = e.clientX;
    setDragging(true);
  };

  const move = (e: PointerEvent) => {
    if (!dragging()) return;
    const delta = e.clientX - last;
    if (delta === 0) return;
    last = e.clientX;
    props.onDrag(props.side === 'left' ? delta : -delta);
  };

  const up = (e: PointerEvent) => {
    if (!dragging()) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
    props.onDone?.();
  };

  onCleanup(() => document.body.style.removeProperty('cursor'));

  return (
    <div
      class="splitter"
      classList={{ 'splitter--hot': hot(), 'splitter--active': dragging() }}
      onPointerEnter={() => setHot(true)}
      onPointerLeave={() => setHot(false)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onDblClick={() => props.onDone?.()}
    >
      <span class="splitter__line" />
    </div>
  );
}
