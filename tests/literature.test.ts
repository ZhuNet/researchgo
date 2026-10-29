import { expect, it } from 'vitest';
import { updateLiterature } from '../src/lib/literature';

it('keeps completed paper results while fetching the next paper', () => {
  let progress = updateLiterature(undefined, { stage: 'retrieving', total: 2 });
  progress = updateLiterature(progress, { stage: 'paper', index: 0, title: 'First' });
  const downloading = progress;
  progress = updateLiterature(progress, { stage: 'result', index: 0, paper: {
    title: 'First', source: { status: 'pdf', path: 'reference/first.pdf' },
  } });
  progress = updateLiterature(progress, { stage: 'paper', index: 1, title: 'Second' });
  expect(progress.total).toBe(2);
  expect(progress.papers[0]?.result?.source.path).toBe('reference/first.pdf');
  expect(progress.papers[1]).toEqual({ title: 'Second' });
  expect(downloading.papers[0]?.result).toBeUndefined();
  progress = updateLiterature(progress, { stage: 'result', index: 1, paper: {
    title: 'Second', source: { status: 'unavailable' }, extraction_note: 'HTML returned HTTP 403 Forbidden',
  } });
  expect(progress.papers[0]?.result?.source.status).toBe('pdf');
  expect(progress.papers[1]?.result?.extraction_note).toBe('HTML returned HTTP 403 Forbidden');
});
