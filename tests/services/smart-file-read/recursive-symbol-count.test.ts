import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "class Outer {\n create() {\n  class Inner {\n   run() { return 1; }\n  }\n }\n}\n";
const filename = "nested.js";
describe("recursive-symbol-count", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.[1].name).toBe('Inner');
  expect(formatFoldedView(file)).toContain("run");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-recursive-symbol-count-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "run");
   const match = result.matchingSymbols.find(s => s.symbolName === "Outer.Inner.run");
   expect(match).toBeDefined();
   expect(result.totalSymbolsFound).toBe(4);
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("return 1;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('counts an empty outline and separate top-level declarations', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'cm-count-controls-'));
 try {
  writeFileSync(join(dir, 'empty.js'), '// empty');
  expect((await searchCodebase(dir, 'anything')).totalSymbolsFound).toBe(0);
  writeFileSync(join(dir, 'flat.js'), 'function one() {}\nfunction two() {}');
  expect((await searchCodebase(dir, 'one')).totalSymbolsFound).toBe(2);
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
