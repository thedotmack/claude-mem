import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SETUP = join(import.meta.dir, '..', 'src', 'setup-tree-sitter.mjs');

test('--dry-run detects missing node_modules', () => {
  const r = spawnSync('bun', [SETUP, '--dry-run'], {
    encoding: 'utf-8',
    env: { ...process.env, PLUGIN_ROOT: '/Users/rob/.claude/plugins/cache/thedotmack/claude-mem/13.3.0' },
  });
  // Either already-installed (exit 0, "already installed") or would-install (exit 0, "Would install")
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/already installed|Would install|missing/i);
});

test('exits with code 2 on missing plugin path', () => {
  const r = spawnSync('bun', [SETUP, '--dry-run'], {
    encoding: 'utf-8',
    env: { ...process.env, PLUGIN_ROOT: '/tmp/__nonexistent_plugin__' },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/plugin not found/i);
});
