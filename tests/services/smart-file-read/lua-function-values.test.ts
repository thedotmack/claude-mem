import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
const source = "local handler = function(value)\n return value + 1\nend\nService.render = function()\n return \"ok\"\nend\nlocal function ordinary() return 1 end\n";
const filename = "callbacks.lua";
describe("lua-function-values", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['handler', 'Service.render', 'ordinary']);
  expect(formatFoldedView(file)).toContain("render");
 }, 120000);
});

test('does not assign a function value to the wrong member of a multiple assignment', () => {
 const source = 'local first, second = 1, function() return 2 end\nlocal third, fourth = function() return 3 end, 4\nlocal valid = function() return 5 end';
 expect(parseFile(source, 'multiple.lua').symbols.map(s => s.name)).toEqual(['valid']);
}, 120000);
