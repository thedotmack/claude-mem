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

test('a local where binding does not implement the class signature', async () => {
 const source = 'class C a where\n f :: a -> Int\n g x = f x\n   where\n    f _ = 42\n';
 const filename = 'local.hs';
 const methods = parseFile(source, filename).symbols[0].children!;
 expect(methods.filter(symbol => symbol.name === 'f')).toHaveLength(1);
 expect(unfoldSymbol(source, filename, 'C.f')).toContain('f :: a -> Int');
 expect(unfoldSymbol(source, filename, 'C.f')).not.toContain('g x =');
 expect(unfoldSymbol(source, filename, 'C.g.f')).toContain('f _ = 42');
 const dir = mkdtempSync(join(tmpdir(), 'cm-haskell-local-'));
 try {
  writeFileSync(join(dir, filename), source);
  const result = await searchCodebase(dir, 'C.f');
  expect(result.matchingSymbols.filter(symbol => symbol.symbolName === 'C.f')).toHaveLength(1);
  expect(result.matchingSymbols.find(symbol => symbol.symbolName === 'C.f')!.lineStart).toBe(1);
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('a later class signature expands rather than reverses default implementation bounds', async () => {
 const source = 'class C a where\n f _ = 42\n f :: a -> Int\n';
 const filename = 'later.hs';
 const method = parseFile(source, filename).symbols[0].children![0];
 expect([method.lineStart, method.lineEnd]).toEqual([1, 2]);
 const unfolded = unfoldSymbol(source, filename, 'C.f');
 expect(unfolded).toContain('f _ = 42');
 expect(unfolded).toContain('f :: a -> Int');
 const dir = mkdtempSync(join(tmpdir(), 'cm-haskell-later-'));
 try {
  writeFileSync(join(dir, filename), source);
  const match = (await searchCodebase(dir, 'C.f')).matchingSymbols.find(symbol => symbol.symbolName === 'C.f')!;
  expect(match.lineStart).toBeLessThanOrEqual(match.lineEnd);
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('grouped and operator class signatures have independent search and unfold identities', async () => {
 const source = 'class Render a where\n render, display :: a -> String\n (<>) :: a -> a -> a\n plain :: a -> Int\n';
 const filename = 'grouped.hs';
 expect(parseFile(source, filename).symbols[0].children!.map(symbol => symbol.name)).toEqual(['render', 'display', '(<>)', 'plain']);
 const dir = mkdtempSync(join(tmpdir(), 'cm-haskell-grouped-'));
 try {
  writeFileSync(join(dir, filename), source);
  for (const [name, declaration] of [['render', 'render, display ::'], ['display', 'render, display ::'], ['(<>)', '(<>) ::']]) {
   const match = (await searchCodebase(dir, name)).matchingSymbols.find(symbol => symbol.symbolName === `Render.${name}`);
   expect(match).toBeDefined();
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain(declaration);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
