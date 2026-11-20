import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const SOURCE = 'Overview\n========\n\nintro\n\nDetails\n-------\n\ndetail\n\n# Next\nlast';

describe('native Markdown setext heading sections', () => {
  test('preserves setext heading names and underline levels beside ATX headings', () => {
    const headings = parseFile(SOURCE, 'owned.md').symbols.filter(symbol => symbol.kind === 'section');
    expect(headings.map(symbol => symbol.name)).toEqual(['Overview', 'Details', 'Next']);
    expect(headings.map(symbol => symbol.signature)).toEqual(['# Overview', '## Details', '# Next']);
  }, 120000);

  test('unfolds the parent section through its lower-level setext section', () => {
    const unfolded = unfoldSymbol(SOURCE, 'owned.md', 'Overview');
    expect(unfolded).toContain('Details\n-------');
    expect(unfolded).toContain('detail');
    expect(unfolded).not.toContain('# Next');
    expect(unfoldSymbol(SOURCE, 'owned.md', 'Details')).toContain('detail');
  }, 120000);

  test('preserves a multiline UTF-8 heading name', () => {
    const source = 'Café\n設計 details\n------------\n\nbody';
    const heading = parseFile(source, 'utf8.md').symbols[0];
    expect(heading.name).toBe('Café 設計 details');
    expect(heading.signature).toBe('## Café 設計 details');
    expect(unfoldSymbol(source, 'utf8.md', heading.name)).toContain('body');
  }, 120000);

  test('native batched search returns a setext heading by its visible name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-setext-search-'));
    try {
      writeFileSync(join(dir, 'owned.md'), SOURCE);
      const result = await searchCodebase(dir, 'Details');
      expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toContain('Details');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});

test('preserves captured ATX whitespace for exact-name unfolding', () => {
  const source = '# Multiple   Spaces\n\nowned ATX body';
  expect(parseFile(source, 'owned.md').symbols[0].name).toBe('Multiple   Spaces');
  expect(unfoldSymbol(source, 'owned.md', 'Multiple   Spaces')).toContain('owned ATX body');
}, 120000);
