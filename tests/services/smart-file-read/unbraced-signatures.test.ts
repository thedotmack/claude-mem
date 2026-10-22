import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, type CodeSymbol } from '../../../src/services/smart-file-read/parser.js';

// A `{` in a Python, Ruby or Lua body opens a dict, a hash, a block or a table,
// not the body, so it must not end the signature.
function signatures(source: string, file: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (symbols: CodeSymbol[] | undefined) => {
    for (const symbol of symbols ?? []) {
      result[symbol.name] = symbol.signature;
      visit(symbol.children);
    }
  };
  visit(parseFile(source, file).symbols);
  return result;
}

describe('signatures of languages without braced bodies', () => {
  test('Ruby signatures end with the row that closes their brackets', () => {
    const source = [
      'class User',
      '  def initialize(name,',
      '                 currency = "(")',
      '    @attrs = { name: name }',
      '  end',
      '',
      '  def each_name # yields each name',
      '    names.each { |n| yield n }',
      '  end',
      'end',
    ].join('\n');
    expect(signatures(source, 'user.rb')).toEqual({
      User: 'class User',
      initialize: 'def initialize(name, currency = "(")',
      each_name: 'def each_name',
    });
  }, 120000);

  test('Lua signatures end with the row that closes their brackets', () => {
    const source = [
      'local function build(name, -- the name',
      '                     size)',
      '  local t = { name = name, size = size }',
      '  return t',
      'end',
    ].join('\n');
    expect(signatures(source, 'build.lua')).toEqual({ build: 'local function build(name, size)' });
  }, 120000);

  test('Python signatures end at the colon that opens the body', () => {
    const source = [
      'class Config(',
      '    Base,  # the base (abstract',
      '    metaclass=Meta,',
      '):',
      '    def make(',
      '        self,',
      '        sep: str = ":",',
      '    ) -> dict[str, int]:',
      '        return {"sep": sep}',
      '',
      '    def one(self): return {}',
    ].join('\n');
    expect(signatures(source, 'config.py')).toEqual({
      Config: 'class Config( Base, metaclass=Meta, )',
      make: 'def make( self, sep: str = ":", ) -> dict[str, int]',
      one: 'def one(self)',
    });
  }, 120000);

  test('Python triple-quoted defaults do not end a signature, even over rows', () => {
    const source = [
      'def quote(x="""say "): hello"""):',
      '    pass',
      '',
      'def long_default(',
      '    text="""first row (',
      'still in the string: done""",',
      '    flag=True,',
      '):',
      '    pass',
    ].join('\n');
    expect(signatures(source, 'quote.py')).toEqual({
      quote: 'def quote(x="""say "): hello""")',
      long_default: 'def long_default( text="""first row ( still in the string: done""", flag=True, )',
    });
  }, 120000);

  test('a Ruby regexp bracket keeps the body out of the signature', () => {
    const source = [
      'def match(pattern = /\\(/)',
      '  puts pattern',
      'end',
      '',
      'def bracket(pattern = /[(]/)',
      '  puts pattern',
      'end',
    ].join('\n');
    // An escaped `\\(` is no bracket. An unescaped one leaves the brackets open, so
    // the first row stands, as before.
    expect(signatures(source, 'match.rb')).toEqual({
      match: 'def match(pattern = /\\(/)',
      bracket: 'def bracket(pattern = /[(]/)',
    });
  }, 120000);
});
