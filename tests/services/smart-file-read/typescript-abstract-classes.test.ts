import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

// tree-sitter-typescript parses `abstract class` as abstract_class_declaration and
// its bodiless members as abstract_method_signature, not as the class_declaration
// and method_definition nodes the outline query matched.
const SOURCE = [
  'export abstract class Shape {',
  '  abstract area(): number;',
  '  describe(): string { return "shape"; }',
  '}',
  '',
  'abstract class Repository<T> {',
  '  protected abstract load(id: string): Promise<T>;',
  '}',
].join('\n');

describe('TypeScript abstract class outlines', () => {
  for (const file of ['shape.ts', 'shape.tsx']) {
    test(`lists an abstract class with its abstract and concrete members in ${file}`, () => {
      const parsed = parseFile(SOURCE, file);
      expect(parsed.symbols.map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([
        ['Shape', 'class', true],
        ['Repository', 'class', false],
      ]);
      expect(parsed.symbols[0].children?.map(symbol => [symbol.name, symbol.lineStart])).toEqual([['area', 1], ['describe', 2]]);
      expect(parsed.symbols[1].children?.map(symbol => symbol.name)).toEqual(['load']);
      const folded = formatFoldedView(parsed);
      expect(folded).toContain('export abstract class Shape');
      expect(folded).toContain('abstract area(): number;');
      expect(folded).toContain('protected abstract load(id: string): Promise<T>;');
    }, 120000);
  }

  test('unfolds an abstract class and one of its abstract methods', () => {
    const shape = unfoldSymbol(SOURCE, 'shape.ts', 'Shape');
    expect(shape).toContain('abstract area(): number;');
    expect(shape).toContain('describe(): string');
    expect(shape).not.toContain('Repository');
    expect(unfoldSymbol(SOURCE, 'shape.ts', 'Repository.load')).toContain('protected abstract load(id: string): Promise<T>;');
  }, 120000);

  test('native batched search finds an abstract class and its abstract methods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-abstract-class-'));
    try {
      writeFileSync(join(dir, 'shape.ts'), SOURCE);
      const shape = await searchCodebase(dir, 'Shape');
      expect(shape.matchingSymbols.find(symbol => symbol.symbolName === 'Shape')?.kind).toBe('class');
      const area = await searchCodebase(dir, 'area');
      expect(area.matchingSymbols.map(symbol => symbol.symbolName)).toContain('Shape.area');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
