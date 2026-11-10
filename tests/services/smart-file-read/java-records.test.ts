import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
const source = "record Point(int x, int y) {\n  int total() { return x + y; }\n}\nclass Plain {\n  void regular() {}\n}\n";
const filename = "records.java";
describe("java-records", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['Point', 'Plain']); expect(file.symbols[0].children?.map(s => s.name)).toEqual(['total']);
  expect(formatFoldedView(file)).toContain("total");
 }, 120000);
});

test('keeps nested record methods with their nearest record owner', () => {
 const source = 'class Outer {\n record Inner(int value) {\n int read() { return value; }\n }\n}';
 const outer = parseFile(source, 'nested.java').symbols[0];
 expect(outer.children?.map(s => s.name)).toEqual(['Inner']);
 expect(outer.children?.[0].children?.map(s => s.name)).toEqual(['read']);
 expect(unfoldSymbol(source, 'nested.java', 'Outer.Inner.read')).toContain('return value;');
}, 120000);
