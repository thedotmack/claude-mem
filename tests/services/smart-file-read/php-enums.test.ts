import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "<?php\nenum Status: string {\n case Ready = \"ready\";\n public function label(): string { return $this->value; }\n}\nclass Plain {}\n";
const filename = "status.php";
describe("php-enums", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols.map(s => s.name)).toEqual(['Status', 'Plain']); expect(file.symbols[0].kind).toBe('enum'); expect(file.symbols[0].children?.map(s => s.name)).toEqual(['label']);
  expect(formatFoldedView(file)).toContain("label");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-php-enums-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "label");
   const match = result.matchingSymbols.find(s => s.symbolName === "Status.label");
   expect(match).toBeDefined();
   
   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("return $this->value;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('distinguishes identical method names on separate PHP enums', () => {
 const source = '<?php\nenum First {\n case One;\n function label() { return "first"; }\n}\nenum Second {\n case Two;\n function label() { return "second"; }\n}';
 expect(parseFile(source, 'enums.php').symbols.map(s => s.children?.map(c => c.name))).toEqual([['label'], ['label']]);
 expect(unfoldSymbol(source, 'enums.php', 'Second.label')).toContain('return "second";');
 expect(unfoldSymbol(source, 'enums.php', 'Second.label')).not.toContain('return "first";');
}, 120000);
