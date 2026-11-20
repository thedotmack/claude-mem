import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
const source = "@configure(\n value=1,\n)\ndef answer():\n return 42\n";
const filename = "decorated.py";
describe("python-decorator-ranges", () => {
 test('reproduces the native production behavior', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['answer']); expect(unfoldSymbol(source, filename, 'answer')).toContain('@configure(\n value=1,\n)');
 }, 120000);
});

test('preserves stacked class and method decorators without changing plain definitions', () => {
 const source = '@outer(\n  value=1,\n)\n@inner\nclass Service:\n @staticmethod\n @configure(\n  flag=True,\n )\n def run():\n  return "owned"\n\ndef plain():\n return "plain"';
 const file = parseFile(source, 'stacked.py');
 expect(file.symbols.map(s => s.name)).toEqual(['Service', 'plain']);
 expect(file.symbols[0].lineStart).toBe(0);
 expect(file.symbols[0].children?.[0].lineStart).toBe(5);
 expect(unfoldSymbol(source, 'stacked.py', 'Service.run')).toContain('@staticmethod\n @configure(');
 expect(unfoldSymbol(source, 'stacked.py', 'Service.run')).not.toContain('@outer');
 expect(unfoldSymbol(source, 'stacked.py', 'plain')).toContain('return "plain"');
}, 120000);
