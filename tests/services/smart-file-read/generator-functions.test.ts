import { describe, expect, test } from 'bun:test';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';

for (const extension of ['js', 'ts']) {
  describe(`native ${extension} generator function outlines`, () => {
    test('captures exported generators alongside ordinary declarations', () => {
      const file = parseFile('export function* iterate() { yield 1; }\nexport function ordinary() { return 2; }\n', `owned.${extension}`);
      expect(file.symbols.map(symbol => symbol.name)).toEqual(['iterate', 'ordinary']);
      expect(file.symbols.map(symbol => symbol.kind)).toEqual(['function', 'function']);
      expect(file.symbols.map(symbol => symbol.exported)).toEqual([true, true]);
    }, 120000);
    test('captures async generator declarations', () => {
      const file = parseFile('async function* stream() { yield 1; }\n', `owned.${extension}`);
      expect(file.symbols.map(symbol => symbol.name)).toEqual(['stream']);
    }, 120000);
    test('captures generator expressions with their variable names', () => {
      const file = parseFile('const values = function* internal() { yield 1; };\nconst events = async function* () { yield 2; };\n', `owned.${extension}`);
      expect(file.symbols.map(symbol => symbol.name)).toEqual(['values', 'events']);
    }, 120000);
    test('retains ordinary arrow functions and generator methods', () => {
      const file = parseFile('const ordinary = () => 1;\nclass Source {\n  *items() { yield 2; }\n}\n', `owned.${extension}`);
      expect(file.symbols.map(symbol => symbol.name)).toEqual(['ordinary', 'Source']);
      expect(file.symbols[1].children?.map(symbol => symbol.name)).toEqual(['items']);
    }, 120000);
  });
}
