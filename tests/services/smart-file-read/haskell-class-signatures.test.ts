import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "module Sample where\nclass Render a where\n render :: a -> String\n size :: a -> Int\nanswer x = x + 1\n";
const filename = "classes.hs";
describe("haskell-class-signatures", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['Render', 'answer']); expect(file.symbols[0].children?.map(s => s.name)).toEqual(['render', 'size']);
  expect(formatFoldedView(file)).toContain("render");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-haskell-class-signatures-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "render");
   const match = result.matchingSymbols.find(s => s.symbolName === "Render.render");
   expect(match).toBeDefined();
   
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("render :: a -> String");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('retains default method implementations beside their declared signatures', () => {
 const source = 'class Render a where\n render :: a -> String\n render _ = "default"\n';
 const methods = parseFile(source, 'defaults.hs').symbols[0].children;
 expect(methods?.map(s => [s.name, s.lineStart])).toEqual([['render', 1]]);
 expect(methods?.[0].signature).toBe('render :: a -> String');
 expect(unfoldSymbol(source, 'defaults.hs', 'Render.render')).toContain('render _ = "default"');
}, 120000);
