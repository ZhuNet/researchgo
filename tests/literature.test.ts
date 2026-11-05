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

it('routes concurrent browser updates to their paper and ignores updates after completion', () => {
  let progress = updateLiterature(undefined, { stage: 'retrieving', total: 2 });
  progress = updateLiterature(progress, { stage: 'paper', index: 0, title: 'First' });
  progress = updateLiterature(progress, { stage: 'paper', index: 1, title: 'Second' });
  progress = updateLiterature(progress, { stage: 'browser', index: 1, label: 'paper-download-2', downloading: false });
  progress = updateLiterature(progress, { stage: 'browser', index: 0, label: 'paper-download-1', downloading: true });
  expect(progress.papers[1]).toEqual({ title: 'Second', browser: { label: 'paper-download-2', downloading: false } });
  expect(progress.papers[0].browser?.downloading).toBe(true);
  progress = updateLiterature(progress, { stage: 'result', index: 0, paper: { title: 'First', source: { status: 'pdf' } } });
  progress = updateLiterature(progress, { stage: 'browser', index: 0, label: 'paper-download-1', downloading: false });
  expect(progress.papers[0].browser).toBeUndefined();
  expect(progress.papers[0].result?.source.status).toBe('pdf');
});
