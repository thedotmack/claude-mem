import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "class Widget {\n  \"quoted\"() { return 1; }\n  [\"computed\"]() { return 2; }\n  #private() { return 3; }\n  regular() { return 4; }\n}\n";
const filename = "names.js";
describe("js-method-names", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(s => s.name)).toEqual(['"quoted"', '["computed"]', '#private', 'regular']);
  expect(formatFoldedView(file)).toContain("private");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-js-method-names-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "private");
   const match = result.matchingSymbols.find(s => s.symbolName === "Widget.#private");
   expect(match).toBeDefined();
   
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("return 3;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('retains the same legal method names under the TypeScript grammar', () => {
 expect(parseFile(source, 'names.ts').symbols[0].children?.map(s => s.name)).toEqual(['"quoted"', '["computed"]', '#private', 'regular']);
}, 120000);
