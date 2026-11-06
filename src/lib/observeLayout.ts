/** Run layout-changing resize work outside ResizeObserver's delivery cycle. */
export function observeLayout(element: Element, update: () => void): () => void {
  let frame = 0;
  let disposed = false;
  const observer = new ResizeObserver(() => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!disposed) update();
    });
  });
  observer.observe(element);
  return () => {
    disposed = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}
