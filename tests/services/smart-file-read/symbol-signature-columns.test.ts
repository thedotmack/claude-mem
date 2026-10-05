import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "class Widget { first() { return 1; } second() { return 2; } }\nconst caf\u00e9 = 1; function answer() { return 3; }\n";
const filename = "columns.js";
describe("symbol-signature-columns", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(s => s.signature)).toEqual(['first()', 'second()']); expect(file.symbols[1].signature).toBe('function answer()');
  expect(formatFoldedView(file)).toContain("second");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-symbol-signature-columns-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "second");
   const match = result.matchingSymbols.find(s => s.symbolName === "Widget.second");
   expect(match).toBeDefined();
   
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("return 2;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('keeps multiline and ordinary declaration signatures intact', () => {
 const source = 'function multiline(\n value\n) {\n return value;\n}\nclass Box {\n run() { return 1; }\n}';
 const file = parseFile(source, 'multiline.js');
 expect(file.symbols[0].signature).toBe('function multiline( value )');
 expect(file.symbols[1].children?.[0].signature).toBe('run()');
}, 120000);
