import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "class Widget {\n constructor(size: Int) { println(size) }\n constructor(label: String) { println(label) }\n fun render() {}\n}\n";
const filename = "constructors.kt";
describe("kotlin-constructors", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(s => s.name)).toEqual(['constructor(size: Int)', 'constructor(label: String)', 'render']);
  expect(formatFoldedView(file)).toContain("constructor(label");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-kotlin-constructors-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "constructor(label");
   const match = result.matchingSymbols.find(s => s.symbolName === "Widget.constructor(label: String)");
   expect(match).toBeDefined();
   
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("println(label)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('preserves multiline parameters and constructor delegation', () => {
 const source = 'class Widget(val size: Int) {\n constructor(\n label: String,\n extra: Int\n ) : this(extra) { println(label) }\n}';
 expect(parseFile(source, 'delegation.kt').symbols[0].children?.map(s => s.name)).toEqual(['constructor( label: String, extra: Int )']);
 expect(unfoldSymbol(source, 'delegation.kt', 'Widget.constructor( label: String, extra: Int )')).toContain('this(extra)');
}, 120000);
