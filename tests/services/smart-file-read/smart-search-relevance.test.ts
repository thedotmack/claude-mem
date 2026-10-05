import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "/** target */\nfunction unrelated() { return 1; }\nfunction handle(target) { return target; }\n";
const filename = "a-docs.js";
describe("smart-search-relevance", () => {
 test('reproduces the native production behavior', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['unrelated', 'handle']);
 }, 120000);
 test('keeps the result usable through batch search and unfold', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-smart-search-relevance-'));
  try {
   writeFileSync(join(dir, filename), source);
   
   const result = await searchCodebase(dir, "target", { maxResults: 1 });
   const match = result.matchingSymbols.find(s => s.symbolName === "handle");
   expect(match).toBeDefined();
   expect(result.matchingSymbols[0].symbolName).toBe('handle');
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("target");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('ranks exact names above text-only matches under a one-result budget', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'cm-score-name-'));
 try {
  writeFileSync(join(dir, 'owned.js'), '/** target */\nfunction unrelated() {}\nfunction target() {}');
  const result = await searchCodebase(dir, 'target', { maxResults: 1 });
  expect(result.matchingSymbols.map(s => s.symbolName)).toEqual(['target']);
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
