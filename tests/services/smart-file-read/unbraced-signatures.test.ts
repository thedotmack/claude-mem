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
});
