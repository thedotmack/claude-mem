import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = 'export function moduleEntry(): string { return "module body"; }';
describe('TypeScript module extension support', () => {
  for (const extension of ['mts', 'cts']) {
    test(`outlines and unfolds .${extension} using the TypeScript grammar`, () => {
      const outline = parseFile(source, `entry.${extension}`);
      expect(outline.language).toBe('typescript');
      expect(outline.symbols.some(symbol => symbol.name === 'moduleEntry')).toBe(true);
      expect(unfoldSymbol(source, `entry.${extension}`, 'moduleEntry')).toContain('module body');
    }, 120000);
  }
  test('discovers both module formats in native batched symbol search', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-ts-modules-'));
    try {
      writeFileSync(join(root, 'entry.mts'), source);
      writeFileSync(join(root, 'entry.cts'), source);
      const results = await searchCodebase(root, 'moduleEntry');
      expect(results.matchingSymbols.map(symbol => symbol.filePath).sort()).toEqual(['entry.cts', 'entry.mts']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120000);
});
