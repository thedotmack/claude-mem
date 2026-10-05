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

for (const filename of ['multiline.js', 'multiline.ts', 'multiline.tsx']) {
 test(`multiline computed method names retain unique search and unfold identities in ${filename}`, async () => {
  const source = 'class Widget {\n [\n "first"\n ]() { return "first body"; }\n [\n "second"\n ]() { return "second body"; }\n}';
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(symbol => symbol.name)).toEqual(['[\n "first"\n ]', '[\n "second"\n ]']);
  const dir = mkdtempSync(join(tmpdir(), 'cm-computed-multiline-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, 'second');
   const match = result.matchingSymbols.find(symbol => symbol.symbolName === 'Widget.[\n "second"\n ]');
   expect(match).toBeDefined();
   const unfolded = unfoldSymbol(source, filename, match!.symbolName)!;
   expect(unfolded).toContain('return "second body";');
   expect(unfolded).not.toContain('return "first body";');
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
}

test('multiline computed string keys preserve literal whitespace in search and unfold identities', async () => {
 const source = 'class Widget {\n [\n "a  b"\n ]() { return "double space"; }\n [\n "a b"\n ]() { return "single space"; }\n}';
 const filename = 'literal-spaces.js';
 const names = parseFile(source, filename).symbols[0].children!.map(symbol => symbol.name);
 expect(new Set(names).size).toBe(2);
 const dir = mkdtempSync(join(tmpdir(), 'cm-computed-literal-spaces-'));
 try {
  writeFileSync(join(dir, filename), source);
  for (const [key, body, other] of [['a  b', 'double space', 'single space'], ['a b', 'single space', 'double space']]) {
   const match = (await searchCodebase(dir, key)).matchingSymbols.find(symbol => symbol.symbolName.includes(`"${key}"`));
   expect(match).toBeDefined();
   const unfolded = unfoldSymbol(source, filename, match!.symbolName)!;
   expect(unfolded).toContain(`return "${body}";`);
   expect(unfolded).not.toContain(`return "${other}";`);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
