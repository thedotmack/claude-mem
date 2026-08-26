#!/usr/bin/env node
/**
 * Hook IO Discipline CI check (plan 01).
 *
 * Forbids direct stream writes / process control in the pure hook layers:
 *   - src/cli/handlers/**
 *   - src/cli/adapters/**
 *
 * These directories MUST stay pure: handlers return HookResult, adapters shape
 * it. All stdout/stderr/exit goes through src/shared/hook-io.ts (orchestrated
 * by hookCommand). There is NO allowlist for these directories.
 *
 * Pure CJS (no compile step) so it can run before tsc. Exits non-zero with
 * file:line on any violation.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
  path.join(REPO_ROOT, 'src', 'cli', 'handlers'),
  path.join(REPO_ROOT, 'src', 'cli', 'adapters'),
];

// Patterns that constitute a direct stream/process emit. Matched against
// source lines with comments stripped.
const FORBIDDEN = [
  { label: 'process.stderr.write', re: /process\s*\.\s*stderr\s*\.\s*write/ },
  { label: 'process.stdout.write', re: /process\s*\.\s*stdout\s*\.\s*write/ },
  { label: 'process.exit', re: /process\s*\.\s*exit\s*\(/ },
  { label: 'console.log', re: /console\s*\.\s*log\s*\(/ },
  { label: 'console.error', re: /console\s*\.\s*error\s*\(/ },
  { label: 'console.warn', re: /console\s*\.\s*warn\s*\(/ },
  { label: 'console.info', re: /console\s*\.\s*info\s*\(/ },
];

/** Strip // line comments and /* *\/ block comments so doc mentions don't trip. */
function stripComments(source) {
  // Block comments → spaces (preserve line count).
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Line comments → cut from // to EOL (naive but sufficient; our code has no
  // string literals containing "//" on forbidden-pattern lines).
  out = out
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
  return out;
}

function walk(dir) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function findViolations() {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      const lines = stripped.split('\n');
      lines.forEach((line, i) => {
        for (const { label, re } of FORBIDDEN) {
          if (re.test(line)) {
            violations.push({
              file: path.relative(REPO_ROOT, file),
              line: i + 1,
              pattern: label,
            });
          }
        }
      });
    }
  }
  return violations;
}

function run() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('hook-io discipline: OK (handlers + adapters are pure)');
    return 0;
  }
  console.error('hook-io discipline VIOLATIONS — these layers must be pure (route IO through src/shared/hook-io.ts):');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.pattern}`);
  }
  return 1;
}

module.exports = { findViolations };

if (require.main === module) {
  process.exit(run());
}
