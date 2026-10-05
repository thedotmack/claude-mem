import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "struct Widget {\n init(size: Int) { print(size) }\n init(label: String) { print(label) }\n func render() {}\n}\nclass Service {\n deinit { print(\"done\") }\n}\n";
const filename = "lifecycle.swift";
describe("swift-initializers", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(s => s.name)).toEqual(['init(size: Int)', 'init(label: String)', 'render']); expect(file.symbols[1].children?.map(s => s.name)).toEqual(['deinit']);
  expect(formatFoldedView(file)).toContain("init(label");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-swift-initializers-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "init(label");
   const match = result.matchingSymbols.find(s => s.symbolName === "Widget.init(label: String)");
   expect(match).toBeDefined();

   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("print(label)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('initializer identities use native parameters despite modifiers and default closures', () => {
 const source = 'class Widget {\n public convenience init<T>(value: T, other: Int = 3) { self.init(size: other) }\n init?(size: Int) { print(size) }\n init(callback: () -> Int = { return 1 }) { print(callback()) }\n init() { print("empty") }\n}';
 expect(parseFile(source, 'parameters.swift').symbols[0].children?.map(s => s.name)).toEqual(['init(value: T, other: Int)', 'init(size: Int)', 'init(callback: () -> Int)', 'init()']);
}, 120000);
