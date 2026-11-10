import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';

const source = [
  'package store',
  '',
  'type Store struct{ items map[string]int }',
  '',
  '// Handler handles a request.',
  'type Handler = func(name string) error',
  '',
  'type Set[T comparable] = map[T]struct{}',
  '',
  'func (s *Store) Get(k string) int { return s.items[k] }',
].join('\n');
const filename = 'store.go';

describe('go-type-aliases', () => {
  test('a type alias is a type in the outline', () => {
    const file = parseFile(source, filename);
    expect(file.symbols.map(s => [s.name, s.kind])).toEqual([
      ['Store', 'type'], ['Handler', 'type'], ['Set', 'type'], ['Store.Get', 'method'],
    ]);
    expect(file.symbols[1].signature).toBe('type Handler = func(name string) error');
    expect(file.symbols[1].jsdoc).toBe('// Handler handles a request.');
    expect(file.symbols[2].signature).toBe('type Set[T comparable] = map[T]struct');
  }, 120000);
});
