import { expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseFile, formatAvailableSymbols } from '../../../src/services/smart-file-read/parser.js';

const source = Array.from({ length: 100 }, (_, owner) => `class Owner${owner} {\n`
 + Array.from({ length: 25 }, (_, method) => ` method${method}() { return ${method}; }\n`).join('') + '}\n').join('')
 + 'function finalEntryPoint() { return 42; }\n';

test('native large-file hints are bounded and retain late root and qualified children', () => {
 const hint = formatAvailableSymbols(parseFile(source, 'Hints.ts'));
 expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(4096);
 expect(hint).toContain('finalEntryPoint (function)');
 expect(hint).toContain('Owner0.method0 (method)');
 expect(hint).toContain('Owner1.method0 (method)');
 expect(hint).toContain('more symbols omitted');
}, 120000);

test('real MCP failed lookups return bounded useful hints and retain qualified unfold', async () => {
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
 try {
  writeFileSync(join(dir, 'Hints.ts'), source);
  await client.connect(transport);
  const missing = await client.callTool({ name: 'smart_unfold', arguments: { file_path: 'Hints.ts', symbol_name: 'missing' } });
  const text = (missing.content as Array<{ type: string; text: string }>).find(item => item.type === 'text')!.text;
  expect(Buffer.byteLength(text)).toBeLessThan(4300);
  expect(text).toContain('finalEntryPoint (function)');
  expect(text).toContain('Owner1.method0 (method)');
  const found = await client.callTool({ name: 'smart_unfold', arguments: { file_path: 'Hints.ts', symbol_name: 'Owner1.method0' } });
  const body = (found.content as Array<{ type: string; text: string }>).find(item => item.type === 'text')!.text;
  expect(body).toContain('method0() { return 0; }');
 } finally { await client.close(); await transport.close(); rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('native hints reserve qualified methods when roots exceed the visit limit', () => {
 for (const count of [200, 205]) {
  const source = 'class C0 { run() { return 0; } }\n'
   + Array.from({ length: count - 1 }, (_, i) => `class C${i + 1} {}\n`).join('');
  const hint = formatAvailableSymbols(parseFile(source, 'Crowded.ts'));
  expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(4096);
  expect(hint).toContain('C0.run (method)');
  expect(hint).toContain('C198 (class)');
  expect(hint.split('\n').filter(line => line.startsWith('  - ')).length).toBeLessThanOrEqual(200);
  expect(hint).toContain('more symbols omitted');
 }
}, 120000);
