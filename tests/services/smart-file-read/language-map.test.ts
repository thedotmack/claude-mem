import { describe, expect, it } from 'bun:test';
import { detectLanguage, LANG_MAP } from '../../../src/services/smart-file-read/language-map.js';

describe('language-map', () => {
  it('maps extensions to smart-file-read languages', () => {
    expect(detectLanguage('/repo/src/handler.ts')).toBe('typescript');
    expect(detectLanguage('/repo/docs/guide.md')).toBe('markdown');
    expect(LANG_MAP['.yaml']).toBe('yaml');
  });

  it('answers unknown for an extension it has no grammar for', () => {
    expect(detectLanguage('/repo/package.json')).toBe('unknown');
    expect(detectLanguage('/repo/Makefile')).toBe('unknown');
  });

  it('matches extensions case-insensitively', () => {
    expect(detectLanguage('/repo/tools/build.PY')).toBe('python');
  });
});
