import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectLanguage, LANG_MAP } from '../../../src/services/smart-file-read/language-map.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

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

  it('search scans every mapped extension without native symbol extraction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-search-extensions-'));
    try {
      const extensions = Object.keys(LANG_MAP);
      for (const extension of extensions) writeFileSync(join(dir, `probe${extension}`), 'probe');
      const result = await searchCodebase(dir, 'probe', { skipSymbolExtraction: true });
      expect(result.totalFilesScanned).toBe(extensions.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
