import { describe, expect } from 'bun:test';
import { nativeTest } from './native-prerequisite.js';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';

// Every line inside a /* ... */ block is comment text, so the whole block is
// the doc comment of the declaration below it, whatever its lines start with.
describe('block comments as doc comments', () => {
  nativeTest('a # line inside a block comment stays part of the comment', () => {
    const source = '/**\n# Adds two numbers.\n*/\nint add(int a, int b) { return a + b; }\n';
    const [add] = parseFile(source, 'add.c').symbols;
    expect(add?.jsdoc).toBe('/**\n# Adds two numbers.\n*/');
  }, 120000);

  nativeTest('a block comment with bare text and @ lines is kept whole', () => {
    const source = '/**\n Adds.\n @deprecated use sum\n*/\npublic class A {}\n';
    const [a] = parseFile(source, 'A.java').symbols;
    expect(a?.jsdoc).toBe('/**\n Adds.\n @deprecated use sum\n*/');
  }, 120000);

  nativeTest('a // line ending in */ does not open a block comment', () => {
    const source = 'static int x = 1;\n// Matches /a*/\nint f(void) { return 0; }\n';
    const f = parseFile(source, 'f.c').symbols.find(s => s.name === 'f');
    expect(f?.jsdoc).toBe('// Matches /a*/');
  }, 120000);

  nativeTest('a # line ending in */ does not open a block comment', () => {
    const source = 'x = 1\n# Matches a*/\ndef f():\n    return 0\n';
    const f = parseFile(source, 'f.py').symbols.find(s => s.name === 'f');
    expect(f?.jsdoc).toBe('# Matches a*/');
  }, 120000);

  nativeTest('a real comment above a function is still found', () => {
    const source = '#include <stdio.h>\n\n// Adds two numbers.\nint add(int a, int b) { return a + b; }\n';
    const [add] = parseFile(source, 'add.c').symbols;
    expect(add?.jsdoc).toBe('// Adds two numbers.');
  }, 120000);

  nativeTest('a # comment above a Python function is still found', () => {
    const source = '# Adds two numbers.\ndef add(a, b):\n    return a + b\n';
    const [add] = parseFile(source, 'add.py').symbols;
    expect(add?.jsdoc).toBe('# Adds two numbers.');
  }, 120000);
});
