import { expect, it } from 'vitest';
import { queueBrowserLayout } from '../src/lib/browserLayout';

it('waits for a show to finish before cleanup hides the same browser', async () => {
  const events: string[] = [];
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const show = queueBrowserLayout('first', async () => {
    events.push('show started');
    await completed;
    events.push('show finished');
  });
  const hide = queueBrowserLayout('first', async () => { events.push('hidden'); });
  await queueBrowserLayout('second', async () => { events.push('other browser'); });
  expect(events).toEqual(['show started', 'other browser']);
  finish();
  await Promise.all([show, hide]);
  expect(events).toEqual(['show started', 'other browser', 'show finished', 'hidden']);
});

it('still runs cleanup after a failed show', async () => {
  const failed = queueBrowserLayout('failed', async () => { throw new Error('closed'); });
  let hidden = false;
  const cleanup = queueBrowserLayout('failed', async () => { hidden = true; });
  await expect(failed).rejects.toThrow('closed');
  await cleanup;
  expect(hidden).toBe(true);
});
