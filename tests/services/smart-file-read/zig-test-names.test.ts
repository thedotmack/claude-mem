import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "test \"first case\" {\n const first = 1;\n}\ntest \"second case\" {\n const second = 2;\n}\nfn ordinary() void {}\n";
const filename = "checks.zig";
describe("zig-test-names", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['"first case"', '"second case"', 'ordinary']);
  expect(formatFoldedView(file)).toContain("second");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-zig-test-names-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "second");
   const match = result.matchingSymbols.find(s => s.symbolName === "\"second case\"");
   expect(match).toBeDefined();

   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("const second = 2;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('retains anonymous Zig test blocks and ordinary functions once', () => {
 expect(parseFile('test { const owned = 1; }\nfn ordinary() void {}\n', 'anonymous.zig').symbols.map(s => s.name)).toEqual(['anonymous', 'ordinary']);
}, 120000);

test('retains identifier-named Zig tests across outline, search and unfold', async () => {
 const source = 'test sample_identifier {\n const identified = 42;\n}\ntest { const anonymous_control = 1; }\nfn ordinary() void {}\n';
 const filename = 'identifier.zig';
 const file = parseFile(source, filename);
 expect(file.symbols.map(symbol => symbol.name)).toEqual(['sample_identifier', 'anonymous', 'ordinary']);
 expect(formatFoldedView(file)).toContain('sample_identifier');
 const dir = mkdtempSync(join(tmpdir(), 'cm-zig-identifier-'));
 try {
  writeFileSync(join(dir, filename), source);
  const result = await searchCodebase(dir, 'sample_identifier');
  const match = result.matchingSymbols.find(symbol => symbol.symbolName === 'sample_identifier');
  expect(match).toBeDefined();
  expect(unfoldSymbol(source, filename, match!.symbolName)).toContain('const identified = 42;');
  expect(unfoldSymbol(source, filename, match!.symbolName)).not.toContain('anonymous_control');
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
