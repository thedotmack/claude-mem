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

test('drops indentation and CRLF from multi-line names', async () => {
 const nested = parseFile('.card {\n  .title,\n    .subtitle { color: red; }\n}\n', 'nested.scss');
 expect(nested.symbols.map(s => s.name)).toEqual(['.card', '.title, .subtitle']);
 const media = parseFile('@media (min-width: 1px) {\n\t.title,\n\t.subtitle { color: red; }\n}\n', 'media.css');
 expect(media.symbols[0].children?.map(s => s.name)).toEqual(['.title, .subtitle']);
 const crlf = '.first,\r\n.second { color: red; }\r\n.plain { color: blue; }\r\n';
 expect(parseFile(crlf, 'crlf.css').symbols.map(s => s.name)).toEqual(['.first, .second', '.plain']);
 const dir = mkdtempSync(join(tmpdir(), 'cm-multiline-symbol-names-crlf-'));
 try {
  writeFileSync(join(dir, 'crlf.css'), crlf);
  const match = (await searchCodebase(dir, 'second')).matchingSymbols.find(s => s.symbolName === '\\.first, \\.second');
  expect(match).toBeDefined();
  expect(unfoldSymbol(crlf, 'crlf.css', match!.symbolName)).toContain('color: red;');
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('keeps inline code in markdown heading names', () => {
 const file = parseFile('## The `foo` API\n\nBody.\n', 'api.md');
 expect(file.symbols.map(s => s.name)).toEqual(['The `foo` API']);
 expect(formatFoldedView(file)).toContain('## The `foo` API');
}, 120000);

test('names a zero-width recovered name anonymous', () => {
 const file = parseFile('{ color: red; }\n.plain { color: blue; }\n', 'missing.css');
 expect(file.symbols.map(s => s.name)).toEqual(['anonymous', '.plain']);
}, 120000);
