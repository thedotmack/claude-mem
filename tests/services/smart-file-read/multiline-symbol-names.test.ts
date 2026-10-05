import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = ".first,\n.second { color: red; }\n.plain { color: blue; }\n";
const filename = "selectors.css";
describe("multiline-symbol-names", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['.first, .second', '.plain']);
  expect(formatFoldedView(file)).toContain("second");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-multiline-symbol-names-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "second");
   const match = result.matchingSymbols.find(s => s.symbolName === "\\.first, \\.second");
   expect(match).toBeDefined();

   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("color: red;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('recovers UTF-8 selectors from native byte ranges', () => {
 const file = parseFile('.café,\n.second { color: red; }\n', 'unicode.css');
 expect(file.symbols.map(s => s.name)).toEqual(['.café, .second']);
}, 120000);
