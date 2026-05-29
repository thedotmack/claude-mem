#!/usr/bin/env node
/**
 * Spawn-env discipline CI check (plan 06 — worker env isolation).
 *
 * Every subprocess spawn that hands an env block to its child MUST sanitize
 * that env with sanitizeEnv(...) before passing it (and, for SDK/credential
 * paths, buildIsolatedEnv*). Handing raw `process.env` to a child lets host
 * CLI bleed-through (CLAUDE_CODE_EFFORT_LEVEL → #2357) and stray Anthropic
 * credentials (ANTHROPIC_BASE_URL → #2375) leak into the subprocess.
 *
 * Rule: any spawn(...) / spawnSync(...) / spawnHidden(...) call whose argument
 * window passes an `env:` option referencing `process.env` MUST also reference
 * `sanitizeEnv` within the same window. Spawns that omit `env:` (inherit the
 * parent env implicitly — e.g. install-time `git`/`npm`/`bun --version`) are
 * out of scope: they are not the credential-bearing worker/SDK boundary and
 * the parent shell is their trust boundary.
 *
 * Pure CJS (no compile step) so it can run before tsc. Exposes findViolations
 * for the bun test in tests/env-isolation.test.ts; exits non-zero with
 * file:line on any violation when run directly.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

// How many lines after a spawn match to inspect for the env: option.
const WINDOW_LINES = 10;

const SPAWN_RE = /\b(spawn|spawnSync|spawnHidden)\s*\(/;

/** Strip // line comments and block comments so doc mentions don't trip. */
function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
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
      if (entry.name === 'node_modules') continue;
      files.push(...walk(full));
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function findViolations() {
  const violations = [];
  for (const file of walk(SRC_DIR)) {
    const raw = fs.readFileSync(file, 'utf-8');
    const stripped = stripComments(raw);
    const lines = stripped.split('\n');

    lines.forEach((line, i) => {
      if (!SPAWN_RE.test(line)) return;

      // Inspect the spawn call's argument window.
      const window = lines.slice(i, i + WINDOW_LINES).join('\n');

      // Only spawns that pass an explicit env block built from process.env are
      // in scope. Implicit-inherit spawns (no env:) are out of scope.
      const passesEnvOption = /env\s*:/.test(window);
      const referencesProcessEnv = /process\s*\.\s*env/.test(window);
      if (!passesEnvOption || !referencesProcessEnv) return;

      // The env block must be sanitized.
      if (!/sanitizeEnv\s*\(/.test(window)) {
        violations.push({
          file: path.relative(REPO_ROOT, file),
          line: i + 1,
        });
      }
    });
  }
  return violations;
}

function run() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('spawn-env discipline: OK (all env-bearing spawns sanitize process.env)');
    return 0;
  }
  console.error('spawn-env discipline VIOLATIONS — wrap the env block in sanitizeEnv(...) before spawning:');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  spawn passes raw process.env without sanitizeEnv`);
  }
  return 1;
}

module.exports = { findViolations };

if (require.main === module) {
  process.exit(run());
}
