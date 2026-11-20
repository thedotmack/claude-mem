import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

// tree-sitter-typescript parses `namespace X {}` as internal_module and
// `module "x" {}` as module. The outline query matched neither, so their
// members were listed at the top of the file, as if they had no owner.
const SOURCE = [
  'export namespace Validation {',
  '  export function isZip(s: string): boolean { return /^\\d{5}$/.test(s); }',
  '  export namespace Inner {',
  '    export function deep() {}',
  '  }',
  '}',
  '',
  'namespace Geometry.Shapes {',
  '  export class Circle {}',
  '}',
  '',
  'declare module "express" {',
  '  interface Request { user?: string }',
  '}',
].join('\n');

describe('TypeScript namespace outlines', () => {
  for (const file of ['shapes.ts', 'shapes.tsx']) {
    test(`nests the members of namespaces and modules in ${file}`, () => {
      const symbols = parseFile(SOURCE, file).symbols;
      expect(symbols.map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([
        ['Validation', 'namespace', true],
        ['Geometry.Shapes', 'namespace', false],
        ['"express"', 'namespace', false],
      ]);
      expect(symbols[0].children?.map(symbol => symbol.name)).toEqual(['isZip', 'Inner']);
      expect(symbols[0].children?.[1].children?.map(symbol => symbol.name)).toEqual(['deep']);
      expect(symbols[1].children?.map(symbol => symbol.name)).toEqual(['Circle']);
      expect(symbols[2].children?.map(symbol => symbol.name)).toEqual(['Request']);
    }, 120000);
  }

  test('unfolds a namespace and qualifies its members in search', async () => {
    expect(unfoldSymbol(SOURCE, 'shapes.ts', 'Validation')).toContain('export function deep()');
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-ts-namespace-'));
    try {
      writeFileSync(join(dir, 'shapes.ts'), SOURCE);
      const result = await searchCodebase(dir, 'deep');
      expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['Validation.Inner.deep']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
