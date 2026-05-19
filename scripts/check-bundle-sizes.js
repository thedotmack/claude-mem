#!/usr/bin/env node
// Bundle-size canary for claude-mem build outputs.
//
// Fails CI when any bundle exceeds documented thresholds.
// Soft cap: print WARN, exit 0. Hard cap: print FAIL, exit 1.
// Missing bundle: exit 2.
//
// Run AFTER `npm run build` (the bundles must exist).
//
// Thresholds (see Master Plan Section 9 + Appendix B.5):
//   mcp-server.cjs            580 KB soft / 600 KB hard (PR #1645)
//   worker-service.cjs        4 MB soft / 5 MB hard
//   server-beta-service.cjs   2.5 MB soft / 3 MB hard
//   context-generator.cjs     150 KB soft / 200 KB hard

import { statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const KB = 1024;
const MB = 1024 * KB;

const BUNDLES = [
  { path: 'plugin/scripts/mcp-server.cjs',          soft: 580 * KB, hard: 600 * KB },
  { path: 'plugin/scripts/worker-service.cjs',      soft:   4 * MB, hard:   5 * MB },
  { path: 'plugin/scripts/server-beta-service.cjs', soft: 2.5 * MB, hard:   3 * MB },
  { path: 'plugin/scripts/context-generator.cjs',   soft: 150 * KB, hard: 200 * KB },
];

function format(bytes) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${bytes} B`;
}

function pad(str, width) {
  return String(str).padEnd(width);
}

let exitCode = 0;
const rows = [];

console.log('=== Bundle Size Canary ===\n');
console.log('| Bundle                              | Size      | Soft      | Hard      | Headroom  | Status   |');
console.log('|-------------------------------------|-----------|-----------|-----------|-----------|----------|');

for (const { path: relPath, soft, hard } of BUNDLES) {
  const absPath = join(PROJECT_ROOT, relPath);
  const name = relPath.replace('plugin/scripts/', '');

  if (!existsSync(absPath)) {
    console.log(`| ${pad(name, 35)} | ${pad('MISSING', 9)} | ${pad(format(soft), 9)} | ${pad(format(hard), 9)} | ${pad('—', 9)} | MISSING  |`);
    exitCode = Math.max(exitCode, 2);
    continue;
  }

  const size = statSync(absPath).size;
  const headroom = hard - size;

  let status;
  if (size > hard) {
    status = 'FAIL';
    exitCode = Math.max(exitCode, 1);
  } else if (size > soft) {
    status = 'WARN';
  } else {
    status = 'OK';
  }

  console.log(`| ${pad(name, 35)} | ${pad(format(size), 9)} | ${pad(format(soft), 9)} | ${pad(format(hard), 9)} | ${pad(format(headroom), 9)} | ${pad(status, 8)} |`);
}

console.log();

if (exitCode === 0) {
  console.log('OK: All bundle sizes within thresholds.');
} else if (exitCode === 1) {
  console.error('FAIL: One or more bundles exceeded the hard cap.');
  console.error('  → Audit recent imports. The mcp-server bundle especially must stay under 600 KB');
  console.error('    or Claude Desktop will fail to launch the MCP plugin (per PR #1645).');
} else if (exitCode === 2) {
  console.error('MISSING: One or more bundles do not exist. Run `npm run build` first.');
}

process.exit(exitCode);
