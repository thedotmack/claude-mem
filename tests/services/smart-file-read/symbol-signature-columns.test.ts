import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "class Widget { first() { return 1; } second() { return 2; } }\nconst caf\u00e9 = 1; function answer() { return 3; }\n";
const filename = "columns.js";
describe("symbol-signature-columns", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(s => s.signature)).toEqual(['first()', 'second()']); expect(file.symbols[1].signature).toBe('function answer()');
  expect(formatFoldedView(file)).toContain("second");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-symbol-signature-columns-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "second");
   const match = result.matchingSymbols.find(s => s.symbolName === "Widget.second");
   expect(match).toBeDefined();

   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("return 2;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('keeps multiline and ordinary declaration signatures intact', () => {
 const source = 'function multiline(\n value\n) {\n return value;\n}\nclass Box {\n run() { return 1; }\n}';
 const file = parseFile(source, 'multiline.js');
 expect(file.symbols[0].signature).toBe('function multiline( value )');
 expect(file.symbols[1].children?.[0].signature).toBe('run()');
}, 120000);

for (const filename of ['exports.js', 'exports.ts', 'exports.tsx']) {
 test(`preserves native export prefixes without unrelated same-line code in ${filename}`, () => {
  const fn = parseFile('const café = 1; export default function greet() { return 1; }', filename);
  expect(fn.symbols[0].signature).toBe('export default function greet()');
  expect(formatFoldedView(fn)).toContain('export default function greet()');
  const cls = parseFile('const café = 1; export default class Widget { run() { return 2; } }', filename);
  expect(cls.symbols[0].signature).toBe('export default class Widget');
  expect(cls.symbols[0].children?.[0].signature).toBe('run()');
  const named = parseFile('const café = 1; export function named() { return 3; }', filename);
  expect(named.symbols[0].signature).toBe('export function named()');
 }, 120000);
}

for (const filename of ['decorated.js', 'decorated.ts', 'decorated.tsx']) {
 test(`keeps export keywords after decorators in ${filename}`, () => {
  const file = parseFile('@Injectable()\nexport class FooService {}', filename);
  expect(file.symbols[0].signature).toBe('export class FooService');
  const multiline = parseFile("@Component({\n  selector: 'x',\n})\nexport default class Widget {}", filename);
  expect(multiline.symbols[0].signature).toBe('export default class Widget');
  const sameLine = parseFile('@Dec() /* note */ export class Inline {}', filename);
  expect(sameLine.symbols[0].signature).toBe('export class Inline');
 }, 120000);
}

test('preserves multiline and commented export prefixes', () => {
 const file = parseFile('const café = 1; export default /* public entry */ function greet(\n value\n) { return value; }', 'multiline-export.js');
 expect(file.symbols[0].signature).toBe('export default function greet( value )');
}, 120000);

for (const filename of ['comment-export.js', 'comment-export.ts', 'comment-export.tsx']) {
 for (const [label, comment] of [['brace', '/* { */'], ['long', '/*\n' + 'prefix documentation\n'.repeat(12) + '*/']]) {
 test(`export ${label} comments cannot hide declaration signatures in ${filename}`, () => {
   const source = `const café = 1; export default ${comment} function greet() { return 'own-body'; }\nfunction after() { return 'other-body'; }`;
   const file = parseFile(source, filename);
   const symbol = file.symbols.find(s => s.name === 'greet')!;
   expect(symbol.signature).toBe('export default function greet()');
   expect(formatFoldedView(file)).toContain('export default function greet()');
   expect(symbol.lineStart).toBe(source.slice(0, source.indexOf('function greet')).split('\n').length - 1);
   const unfolded = unfoldSymbol(source, filename, 'greet')!;
   expect(unfolded).toContain("return 'own-body'");
   expect(unfolded).not.toContain('other-body');
 }, 120000);
 }
}
