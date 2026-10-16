import { describe, expect, it } from 'vitest';

import { baseNameOf, fileIconOf, folderIconOf } from '../src/lib/file-icons';

describe('material file icons', () => {
  it('normalizes both native and web paths', () => {
    expect(baseNameOf('C:\\work\\src\\App.TSX')).toBe('app.tsx');
    expect(baseNameOf('/work/docs/')).toBe('docs');
  });

  it('prefers a special file name over its extension', () => {
    expect(fileIconOf('/work/vite.config.ts')).not.toBe(fileIconOf('/work/app.ts'));
    expect(fileIconOf('/work/package.json')).not.toBe(fileIconOf('/work/data.json'));
  });

  it('maps known extensions and falls back for unknown files', () => {
    expect(fileIconOf('component.tsx')).not.toBe(fileIconOf('component.ts'));
    expect(fileIconOf('one.unknown')).toBe(fileIconOf('two.unknown'));
  });

  it('uses named and expanded folder variants', () => {
    expect(folderIconOf('/work/src')).not.toBe(folderIconOf('/work/other'));
    expect(folderIconOf('/work/src', true)).not.toBe(folderIconOf('/work/src'));
    expect(folderIconOf('/work/other', true)).not.toBe(folderIconOf('/work/other'));
  });
});
