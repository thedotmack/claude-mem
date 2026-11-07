import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "[server]\nport=1234\n[\"quoted.name\"]\nenabled=true\n[['items']]\nid=1\n";
const filename = "settings.toml";
describe("toml-quoted-tables", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['server', '"quoted.name"', "'items'"]);
  expect(formatFoldedView(file)).toContain("quoted");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-toml-quoted-tables-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "quoted");
   const match = result.matchingSymbols.find(s => s.symbolName === "\"quoted.name\"");
   expect(match).toBeDefined();

   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("enabled=true");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('preserves bare and mixed dotted headers without duplicate symbols', () => {
 const file = parseFile('[server.http]\nport=80\n[server."quoted"]\nport=81\n', 'mixed.toml');
 expect(file.symbols.map(s => s.name)).toEqual(['server.http', 'server."quoted"']);
}, 120000);
