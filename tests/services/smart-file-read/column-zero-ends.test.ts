import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';

describe('symbols that end where the next line starts', () => {
  test('a TOML table ends before the next table header', () => {
    const source = '[server]\nhost = "a"\nport = 1\n\n[db]\nurl = "b"\n';
    const file = parseFile(source, 'conf.toml');

    expect(file.symbols.map(s => [s.name, s.lineStart, s.lineEnd])).toEqual([['server', 0, 3], ['db', 4, 5]]);
    expect(unfoldSymbol(source, 'conf.toml', 'server')).not.toContain('[db]');
    expect(unfoldSymbol(source, 'conf.toml', 'server')).toContain('port = 1');
  }, 120000);

  test('an indented Scala 3 class ends before the next top-level definition', () => {
    const source = 'class Counter(start: Int):\n  def next: Int = start + 1\n\ndef topLevel(x: Int): Int = x + 1\n';
    const file = parseFile(source, 'Counter.scala');

    expect(file.symbols.map(s => [s.name, s.lineStart, s.lineEnd])).toEqual([['Counter', 0, 2], ['topLevel', 3, 3]]);
    expect(unfoldSymbol(source, 'Counter.scala', 'Counter')).not.toContain('def topLevel');
  }, 120000);
});
