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

  test('unfolding a grouped type returns that type, not the whole group', () => {
    const unfolded = unfoldSymbol(source, filename, 'Coord');
    expect(unfolded).toContain('Coord = Point');
    expect(unfolded).not.toContain('Point struct');
  }, 120000);
});
