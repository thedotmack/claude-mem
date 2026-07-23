#!/usr/bin/env node

// check-worker-runtime-deps.cjs — blocking build/CI gate for the worker's
// EXTERNALIZED runtime dependency closure.
//
// WHY THIS EXISTS (the 13.11.0 lockout):
//   build-hooks.js externalizes `zod` from the worker bundle (external: ['zod',
//   …]) — the shipped worker-service.cjs contains bare `require("zod/v3")` /
//   `require("zod/v4")` calls that MUST resolve at runtime against the plugin's
//   installed node_modules. The runtime installer (setup-runtime.ts) materializes
//   that closure with `bun install --frozen-lockfile`. mcp-server.cjs is already
//   guarded — build-hooks.js FAILS the build if it externalizes zod (Claude
//   Desktop can launch it without plugin node_modules). The WORKER had the exact
//   same exposure but NO equivalent guard: when a shipped bun.lock drifts from
//   plugin/package.json (or the install is otherwise incomplete), the frozen
//   install produces no resolvable zod and the worker crashes at startup with
//   "Cannot find module 'zod/v3'" — which, via the hook fail-loud path, used to
//   lock the editor entirely. This gate reproduces a clean frozen install and
//   asserts the worker's always-required externals resolve, so a broken closure
//   can never ship again.
//
// Usage:
//   node scripts/check-worker-runtime-deps.cjs [--plugin-dir <dir>]
//   CLAUDE_MEM_VERIFY_WORKER_BOOT=1 node scripts/check-worker-runtime-deps.cjs
//     └ also loads the built worker bundle against the clean closure (deeper
//       smoke: proves the bundle's top-level require("zod/v3") actually loads).

const { execFileSync, spawnSync } = require('child_process');
const { mkdtempSync, rmSync, copyFileSync, existsSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');

// The worker bundle require()s these at load time (grep 'require("zod' in the
// built worker-service.cjs). They are externalized, so they must resolve from
// the shipped plugin closure. Keep in sync with build-hooks.js `external`.
const REQUIRED_WORKER_MODULES = ['zod', 'zod/v3', 'zod/v4', 'zod/v4-mini'];

function fail(msg) {
  console.error(`\n❌ check-worker-runtime-deps: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let pluginDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plugin-dir') pluginDir = argv[++i];
  }
  return { pluginDir };
}

function main() {
  const { pluginDir: pluginArg } = parseArgs(process.argv.slice(2));
  const pluginDir = pluginArg
    ? path.resolve(pluginArg)
    : path.join(__dirname, '..', 'plugin');

  const manifest = path.join(pluginDir, 'package.json');
  const lockfile = path.join(pluginDir, 'bun.lock');
  const worker = path.join(pluginDir, 'scripts', 'worker-service.cjs');

  if (!existsSync(manifest)) fail(`missing ${manifest}. Run scripts/build-hooks.js first (it generates plugin/package.json).`);
  if (!existsSync(lockfile)) fail(`missing ${lockfile}. Run scripts/gen-plugin-lockfile.cjs first (it generates plugin/bun.lock).`);
  if (!existsSync(worker)) fail(`missing ${worker}. Run scripts/build-hooks.js first (it builds the worker bundle).`);

  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('bun is not on PATH — this gate needs bun to reproduce the runtime install (https://bun.sh).');
  }

  console.log('🔒 Verifying worker runtime dependency closure (zod externals)…');

  const tmp = mkdtempSync(path.join(tmpdir(), 'cmem-depguard-'));
  try {
    // Reproduce exactly what the runtime installer ships + runs.
    copyFileSync(manifest, path.join(tmp, 'package.json'));
    copyFileSync(lockfile, path.join(tmp, 'bun.lock'));

    const install = spawnSync('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: tmp,
      encoding: 'utf-8',
    });
    if (install.status !== 0) {
      fail(
        'a clean `bun install --frozen-lockfile` FAILED — plugin/bun.lock is drifted from ' +
        'plugin/package.json, so the runtime install produces no dependency closure ' +
        '(this is the 13.11.0 breakage). Regenerate the lockfile: run `npm run build` ' +
        '(build-hooks.js → gen-plugin-lockfile.cjs).\n\n' +
        (install.stderr || install.stdout || '')
      );
    }

    // The bundle's bare require("zod/v3") etc. must resolve under bun (the worker
    // runtime) from this clean closure. This is the deterministic 13.11.0 gate.
    const probe = REQUIRED_WORKER_MODULES.map((m) => `require.resolve(${JSON.stringify(m)})`).join('; ');
    const resolved = spawnSync('bun', ['-e', probe], { cwd: tmp, encoding: 'utf-8' });
    if (resolved.status !== 0) {
      fail(
        `the worker bundle require()s [${REQUIRED_WORKER_MODULES.join(', ')}] at load, but they ` +
        'do NOT resolve from a clean frozen install of the shipped plugin closure. The worker ' +
        'would crash at startup with "Cannot find module \'zod/v3\'" (the 13.11.0 lockout). ' +
        'Ensure zod is a declared plugin dependency and the lockfile is in sync.\n\n' +
        (resolved.stderr || resolved.stdout || '')
      );
    }

    // Opt-in deeper smoke: load the actual built worker bundle against the clean
    // closure, proving its top-level require("zod/v3") loads (not just resolves).
    // Off by default because it spawns bun on the real bundle; the maintainers
    // keep daemon-spawning out of the default test/build path (flaky in CI, see
    // tests/cli/hook-stream-discipline.test.ts). `status` loads the bundle then
    // reports "not running" and exits 0 without leaving a daemon behind — so a
    // top-level require("zod/v3") failure surfaces as a NON-ZERO exit / spawn
    // error / timeout signal, which is exactly what we gate on below.
    if (process.env.CLAUDE_MEM_VERIFY_WORKER_BOOT === '1') {
      const workerCopy = path.join(tmp, 'worker-service.cjs');
      copyFileSync(worker, workerCopy);
      const load = spawnSync('bun', [workerCopy, 'status'], {
        cwd: tmp,
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: path.join(tmp, 'data') },
        timeout: 30000,
      });
      // Gate on the PROCESS outcome, not a stderr regex: a non-zero exit, a spawn
      // error, or a timeout kill (load.signal) all mean the bundle did not load
      // cleanly. Regex-only matching let a failed/timed-out boot report success
      // and pass a broken artifact (PR #3225 review).
      if (load.error || load.signal || load.status !== 0) {
        const out = `${load.stdout || ''}${load.stderr || ''}`;
        fail(
          'the built worker bundle failed to LOAD against the clean closure' +
          (load.error ? ` (${load.error.message})` : '') +
          (load.signal ? ` (killed by ${load.signal})` : '') +
          `:\n\n${out}`
        );
      }
      console.log('✓ worker bundle loads against the clean closure (CLAUDE_MEM_VERIFY_WORKER_BOOT)');
    }

    console.log(`✓ worker runtime deps resolve from a clean frozen install: ${REQUIRED_WORKER_MODULES.join(', ')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
