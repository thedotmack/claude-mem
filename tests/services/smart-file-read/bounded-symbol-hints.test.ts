import { expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseFile, formatAvailableSymbols } from '../../../src/services/smart-file-read/parser.js';

const crowded = 'class C0 {\n' + Array.from({ length: 50 }, (_, i) => ` m${i}() { return ${i}; }\n`).join('')
 + '}\n' + Array.from({ length: 199 }, (_, i) => `class C${i + 1} {}\n`).join('');

const source = Array.from({ length: 100 }, (_, owner) => `class Owner${owner} {\n`
 + Array.from({ length: 25 }, (_, method) => ` method${method}() { return ${method}; }\n`).join('') + '}\n').join('')
 + 'function finalEntryPoint() { return 42; }\n';

const hintCapBytes = 1024;
const marker = '  ... more symbols omitted; use smart_search to narrow the lookup.';

test('native large-file hints stay within 1 KiB and lead with names like the missed one', () => {
 const file = parseFile(source, 'Hints.ts');
 // The 101 roots alone overflow the budget, so ranking is what keeps the late root.
 const lateRoot = formatAvailableSymbols(file, 'finalEntry');
 expect(Buffer.byteLength(lateRoot)).toBeLessThanOrEqual(hintCapBytes);
 expect(lateRoot.split('\n')[0]).toBe('  - finalEntryPoint (function)');
 expect(lateRoot.endsWith(marker)).toBe(true);
 const wrongOwner = formatAvailableSymbols(file, 'Missing.method0');
 expect(Buffer.byteLength(wrongOwner)).toBeLessThanOrEqual(hintCapBytes);
 expect(wrongOwner.split('\n').slice(0, 2)).toEqual(['  - Owner0.method0 (method)', '  - Owner1.method0 (method)']);
}, 120000);

test('real MCP failed lookups return a 1 KiB hint with the likely correction and retain qualified unfold', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'cm-bounded-mcp-hints-'));
 const client = new Client({ name: 'owned-native-hint-test', version: '1.0.0' }, { capabilities: {} });
 const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dir, '../../../src/servers/mcp-server.ts')],
  cwd: dir,
  env: { ...process.env as Record<string, string>, HOME: dir, USERPROFILE: dir,
   CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_TELEMETRY_ENABLED: 'false' },
  stderr: 'pipe',
 });
 const textOf = (result: Awaited<ReturnType<typeof client.callTool>>) =>
  (result.content as Array<{ type: string; text: string }>).find(item => item.type === 'text')!.text;
 try {
  writeFileSync(join(dir, 'Hints.ts'), source);
  await client.connect(transport);
  const missing = textOf(await client.callTool({ name: 'smart_unfold', arguments: { file_path: 'Hints.ts', symbol_name: 'Missing.method0' } }));
  // The hint plus the one-line "not found" header.
  expect(Buffer.byteLength(missing)).toBeLessThan(hintCapBytes + 128);
  expect(missing).toContain('Available symbols:\n  - Owner0.method0 (method)\n  - Owner1.method0 (method)\n');
  const found = textOf(await client.callTool({ name: 'smart_unfold', arguments: { file_path: 'Hints.ts', symbol_name: 'Owner1.method0' } }));
  expect(found).toContain('method0() { return 0; }');
  writeFileSync(join(dir, 'Crowded.ts'), crowded);
  const crowdedMiss = textOf(await client.callTool({ name: 'smart_unfold', arguments: { file_path: 'Crowded.ts', symbol_name: 'C199.render' } }));
  expect(Buffer.byteLength(crowdedMiss)).toBeLessThan(hintCapBytes + 128);
  expect(crowdedMiss).toContain('Available symbols:\n  - C199 (class)\n');
 } finally { await client.close(); await transport.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('native hints rank a qualified method or a late root first alongside 200 or more roots', () => {
 for (const count of [200, 205]) {
  const source = 'class C0 { run() { return 0; } }\n'
   + Array.from({ length: count - 1 }, (_, i) => `class C${i + 1} {}\n`).join('');
  const file = parseFile(source, 'Crowded.ts');
  for (const [missedName, firstLine] of [['Missing.run', '  - C0.run (method)'], [`C${count - 1}.render`, `  - C${count - 1} (class)`]]) {
   const hint = formatAvailableSymbols(file, missedName);
   expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(hintCapBytes);
   expect(hint.split('\n')[0]).toBe(firstLine);
  }
 }
}, 120000);

test('a miss that resembles nothing lists roots in file order within 1 KiB', () => {
 const hint = formatAvailableSymbols(parseFile(crowded, 'Crowded.ts'), 'missing');
 expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(hintCapBytes);
 expect(hint.split('\n').slice(0, 3)).toEqual(['  - C0 (class)', '  - C1 (class)', '  - C2 (class)']);
 expect(hint.endsWith(marker)).toBe(true);
}, 120000);
