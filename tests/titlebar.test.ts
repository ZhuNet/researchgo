import { describe, expect, it } from 'vitest';

import { passedDragThreshold } from '../src/lib/titlebarDrag';

describe('titlebar drag threshold', () => {
  it('does not start a native drag for a stationary click or small pointer jitter', () => {
    expect(passedDragThreshold({ x: 20, y: 30 }, { x: 20, y: 30 })).toBe(false);
    expect(passedDragThreshold({ x: 20, y: 30 }, { x: 23, y: 32 })).toBe(false);
  });

  it('starts dragging once pointer movement reaches four pixels', () => {
    expect(passedDragThreshold({ x: 20, y: 30 }, { x: 24, y: 30 })).toBe(true);
    expect(passedDragThreshold({ x: 20, y: 30 }, { x: 17, y: 27 })).toBe(true);
  });
});
