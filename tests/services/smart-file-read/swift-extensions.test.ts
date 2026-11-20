import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const source = [
  'struct Circle {',
  '    let r: Double',
  '    func area() -> Double { .pi * r * r }',
  '}',
  'extension Circle: CustomStringConvertible {',
  '    var description: String { "Circle" }',
  '    func scaled(by f: Double) -> Circle { Circle(r: r * f) }',
  '}',
  'extension Array where Element == Circle {',
  '    func totalArea() -> Double { reduce(0) { $0 + $1.area() } }',
  '}',
  'func topLevel() {}',
].join('\n');
const filename = 'Shapes.swift';

describe('swift-extensions', () => {
  test('an extension owns the methods it declares', () => {
    const file = parseFile(source, filename);
    expect(file.symbols.map(s => [s.name, s.kind])).toEqual([
      ['Circle', 'class'], ['Circle', 'impl'], ['Array', 'impl'], ['topLevel', 'function'],
    ]);
    expect(file.symbols[1].signature).toBe('extension Circle: CustomStringConvertible');
    expect(file.symbols[1].children?.map(s => [s.name, s.kind])).toEqual([['scaled', 'method']]);
    expect(file.symbols[2].children?.map(s => s.name)).toEqual(['totalArea']);
  }, 120000);

  test('search and unfold address an extension method through its type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-swift-extensions-'));
    try {
      writeFileSync(join(dir, filename), source);
      const result = await searchCodebase(dir, 'scaled');
      expect(result.matchingSymbols.map(s => s.symbolName)).toEqual(['Circle.scaled']);
      expect(unfoldSymbol(source, filename, 'Circle.scaled')).toContain('Circle(r: r * f)');
      expect(unfoldSymbol(source, filename, 'Array.totalArea')).toContain('reduce(0)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
