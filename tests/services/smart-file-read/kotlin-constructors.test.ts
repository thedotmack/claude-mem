import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
const source = "class Widget {\n constructor(size: Int) { println(size) }\n constructor(label: String) { println(label) }\n fun render() {}\n}\n";
const filename = "constructors.kt";
describe("kotlin-constructors", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(s => s.name)).toEqual(['constructor(size: Int)', 'constructor(label: String)', 'render']);
  expect(formatFoldedView(file)).toContain("constructor(label");
 }, 120000);
});

test('preserves multiline parameters and constructor delegation', () => {
 const source = 'class Widget(val size: Int) {\n constructor(\n label: String,\n extra: Int\n ) : this(extra) { println(label) }\n}';
 expect(parseFile(source, 'delegation.kt').symbols[0].children?.map(s => s.name)).toEqual(['constructor( label: String, extra: Int )']);
 expect(unfoldSymbol(source, 'delegation.kt', 'Widget.constructor( label: String, extra: Int )')).toContain('this(extra)');
}, 120000);
