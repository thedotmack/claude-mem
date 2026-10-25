import { describe, expect } from 'bun:test';
import { nativeTest } from './native-prerequisite.js';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';

// In C and C++ a line starting with `#` is a preprocessor directive, not a
// comment, so it must not become the doc comment of the declaration below it.
describe('C and C++ doc comments above preprocessor lines', () => {
  nativeTest('an include directly above a function is not its comment', () => {
    for (const extension of ['c', 'cpp']) {
      const source = '#include <stdio.h>\nint main(void) {\n  return 0;\n}\n';
      const [main] = parseFile(source, `main.${extension}`).symbols;
      expect(main?.name).toBe('main');
      expect(main?.jsdoc).toBeUndefined();
    }
  }, 120000);

  nativeTest('a conditional directive is not read as the comment of a guarded function', () => {
    const source = '#ifdef FAST\nstatic int add(int a, int b) { return a + b; }\n#endif\n';
    const [add] = parseFile(source, 'add.c').symbols;
    expect(add?.name).toBe('add');
    expect(add?.jsdoc).toBeUndefined();
  }, 120000);

  nativeTest('a real comment above a function is still found', () => {
    const source = '#include <stdio.h>\n\n// Adds two numbers.\nint add(int a, int b) { return a + b; }\n';
    const [add] = parseFile(source, 'add.c').symbols;
    expect(add?.jsdoc).toBe('// Adds two numbers.');
  }, 120000);

  nativeTest('a # line inside a block comment stays part of the comment', () => {
    const source = '/**\n# Adds two numbers.\n*/\nint add(int a, int b) { return a + b; }\n';
    const [add] = parseFile(source, 'add.c').symbols;
    expect(add?.jsdoc).toBe('/**\n# Adds two numbers.\n*/');
  }, 120000);

  nativeTest('a # comment above a Python function is still found', () => {
    const source = '# Adds two numbers.\ndef add(a, b):\n    return a + b\n';
    const [add] = parseFile(source, 'add.py').symbols;
    expect(add?.jsdoc).toBe('# Adds two numbers.');
  }, 120000);
});
