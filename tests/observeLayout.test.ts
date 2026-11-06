import { afterEach, expect, it, vi } from 'vitest';
import { observeLayout } from '../src/lib/observeLayout';

afterEach(() => vi.unstubAllGlobals());

it('defers and coalesces resize work, and cancels it on disposal', () => {
  let notify!: () => void;
  let runFrame!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const request = vi.fn((callback: () => void) => { runFrame = callback; return 1; });
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  const update = vi.fn();
  const dispose = observeLayout({} as Element, update);
  notify();
  notify();
  expect(update).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  runFrame();
  expect(update).toHaveBeenCalledTimes(1);
  notify();
  dispose();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledWith(1);
  runFrame();
  notify();
  expect(update).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
});
