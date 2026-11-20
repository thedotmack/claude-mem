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
  test('Ruby signatures end after the parameters, the superclass or the name', () => {
    const source = [
      'class User < ApplicationRecord',
      '  def initialize(name,',
      '                 currency = "(")',
      '    @attrs = { name: name }',
      '  end',
      '',
      '  def each_name # yields each name',
      '    names.each { |n| yield n }',
      '  end',
      '',
      '  def to_json(*args)',
      '    logger.info("serializing #{id}")',
      '  end',
      'end',
    ].join('\n');
    expect(signatures(source, 'user.rb')).toEqual({
      User: 'class User < ApplicationRecord',
      initialize: 'def initialize(name, currency = "(")',
      each_name: 'def each_name',
      to_json: 'def to_json(*args)',
    });
  }, 120000);

  test('Lua signatures end after the parameters', () => {
    const source = [
      'local function build(name,',
      '                     size)',
      '  local t = { name = name, size = size }',
      '  return t',
      'end',
      '',
      'M.render = function(items)',
      '  return { items = items }',
      'end',
    ].join('\n');
    expect(signatures(source, 'build.lua')).toEqual({
      build: 'local function build(name, size)',
      'M.render': 'M.render = function(items)',
    });
  }, 120000);

  test('Python signatures end after the parameters, the return type or the superclasses', () => {
    const source = [
      'class Config(',
      '    Base,',
      '    metaclass=Meta,',
      '):',
      '    def make(',
      '        self,',
      '        sep: str = ":",',
      '    ) -> dict[str, int]:',
      '        return {"sep": sep}',
      '',
      '    def one(self): return {}',
      '',
      'class Stack[T]:',
      '    def first[U](self, items: list[U]) -> U:',
      '        return items[0]',
    ].join('\n');
    expect(signatures(source, 'config.py')).toEqual({
      Config: 'class Config( Base, metaclass=Meta, )',
      make: 'def make( self, sep: str = ":", ) -> dict[str, int]',
      one: 'def one(self)',
      Stack: 'class Stack[T]',
      first: 'def first[U](self, items: list[U]) -> U',
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
    // The parse tree knows where a regexp ends, with an escaped `(` or an unescaped one.
    expect(signatures(source, 'match.rb')).toEqual({
      match: 'def match(pattern = /\\(/)',
      bracket: 'def bracket(pattern = /[(]/)',
    });
  }, 120000);
});
