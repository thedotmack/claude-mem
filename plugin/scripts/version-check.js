#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {}
  return null;
}

const ROOT = resolveRoot();
if (!ROOT) process.exit(0);

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const markerPath = join(ROOT, '.install-version');
  if (!existsSync(markerPath)) {
    console.error('claude-mem: runtime not yet set up — run: npx claude-mem repair');
    process.exit(0);
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
  if (marker.version !== pkg.version) {
    console.error(`claude-mem: upgraded to v${pkg.version} — run: npx claude-mem repair`);
  }
} catch {
  console.error('claude-mem: install marker unreadable — run: npx claude-mem repair');
}
process.exit(0);
