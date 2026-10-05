import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const SOURCE = 'class Counter {\n  public Counter(int initial) {\n    System.out.println(initial);\n  }\n  int increment() { return 1; }\n}';

describe('Java constructor outlines', () => {
  test('captures a constructor beside its class instance methods', () => {
    const parsed = parseFile(SOURCE, 'Counter.java');
    expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['Counter']);
    expect(parsed.symbols[0].children?.map(symbol => symbol.name)).toEqual(['Counter(int initial)', 'increment']);
    const constructor = parsed.symbols[0].children?.[0];
    expect(constructor?.kind).toBe('method');
    expect(constructor?.lineStart).toBe(1);
    expect(constructor?.lineEnd).toBe(3);
    expect(formatFoldedView(parsed)).toContain('public Counter(int initial)');
  }, 120000);

  test('retains each overloaded constructor with its own source range', () => {
    const source = 'class Counter {\n  Counter() {}\n  Counter(int initial) {}\n}';
    const constructors = parseFile(source, 'Counter.java').symbols[0].children;
    expect(constructors?.map(symbol => [symbol.name, symbol.lineStart])).toEqual([['Counter()', 1], ['Counter(int initial)', 2]]);
  }, 120000);

  test('native batched search includes the constructor result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-java-constructor-'));
    try {
      writeFileSync(join(dir, 'Counter.java'), SOURCE);
      const result = await searchCodebase(dir, 'Counter');
      expect(result.matchingSymbols.find(symbol => symbol.symbolName === 'Counter.Counter(int initial)')?.kind).toBe('method');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});

test('unfolds overloaded constructors independently of the class name', () => {
  const source = 'class Counter {\n  Counter() { noArgs(); }\n  Counter(int initial) { withArgs(initial); }\n}';
  expect(unfoldSymbol(source, 'Counter.java', 'Counter')).toContain('class Counter');
  expect(unfoldSymbol(source, 'Counter.java', 'Counter()')).toContain('noArgs()');
  expect(unfoldSymbol(source, 'Counter.java', 'Counter()')).not.toContain('withArgs');
  expect(unfoldSymbol(source, 'Counter.java', 'Counter(int initial)')).toContain('withArgs(initial)');
  expect(unfoldSymbol(source, 'Counter.java', 'Counter(int initial)')).not.toContain('noArgs');
}, 120000);
