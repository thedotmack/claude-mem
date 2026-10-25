import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';

const source = [
  'package geo',
  '',
  '// Single is one struct.',
  'type Single struct{ A int }',
  '',
  'type (',
  '\t// Point is a 2D point.',
  '\tPoint struct{ X, Y int }',
  '\t// Coord names a point.',
  '\tCoord = Point',
  ')',
].join('\n');
const filename = 'geo.go';

describe('go-grouped-types', () => {
  test('each type in a grouped declaration has its own line, signature and comment', () => {
    const file = parseFile(source, filename);
    expect(file.symbols.map(s => [s.name, s.kind, s.lineStart])).toEqual([
      ['Single', 'type', 3], ['Point', 'type', 7], ['Coord', 'type', 9],
    ]);
    expect(file.symbols.map(s => s.signature)).toEqual([
      'type Single struct', 'Point struct', 'Coord = Point',
    ]);
    expect(file.symbols.map(s => s.jsdoc)).toEqual([
      '// Single is one struct.', '// Point is a 2D point.', '// Coord names a point.',
    ]);
  }, 120000);

  test('the first type or alias of a group without comments is listed once, as itself', () => {
    const bare = [
      'package geo', '', 'type (', '\tA int', '\tB = A', ')', '', 'type (', '\tC = A', '\tD string', ')',
    ].join('\n');
    const file = parseFile(bare, filename);
    expect(file.symbols.map(s => [s.name, s.lineStart, s.lineEnd])).toEqual([
      ['A', 3, 3], ['B', 4, 4], ['C', 8, 8], ['D', 9, 9],
    ]);
    expect(unfoldSymbol(bare, filename, 'A')).not.toContain('B = A');
    expect(unfoldSymbol(bare, filename, 'C')).not.toContain('D string');
  }, 120000);

  test('a comment between `type` and `(` still lists each member once, as itself', () => {
    const commented = ['package geo', '', 'type /* g */ (', '\tA int', '\tB string', ')'].join('\n');
    const file = parseFile(commented, filename);
    expect(file.symbols.map(s => [s.name, s.lineStart, s.lineEnd])).toEqual([
      ['A', 3, 3], ['B', 4, 4],
    ]);
    expect(unfoldSymbol(commented, filename, 'A')).not.toContain('B string');
  }, 120000);

  test('unfolding a grouped type returns that type, not the whole group', () => {
    const unfolded = unfoldSymbol(source, filename, 'Coord');
    expect(unfolded).toContain('Coord = Point');
    expect(unfolded).not.toContain('Point struct');
  }, 120000);
});
