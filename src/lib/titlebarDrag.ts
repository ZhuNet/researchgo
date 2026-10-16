export const TITLEBAR_DRAG_THRESHOLD = 4;

export function passedDragThreshold(
  origin: { x: number; y: number },
  current: { x: number; y: number },
): boolean {
  const dx = current.x - origin.x;
  const dy = current.y - origin.y;
  return dx * dx + dy * dy >= TITLEBAR_DRAG_THRESHOLD * TITLEBAR_DRAG_THRESHOLD;
}
