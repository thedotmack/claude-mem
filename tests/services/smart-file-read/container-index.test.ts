import { expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

test('keeps methods on their own sibling class in a wide native outline', () => {
  const count = 256;
  const source = Array.from({ length: count }, (_, index) =>
    `class Item${index} { first() { return ${index}; } second() { return ${index + 1}; } }`).join('\n');
  const file = parseFile(source, 'wide.ts');
  expect(file.symbols.map(symbol => symbol.name)).toEqual(Array.from({ length: count }, (_, index) => `Item${index}`));
  for (const [index, symbol] of file.symbols.entries()) {
    expect(symbol.children?.map(child => [child.name, child.kind, child.lineStart, child.lineEnd]))
      .toEqual([['first', 'method', index, index], ['second', 'method', index, index]]);
  }
}, 120_000);

test('retains nearest lexical ownership across nested and adjacent same-line ranges', () => {
  const source = 'namespace Outer { namespace Inner { export class Box { read() { return 1; } } } '
    + 'export class Other { read() { return 2; } } export function run() { return 3; } } '
    + 'class Last { read() { return 4; } } function outside() { return 5; }';
  const file = parseFile(source, 'nested.ts');
  expect(file.symbols.map(symbol => symbol.name)).toEqual(['Outer', 'Last', 'outside']);
  const outer = file.symbols[0];
  expect(outer.children?.map(symbol => [symbol.name, symbol.kind])).toEqual([
    ['Inner', 'namespace'], ['Other', 'class'], ['run', 'function'],
  ]);
  expect(outer.children?.[0].children?.[0].children?.map(symbol => symbol.name)).toEqual(['read']);
  expect(outer.children?.[1].children?.map(symbol => symbol.name)).toEqual(['read']);
  expect(file.symbols[1].children?.map(symbol => symbol.name)).toEqual(['read']);
}, 120_000);

test('keeps top-level functions when a file has no containers', () => {
  const file = parseFile('function first() { return 1; }\nfunction second() { return 2; }', 'functions.ts');
  expect(file.symbols.map(symbol => [symbol.name, symbol.kind, symbol.children]))
    .toEqual([['first', 'function', undefined], ['second', 'function', undefined]]);
}, 120_000);

test('native batch search and qualified unfold retain the matching class body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'container-index-'));
  const source = Array.from({ length: 64 }, (_, index) =>
    `class Item${index} { unique${index}() { return 'body-${index}'; } }`).join('\n');
  try {
    writeFileSync(join(directory, 'items.ts'), source);
    const result = await searchCodebase(directory, 'unique37');
    expect(result.matchingSymbols[0].symbolName).toBe('Item37.unique37');
    const unfolded = unfoldSymbol(source, 'items.ts', result.matchingSymbols[0].symbolName)!;
    expect(unfolded).toContain('body-37');
    expect(unfolded).not.toContain('body-36');
    expect(unfolded).not.toContain('body-38');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
