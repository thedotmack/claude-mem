import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const source = [
  'class Value {',
  '  get item() { return "getter body"; }',
  '  set item(value) { store("setter body", value); }',
  '  get ["quoted"]() { return "computed getter body"; }',
  '  set ["quoted"](value) { store("computed setter body", value); }',
  '  get() { return "ordinary get method"; }',
  '  set(value) { store("ordinary set method", value); }',
  '}',
].join('\n');

for (const filename of ['accessors.js', 'accessors.ts', 'accessors.tsx']) {
  describe(filename, () => {
    test('getter and setter identities do not collide with each other or ordinary method names', () => {
      const methods = parseFile(source, filename).symbols[0].children!;
      expect(methods.map(symbol => [symbol.name, symbol.kind])).toEqual([
        ['get item', 'getter'], ['set item', 'setter'],
        ['get ["quoted"]', 'getter'], ['set ["quoted"]', 'setter'],
        ['get', 'method'], ['set', 'method'],
      ]);
    }, 120000);

    test('each accessor can be unfolded without returning its sibling implementation', () => {
      for (const [name, expected, excluded] of [
        ['Value.get item', 'getter body', 'setter body'],
        ['Value.set item', 'setter body', 'getter body'],
        ['Value.get ["quoted"]', 'computed getter body', 'computed setter body'],
        ['Value.set ["quoted"]', 'computed setter body', 'computed getter body'],
      ]) {
        const result = unfoldSymbol(source, filename, name);
        expect(result).toContain(expected);
        expect(result).not.toContain(excluded);
      }
    }, 120000);

    test('the old property-only lookup and ordinary get/set method lookups stay usable', () => {
      expect(unfoldSymbol(source, filename, 'Value.item')).toContain('getter body');
      expect(unfoldSymbol(source, filename, 'item')).toContain('getter body');
      expect(unfoldSymbol(source, filename, 'Value.get')).toContain('ordinary get method');
      expect(unfoldSymbol(source, filename, 'Value.set')).toContain('ordinary set method');
    }, 120000);

    test('native search results can be passed straight to unfold for either accessor', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'cm-accessor-search-'));
      try {
        writeFileSync(join(directory, filename), source);
        const result = await searchCodebase(directory, 'item');
        expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['Value.get item', 'Value.set item']);
        for (const match of result.matchingSymbols) {
          const unfolded = unfoldSymbol(source, filename, match.symbolName);
          expect(unfolded).toContain(match.kind === 'getter' ? 'getter body' : 'setter body');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 120000);
  });
}

test('abstract TypeScript accessor signatures retain separate identities', () => {
  const parsed = parseFile('abstract class Value {\n  abstract get item(): string;\n  abstract set item(value: string);\n}', 'abstract.ts');
  expect(parsed.symbols[0].children?.map(symbol => [symbol.name, symbol.kind])).toEqual([
    ['get item', 'getter'], ['set item', 'setter'],
  ]);
}, 120000);
