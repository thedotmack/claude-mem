import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureCursorMcp, registerCursorProject } from '../src/utils/cursor-utils';

function withFile(run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-bom-'));
  try { run(join(dir, 'config.json')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('adding Cursor MCP preserves existing BOM-prefixed configuration', () => withFile(file => {
  const existing = { mcpServers: { other: { command: 'node', args: ['other.cjs'] } }, custom: true };
  writeFileSync(file, '\uFEFF' + JSON.stringify(existing));
  configureCursorMcp(file, '/claude-mem.cjs');
  const result = JSON.parse(readFileSync(file, 'utf8'));
  expect(result.mcpServers.other).toEqual(existing.mcpServers.other);
  expect(result.custom).toBe(true);
  expect(result.mcpServers['claude-mem'].args).toEqual(['/claude-mem.cjs']);
}));

test('registering a workspace preserves BOM-prefixed existing registrations', () => withFile(file => {
  const existing = { old: { workspacePath: '/old', installedAt: '2026-01-01T00:00:00Z' } };
  writeFileSync(file, '\uFEFF' + JSON.stringify(existing));
  registerCursorProject(file, 'new', '/new');
  const result = JSON.parse(readFileSync(file, 'utf8'));
  expect(result.old).toEqual(existing.old);
  expect(result.new.workspacePath).toBe('/new');
}));
