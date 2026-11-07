import { describe, expect, it } from 'bun:test';
import { detectLanguage, LANG_MAP } from '../../../src/services/smart-file-read/language-map.js';

describe('language-map', () => {
  it('maps extensions to smart-file-read languages', () => {
    expect(detectLanguage('/repo/src/handler.ts')).toBe('typescript');
    expect(detectLanguage('/repo/docs/guide.md')).toBe('markdown');
    expect(LANG_MAP['.yaml']).toBe('yaml');
    expect(detectLanguage('/repo/src/Counter.pas')).toBe('pascal');
    expect(detectLanguage('/repo/src/App.dpr')).toBe('pascal');
    expect(detectLanguage('/repo/src/Counter.pp')).toBe('pascal');
  });

  it('answers unknown for an extension it has no grammar for', () => {
    expect(detectLanguage('/repo/package.json')).toBe('unknown');
    expect(detectLanguage('/repo/Makefile')).toBe('unknown');
    // .inc is shared by PHP, C and assembler includes; parsing them as Pascal
    // would return wrong symbols instead of the honest plain-text fallback.
    expect(detectLanguage('/repo/include/config.inc')).toBe('unknown');
  });

  it('matches extensions case-insensitively', () => {
    expect(detectLanguage('/repo/tools/build.PY')).toBe('python');
  });
});
