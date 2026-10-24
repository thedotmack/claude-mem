#!/usr/bin/env bun
import { resolve } from 'node:path';
import { backupPersonalInstall } from '../src/npx-cli/install/personal-backup.js';
import { CLAUDE_CONFIG_DIR, DATA_DIR } from '../src/shared/paths.js';

const root = resolve(import.meta.dir, '..');
function run(args: string[]): void {
  const result = Bun.spawnSync([process.execPath, ...args], { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
}

// Never fetch a branch or latest npm release. Build only this reviewed checkout.
run(['install', '--frozen-lockfile', '--ignore-scripts']);
run(['run', 'build']);
const backup = backupPersonalInstall(DATA_DIR, CLAUDE_CONFIG_DIR);
console.log(`Private pre-install backup: ${backup}`);
// The installer drains/stops the old worker before copying. Non-TTY runs leave
// startup to the next Claude session; --no-auto-start makes that explicit.
run([resolve(root, 'dist/npx-cli/index.js'), 'install', '--ide', 'claude-code', '--provider', 'claude', '--no-auto-start']);
