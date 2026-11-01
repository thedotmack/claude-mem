import { describe, expect, test } from 'bun:test';
import { formatFoldedView, parseFile } from '../../../src/services/smart-file-read/parser.js';

describe('smart outline symbol ownership', () => {
  test('a method on the class opening line belongs to that class', () => {
    const parsed = parseFile('class Counter { increment() { return 1; } }', 'counter.js');
    expect(parsed.symbols.map(s => s.name)).toEqual(['Counter']);
    expect(parsed.symbols[0].children?.map(s => s.name)).toEqual(['increment']);
  }, 120000);

  test('a function after a one-line class remains top-level', () => {
    const parsed = parseFile('class Counter { increment() { return 1; } } function outside() { return 2; }', 'counter.js');
    expect(parsed.symbols.map(s => s.name)).toEqual(['Counter', 'outside']);
    expect(parsed.symbols[0].children?.map(s => s.name)).toEqual(['increment']);
    expect(parsed.symbols[1].kind).toBe('function');
  }, 120000);

  test('nested class methods appear once under their nearest class', () => {
    const parsed = parseFile([
      'class Outer {',
      '  build() {',
      '    class Inner {',
      '      run() { return 1; }',
      '    }',
      '    return Inner;',
      '  }',
      '}',
    ].join('\n'), 'nested.js');
    expect(parsed.symbols.map(s => s.name)).toEqual(['Outer']);
    const outer = parsed.symbols[0];
    expect(outer.children?.map(s => s.name)).toEqual(['build', 'Inner']);
    const inner = outer.children?.find(s => s.name === 'Inner');
    expect(inner?.children?.map(s => s.name)).toEqual(['run']);
    expect(formatFoldedView(parsed).match(/ƒ run/g)?.length).toBe(1);
  }, 120000);

  test('ordinary multiline classes and top-level functions retain their ownership', () => {
    const parsed = parseFile('class Counter {\n  increment() { return 1; }\n}\nfunction outside() { return 2; }', 'counter.js');
    expect(parsed.symbols.map(s => s.name)).toEqual(['Counter', 'outside']);
    expect(parsed.symbols[0].children?.map(s => s.name)).toEqual(['increment']);
  }, 120000);
});
