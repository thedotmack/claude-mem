import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';

const cSource = [
  '#include <stdint.h>',
  '',
  'union Value { int32_t i; float f; };',
  '',
  'struct Point { int x; int y; };',
  '',
  'int main(void) { union Value v = { .i = 1 }; return v.i; }',
].join('\n');

const cppSource = [
  'namespace geo {',
  'union Bits { unsigned u; float f; };',
  'struct Box { int v; };',
  '}',
].join('\n');

describe('c-unions', () => {
  test('a C union is a struct in the outline', () => {
    const file = parseFile(cSource, 'value.c');
    expect(file.symbols.map(s => [s.name, s.kind])).toEqual([
      ['Value', 'struct'], ['Point', 'struct'], ['main', 'function'],
    ]);
    expect(file.symbols[0].signature).toBe('union Value');
  }, 120000);

  test('a C++ union is a struct in its namespace', () => {
    const file = parseFile(cppSource, 'bits.cpp');
    expect(file.symbols.map(s => [s.name, s.kind])).toEqual([['geo', 'namespace']]);
    expect(file.symbols[0].children?.map(s => [s.name, s.kind])).toEqual([
      ['Bits', 'struct'], ['Box', 'struct'],
    ]);
  }, 120000);
});
