import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "export function answer() { return 42; }";
const filename = "MODULE.JS";
describe("case-insensitive-extensions", () => {
 test('reproduces the native production behavior', () => {
  const file = parseFile(source, filename);
  expect(file.language).toBe('javascript'); expect(file.symbols.map(s => s.name)).toEqual(['answer']);
 }, 120000);
 test('keeps the result usable through batch search and unfold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-case-insensitive-extensions-'));
  try {
   writeFileSync(join(dir, filename), source);

   const result = await searchCodebase(dir, "answer", { maxResults: 1 });
   const match = result.matchingSymbols.find(s => s.symbolName === "answer");
   expect(match).toBeDefined();

   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("return 42;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('recognizes mixed-case extensions while retaining unknown-file behavior', () => {
 expect(parseFile('export function answer() {}', 'module.Ts').language).toBe('typescript');
 expect(parseFile('def answer():\n return 1', 'script.PY').symbols.map(s => s.name)).toEqual(['answer']);
 expect(parseFile('anything', 'unknown.data').language).toBe('unknown');
}, 120000);
