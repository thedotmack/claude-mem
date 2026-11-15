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
 * Rule: any spawn(...) / spawnSync(...) / spawnHidden(...) call that passes an
 * `env:` block built from `process.env` MUST also reference `sanitizeEnv`.
 * The env block counts whether it is written inline in the call or declared in
 * an object above it and passed by name — both shapes are read, because the
 * second one is how the launcher and the hook runner build theirs, and a rule
 * that only read the call's own window silently missed them.
 *
 * Spawns that omit `env:` (inherit the parent env implicitly — e.g.
 * install-time `git`/`npm`/`bun --version`) are out of scope: they are not the
 * credential-bearing worker/SDK boundary and the parent shell is their trust
 * boundary. Two host-boundary spawns *do* pass an env block explicitly and are
 * listed in EXEMPT for the same reason, so that they are reviewed rather than
 * invisible. Any other violation fails.
 *
 * Pure CJS (no compile step) so it can run before tsc. Exposes findViolations
 * for the bun test in tests/env-isolation.test.ts; exits non-zero with
 * file:line on any violation when run directly.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
// Hand-maintained runtime sources. The generated bundles under plugin/scripts
// (worker-service.cjs, mcp-server.cjs, ...) are built from src/, which is
// scanned here, so scanning the bundles too would only double-report them.
const SCAN_TARGETS = [
  { dir: path.join(REPO_ROOT, 'src'), extensions: ['.ts'] },
  { dir: path.join(REPO_ROOT, 'plugin', 'scripts'), extensions: [], files: ['bun-runner.js'] },
  { dir: path.join(REPO_ROOT, 'plugin', 'hooks'), extensions: ['.js', '.cjs', '.mjs'] },
];

// How many lines after a spawn match to inspect for an inline env: option.
const WINDOW_LINES = 10;

const SPAWN_RE = /\b(spawn|spawnSync|spawnHidden)\s*\(/;
const ENV_KEY_RE = /\benv\s*:/;
const PROCESS_ENV_RE = /process\s*\.\s*env/;
const SANITIZE_RE = /sanitizeEnv\s*\(/;
const OBJECT_DECL_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{/;

/**
 * Reviewed exceptions. Both spawns start the worker that serves the host from
 * inside the host, which is the same boundary the header describes for spawns
 * that inherit the parent env: the worker IS the host's child, so the hook has
 * to keep seeing the host's own variables (PATH, CLAUDE_MEM_* overrides, the
 * host's own CLAUDE_CODE_* settings). The credential-bearing boundary is the
 * SDK/observer spawn inside that worker, and those sanitize. Adding an entry
 * here must be a deliberate, reviewed change; the point of the rule is that a
 * violation cannot hide in a shape the check does not read.
 */
const EXEMPT = new Map([
  ['plugin/scripts/bun-runner.js', 'host-boundary hook runner: hands the host environment to the worker it starts'],
  ['src/launcher/claude-mem-launcher.ts', 'host-boundary hook launcher: same reason'],
]);

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

function walk(dir, extensions) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...walk(full, extensions));
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name)) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function scanTargets() {
  const files = [];
  for (const target of SCAN_TARGETS) {
    if (target.files) {
      for (const name of target.files) {
        const full = path.join(target.dir, name);
        if (fs.existsSync(full)) files.push(full);
      }
    } else {
      files.push(...walk(target.dir, target.extensions));
    }
  }
  return files;
}

/**
 * Object literals declared as `const name = { ... }` (or `: Type = {`), with
 * their line span. A spawn that passes `name` is then judged on the literal's
 * own text, not on the call's window.
 */
function declaredObjects(lines) {
  const objects = new Map();
  lines.forEach((line, index) => {
    const match = line.match(OBJECT_DECL_RE);
    if (!match) return;
    let depth = 0;
    let end = index;
    for (let cursor = index; cursor < lines.length; cursor++) {
      for (const char of lines[cursor]) {
        if (char === '{') depth++;
        else if (char === '}') depth--;
      }
      end = cursor;
      if (depth <= 0) break;
    }
    objects.set(match[1], { text: lines.slice(index, end + 1).join('\n') });
  });
  return objects;
}

function findViolations() {
  const violations = [];
  for (const file of scanTargets()) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const stripped = stripComments(fs.readFileSync(file, 'utf-8'));
    const lines = stripped.split('\n');
    const objects = declaredObjects(lines);

    lines.forEach((line, i) => {
      if (!SPAWN_RE.test(line)) return;

      const window = lines.slice(i, i + WINDOW_LINES).join('\n');

      // Inline shape: the env block is written inside the call's own window.
      let envScope = ENV_KEY_RE.test(window) && PROCESS_ENV_RE.test(window) ? window : null;

      // Declared shape: the call passes an object built above it.
      if (!envScope) {
        for (const [name, object] of objects) {
          if (!new RegExp(`\\b${name}\\b`).test(window)) continue;
          if (ENV_KEY_RE.test(object.text) && PROCESS_ENV_RE.test(object.text)) {
            envScope = object.text;
            break;
          }
        }
      }

      if (!envScope) return;
      if (SANITIZE_RE.test(envScope)) return;

      violations.push({ file: relative, line: i + 1 });
    });
  }
  return violations;
}

function run() {
  const all = findViolations();
  const violations = all.filter((v) => !EXEMPT.has(v.file));
  if (violations.length === 0) {
    const exempted = all.length === 0 ? '' : ` (${all.length} reviewed host-boundary exception(s) skipped)`;
    console.log(`spawn-env discipline: OK (all env-bearing spawns sanitize process.env)${exempted}`);
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
