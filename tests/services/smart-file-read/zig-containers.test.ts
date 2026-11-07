import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const source = [
  'const std = @import("std");',
  '',
  '/// A point in the plane.',
  'pub const Point = struct {',
  '    x: f32,',
  '    y: f32,',
  '',
  '    pub fn add(self: Point, other: Point) Point {',
  '        return .{ .x = self.x + other.x, .y = self.y + other.y };',
  '    }',
  '};',
  '',
  'pub const Color = enum { red, green, blue };',
  '',
  'const Shape = union(enum) {',
  '    circle: f32,',
  '',
  '    fn area(self: Shape) f32 {',
  '        return switch (self) {',
  '            .circle => |r| 3.14 * r * r,',
  '        };',
  '    }',
  '};',
  '',
  'pub fn main() void {}',
].join('\n');
const filename = 'shapes.zig';

describe('zig-containers', () => {
  test('a struct, enum or union declaration owns the functions it declares', () => {
    const file = parseFile(source, filename);
    expect(file.symbols.map(s => [s.name, s.kind])).toEqual([
      ['Point', 'class'], ['Color', 'class'], ['Shape', 'class'], ['main', 'function'],
    ]);
    expect(file.symbols[0].signature).toBe('pub const Point = struct');
    expect(file.symbols[0].jsdoc).toBe('/// A point in the plane.');
    expect(file.symbols[0].children?.map(s => [s.name, s.kind])).toEqual([['add', 'method']]);
    expect(file.symbols[2].children?.map(s => s.name)).toEqual(['area']);
  }, 120000);

  test('search and unfold address a container function through its type', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-zig-containers-'));
    try {
      writeFileSync(join(dir, filename), source);
      const result = await searchCodebase(dir, 'area');
      expect(result.matchingSymbols.map(s => s.symbolName)).toEqual(['Shape.area']);
      expect(unfoldSymbol(source, filename, 'Point.add')).toContain('self.x + other.x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
