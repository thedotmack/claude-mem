// Shared path resolvers for claude-mem hook-perf-patch v2.
// Spec: docs/sprint2/07-tdd-plan-v2.md Phase 0.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
export const DEFAULT_SOCK = join(DATA_DIR, 'daemon.sock');
export const DEFAULT_LOCK = join(DATA_DIR, 'daemon.lock');
export const DB_PATH = join(DATA_DIR, 'claude-mem.db');
export const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

// Resolve plugin cache root by globbing versions and picking the highest semver.
// Replaces hard-coded `13.3.0` strings in setup-tree-sitter.mjs + install.sh.
export function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  if (process.env.PLUGIN_ROOT) return process.env.PLUGIN_ROOT;
  const cache = join(homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  if (!existsSync(cache)) return null;
  const versions = readdirSync(cache)
    .filter(d => /^\d+\.\d+\.\d+/.test(d))
    .filter(d => statSync(join(cache, d)).isDirectory())
    .sort(semverCompare);
  return versions.length ? join(cache, versions[versions.length - 1]) : null;
}

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
