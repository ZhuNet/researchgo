/**
 * The bundled PDF.js registers another delegated toggle listener every time
 * it renders a nested outline, without removing the old one on reset. Handle
 * toggles once in capture phase so rebuilds cannot toggle a node twice.
 */
export function installOutlineToggles(container: HTMLElement): () => void {
  const toggle = (event: MouseEvent) => {
    // Avoid instanceof Element: the target belongs to the viewer's iframe.
    const target = event.target as HTMLElement | null;
    if (!target?.classList?.contains('treeItemToggler')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const collapsed = target.classList.toggle('treeItemsHidden');
    if (event.shiftKey) {
      for (const child of target.parentElement!.querySelectorAll('.treeItemToggler')) {
        child.classList.toggle('treeItemsHidden', collapsed);
      }
    }
  };
  container.addEventListener('click', toggle, true);
  return () => container.removeEventListener('click', toggle, true);
}
