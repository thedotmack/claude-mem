import { describe, expect, test } from 'bun:test';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';

const SOURCE = 'export var arrow = () => 1;\nvar ordinary = function internal() { return 2; };\nvar generator = function* internalGenerator() { yield 3; };\nvar asyncGenerator = async function*() { yield 4; };\nlet lexical = () => 5;\nvar scalar = 6;';

for (const extension of ['js', 'ts']) {
  describe(`native ${extension} var function values`, () => {
    test('captures var function values with their variable names and export status', () => {
      const symbols = parseFile(SOURCE, `owned.${extension}`).symbols;
      expect(symbols.map(symbol => symbol.name)).toEqual(['arrow', 'ordinary', 'generator', 'asyncGenerator', 'lexical']);
      expect(symbols.map(symbol => symbol.kind)).toEqual(Array(5).fill('function'));
      expect(symbols.map(symbol => symbol.exported)).toEqual([true, false, false, false, false]);
      expect(unfoldSymbol(SOURCE, `owned.${extension}`, 'ordinary')).toContain('var ordinary = function internal()');
    }, 120000);

  });
}
