import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';
const source = "class Widget {\n  \"quoted\"() { return 1; }\n  [\"computed\"]() { return 2; }\n  #private() { return 3; }\n  regular() { return 4; }\n}\n";
const filename = "names.js";
describe("js-method-names", () => {
 test('native outlines retain the declaration and ordinary controls', () => {
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(s => s.name)).toEqual(['"quoted"', '["computed"]', '#private', 'regular']);
  expect(formatFoldedView(file)).toContain("private");
 }, 120000);
 test('batch search supplies a usable unfold identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-js-method-names-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, "private");
   const match = result.matchingSymbols.find(s => s.symbolName === "Widget.#private");
   expect(match).toBeDefined();

   expect(unfoldSymbol(source, filename, match!.symbolName)).toContain("return 3;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
});

test('retains the same legal method names under the TypeScript grammar', () => {
 expect(parseFile(source, 'names.ts').symbols[0].children?.map(s => s.name)).toEqual(['"quoted"', '["computed"]', '#private', 'regular']);
}, 120000);

for (const filename of ['multiline.js', 'multiline.ts', 'multiline.tsx']) {
 test(`multiline computed method names retain unique search and unfold identities in ${filename}`, async () => {
  const source = 'class Widget {\n [\n "first"\n ]() { return "first body"; }\n [\n "second"\n ]() { return "second body"; }\n}';
  const file = parseFile(source, filename);
  expect(file.symbols[0].children?.map(symbol => symbol.name)).toEqual(['[\n "first"\n ]', '[\n "second"\n ]']);
  const dir = mkdtempSync(join(tmpdir(), 'cm-computed-multiline-'));
  try {
   writeFileSync(join(dir, filename), source);
   const result = await searchCodebase(dir, 'second');
   const match = result.matchingSymbols.find(symbol => symbol.symbolName === 'Widget.[\n "second"\n ]');
   expect(match).toBeDefined();
   const unfolded = unfoldSymbol(source, filename, match!.symbolName)!;
   expect(unfolded).toContain('return "second body";');
   expect(unfolded).not.toContain('return "first body";');
  } finally { rmSync(dir, { recursive: true, force: true }); }
 }, 120000);
}

test('multiline computed string keys preserve literal whitespace in search and unfold identities', async () => {
 const source = 'class Widget {\n [\n "a  b"\n ]() { return "double space"; }\n [\n "a b"\n ]() { return "single space"; }\n}';
 const filename = 'literal-spaces.js';
 const names = parseFile(source, filename).symbols[0].children!.map(symbol => symbol.name);
 expect(new Set(names).size).toBe(2);
 const dir = mkdtempSync(join(tmpdir(), 'cm-computed-literal-spaces-'));
 try {
  writeFileSync(join(dir, filename), source);
  for (const [key, body, other] of [['a  b', 'double space', 'single space'], ['a b', 'single space', 'double space']]) {
   const match = (await searchCodebase(dir, key)).matchingSymbols.find(symbol => symbol.symbolName.includes(`"${key}"`));
   expect(match).toBeDefined();
   const unfolded = unfoldSymbol(source, filename, match!.symbolName)!;
   expect(unfolded).toContain(`return "${body}";`);
   expect(unfolded).not.toContain(`return "${other}";`);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('folded method headers escape newlines without changing lookup identities', () => {
 const source = 'class Widget {\n [\n "a  b"\n ]() { return "double space"; }\n}';
 const file = parseFile(source, 'header.js');
 const symbol = file.symbols[0].children![0];
 expect(symbol.name).toBe('[\n "a  b"\n ]');
 const header = formatFoldedView(file).split('\n').find(line => line.includes(JSON.stringify(symbol.name)));
 expect(header).toBeDefined();
 expect(header).toContain('(L2-4)');
 expect(unfoldSymbol(source, 'header.js', `Widget.${symbol.name}`)).toContain('return "double space"');
}, 120000);


test('copied native outline aliases unfold through MCP without changing raw identities', async () => {
 const source = 'class Widget {\n [`a\nb`]() { return "newline body"; }\n [`a\\nb`]() { return "literal body"; }\n}';
 const filename = 'aliases.js';
 const file = parseFile(source, filename);
 const outline = formatFoldedView(file);
 const dir = mkdtempSync(join(tmpdir(), 'cm-display-alias-mcp-'));
 const client = new Client({ name: 'native-display-alias-test', version: '1.0.0' }, { capabilities: {} });
 const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(import.meta.dir, '../../../src/servers/mcp-server.ts')], cwd: dir,
  env: { ...process.env as Record<string, string>, HOME: dir, USERPROFILE: dir,
   CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_TELEMETRY_ENABLED: 'false' }, stderr: 'pipe' });
 try {
  writeFileSync(join(dir, filename), source);
  await client.connect(transport);
  for (const [index, body, other] of [[0, 'newline body', 'literal body'], [1, 'literal body', 'newline body']] as const) {
   const symbol = file.symbols[0].children![index];
   const header = outline.split('\n').filter(line => /^\s*ƒ /.test(line))[index];
   const displayed = header?.match(/^\s*ƒ (.*?) \(L/)?.[1];
   expect(displayed).toBeDefined();
   const response = await client.callTool({ name: 'smart_unfold', arguments: { file_path: filename, symbol_name: displayed! } });
   const text = (response.content as Array<{ type: string; text: string }>).find(item => item.type === 'text')!.text;
   expect(text).toContain(body);
   expect(text).not.toContain(other);
   const local = unfoldSymbol(source, filename, displayed!)!;
   expect(local).toContain(body);
   expect(local).not.toContain(other);
   expect(unfoldSymbol(source, filename, `Widget.${symbol.name}`)).toContain(body);
   expect(unfoldSymbol(source, filename, symbol.name)).toContain(body);
   const search = await searchCodebase(dir, 'a');
   expect(search.matchingSymbols.some(match => match.symbolName === `Widget.${symbol.name}`)).toBe(true);

  }
  const name = file.symbols[0].children![0].name;
  const duplicate = `class First { ${name}() { return "first"; } }\nclass Second { ${name}() { return "second"; } }`;
  expect(unfoldSymbol(duplicate, filename, JSON.stringify(name))).toBeNull();
  expect(unfoldSymbol(duplicate, filename, JSON.stringify(`Second.${name}`))).toContain('return "second"');
 } finally { await client.close(); await transport.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120000);
