#!/usr/bin/env bun
// claude-mem tree-sitter setup helper.
// Run once after plugin install (or on demand) to populate node_modules
// so smart_search / smart_outline / smart_unfold actually work.
// Spec: docs/04-tdd-implementation-plan.md Phase 6.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN = process.env.PLUGIN_ROOT
  || process.env.CLAUDE_PLUGIN_ROOT
  || `${process.env.HOME}/.claude/plugins/cache/thedotmack/claude-mem/13.3.0`;

const PKG = join(PLUGIN, 'package.json');
const NM = join(PLUGIN, 'node_modules');
const NM_TS = join(NM, 'tree-sitter');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

function out(msg) { process.stdout.write(msg + '\n'); }
function err(msg) { process.stderr.write(msg + '\n'); }

if (!existsSync(PKG)) {
  err(`[setup-tree-sitter] plugin not found at ${PLUGIN}`);
  process.exit(2);
}

if (existsSync(NM) && existsSync(NM_TS) && !FORCE) {
  out(`[setup-tree-sitter] tree-sitter deps already installed at ${NM_TS}.`);
  process.exit(0);
}

out(`[setup-tree-sitter] tree-sitter deps missing under ${NM}.`);
out(`[setup-tree-sitter] ${DRY ? 'Would install' : 'Installing'} via "npm install --no-audit --no-fund --silent" in ${PLUGIN}`);

if (DRY) process.exit(0);

const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent'], {
  cwd: PLUGIN,
  stdio: 'inherit',
  timeout: 600_000, // 10 min budget for native builds
});

if (r.error) {
  err(`[setup-tree-sitter] npm failed: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) {
  err(`[setup-tree-sitter] npm exited with ${r.status}`);
  process.exit(r.status ?? 1);
}

if (!existsSync(NM_TS)) {
  err('[setup-tree-sitter] install completed but tree-sitter still not present');
  process.exit(3);
}

out('[setup-tree-sitter] OK — tree-sitter installed.');
