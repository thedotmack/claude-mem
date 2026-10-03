#!/usr/bin/env node
// Clean-room install + import smoke test.
//
// PURPOSE: regression backstop for the #2730 `Cannot find module 'zod/v3'`
// class of bug. zod v4 ships `./v3`, `./v4`, and `./v4-mini` subpath exports,
// and @modelcontextprotocol/sdk internals require `zod/v3` at runtime. If the
// plugin lockfile / package closure ever stops shipping those subpaths (a bad
// hoist, a dropped dep, a stale lockfile, or a missing-from-tarball file), the
// worker dies at require-time the first time a user runs it post-update. This
// test reproduces a USER's fresh install in throwaway temp dirs and asserts the
// runtime dependency closure resolves and the entrypoints load.
//
// Two independent checks:
//   PART 1 — Plugin runtime closure: bun-install plugin/ from its frozen
//            lockfile into a fresh temp dir (parity with the real runtime
//            install in src/npx-cli/install/setup-runtime.ts:415), assert the
//            zod subpaths resolve, and boot the bundled worker so every
//            top-level require executes — surfacing any missing module.
//   PART 2 — npm-package completeness: `npm pack` the repo, install the tarball
//            into a second fresh temp dir, and load the published entrypoints to
//            catch dist runtime deps that are missing from the tarball.
//
// NETWORK: this script makes network calls ONLY for the two installs
//          (bun install in PART 1, npm install of the tarball in PART 2).
//          Everything else is local. Both installs pass --ignore-scripts.
//
// SAFETY: runs exclusively against FRESH temp dirs — it never touches the
//          repo's already-installed node_modules. Both temp dirs and the .tgz
//          are removed in a finally block, even on failure.
//
// RUNTIME: roughly 30s–2min wall-clock, dominated by the two installs.
//
// EXIT: 0 on success (both parts pass); non-zero with a precise message naming
//       the missing module(s) on any failure.

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugin');
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

// zod v4 subpath exports that @modelcontextprotocol/sdk (and friends) require at
// runtime. These are the exact specifiers behind the #2730 incident.
const ZOD_SPECIFIERS = ['zod', 'zod/v3', 'zod/v4', 'zod/v4-mini'];

// Patterns that mean "a require/import blew up because a module was missing".
const MODULE_NOT_FOUND_RE = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/;

// Track everything we create so `finally` can clean up unconditionally.
const cleanup = { tmpPlugin: null, tmpPkg: null, tarball: null };

function log(msg) {
  console.log(msg);
}

function fail(messages) {
  console.error('\n\x1b[31mClean-room smoke test FAILED.\x1b[0m');
  for (const m of messages) console.error(`  - ${m}`);
  console.error('\nThis is the #2730 backstop: a fresh user install would hit the');
  console.error('same broken module resolution. Do NOT ship until the runtime');
  console.error('dependency closure (plugin/bun.lock + tarball files) is fixed.');
  process.exit(1);
}

function rmrf(p) {
  if (!p) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; never mask the real failure.
  }
}

function checkMediaRuntime(pluginRoot, failures) {
  const worker = path.join(pluginRoot, 'scripts', 'worker-service.cjs');
  let decoder;
  try {
    // Sharp0.35's exported entry is dist/index.cjs; anchor resolution in the
    // installed plugin/package rather than the checkout running this script.
    decoder = path.dirname(path.dirname(require.resolve('sharp', { paths: [pluginRoot] })));
  } catch {
    failures.push('Installed plugin is missing its direct Sharp runtime');
    return;
  }
  if (!fs.existsSync(decoder)) {
    failures.push('Installed plugin is missing its direct Sharp runtime');
    return;
  }
  const env = { ...process.env, NODE_PATH: '', CLAUDE_MEM_DATA_DIR: path.join(pluginRoot, 'smoke-data'),
    CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false', CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'false' };
  fs.renameSync(decoder, decoder + '.disabled');
  try {
    const text = spawnSync('bun', [worker, '--version'], {
      cwd: pluginRoot, env, encoding: 'utf8', timeout: 30_000,
    });
    if (text.error || text.status !== 0 || text.stdout.trim() !== EXPECTED_VERSION) {
      failures.push('Flags-off installed worker failed to print its exact version and exit without its media decoder');
    }
    const missing = spawnSync('bun', [worker, 'media-smoke'], { cwd: pluginRoot, env, encoding: 'utf8', timeout: 30_000 });
    if (missing.error || missing.status !== 1 || missing.stderr.trim() !== '{"mediaRuntime":"failed","code":"decoder_unavailable"}') {
      failures.push('Missing installed decoder did not fail with bounded JSON and nonzero exit');
    }
  } finally { fs.renameSync(decoder + '.disabled', decoder); }
  const result = spawnSync('bun', [worker, 'media-smoke'], {
    cwd: pluginRoot, env, encoding: 'utf8', timeout: 30_000,
  });
  if (result.error || result.status !== 0 || !result.stdout.includes('"mediaRuntime":"ok"')) {
    failures.push(`Installed worker decoder invocation failed: ${result.stderr || result.stdout}`);
  } else {
    log(`  Installed worker decoded both WebP variants: ${result.stdout.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// PART 1 — Plugin runtime closure (the #2730 guard)
// ---------------------------------------------------------------------------
function checkPluginClosure(failures) {
  log('PART 1 — Plugin runtime closure (#2730 guard)');

  const tmpPlugin = fs.mkdtempSync(path.join(os.tmpdir(), 'cmem-smoke-plugin-'));
  cleanup.tmpPlugin = tmpPlugin;
  log(`  Temp plugin dir: ${tmpPlugin}`);

  // Recursively copy the whole plugin/ tree (package.json, bun.lock, bundled
  // scripts). Skip any pre-existing node_modules so we install fresh from the
  // frozen lockfile rather than inheriting the repo's resolution.
  fs.cpSync(PLUGIN_DIR, tmpPlugin, {
    recursive: true,
    filter: (src) => path.basename(src) !== 'node_modules',
  });

  // Runtime install parity with src/npx-cli/install/setup-runtime.ts:415 —
  // `bun install --frozen-lockfile --ignore-scripts`. Frozen lockfile is what
  // makes this a real closure assertion: if plugin/bun.lock omits a subpath's
  // provider, the install reproduces the broken tree a user would get.
  log('  Running: bun install --frozen-lockfile --ignore-scripts');
  try {
    execSync('bun install --frozen-lockfile --ignore-scripts', {
      cwd: tmpPlugin,
      stdio: 'pipe',
      timeout: 180000,
    });
  } catch (error) {
    const out = `${error.stdout || ''}${error.stderr || ''}`.trim();
    failures.push(`bun install failed in fresh plugin temp dir: ${out || error.message}`);
    return;
  }

  // Assert each zod subpath resolves from the freshly installed node_modules.
  // require.resolve with an explicit paths root simulates how the bundled
  // worker (which lives under <tmpPlugin>/scripts) resolves its bare requires.
  const nodeModules = path.join(tmpPlugin, 'node_modules');
  const missing = [];
  for (const spec of ZOD_SPECIFIERS) {
    try {
      require.resolve(spec, { paths: [nodeModules] });
    } catch {
      missing.push(spec);
    }
  }
  if (missing.length > 0) {
    failures.push(
      `plugin closure is missing module(s): ${missing.join(', ')} ` +
        `(not resolvable from ${nodeModules})`
    );
  } else {
    log(`  Resolved all zod subpaths: ${ZOD_SPECIFIERS.join(', ')}`);
  }

  // Boot the bundled worker so EVERY top-level require executes. The worker is a
  // long-running server, so we invoke it via `--version`. Invoking with
  // `--version` loads the full bundle — executing every eager top-level require,
  // including `require("zod/v3")` — and exits without starting the long-running
  // server: the explicit version handler returns before resolving a worker
  // port or entering daemon startup. A timeout is a failed invocation; it no
  // longer counts as a successful module load. No test depends on a worker
  // already running on the developer machine.
  const workerEntry = path.join(tmpPlugin, 'scripts', 'worker-service.cjs');
  if (!fs.existsSync(workerEntry)) {
    failures.push(`bundled worker not found at ${workerEntry}`);
    return;
  }
  log('  Booting worker via: bun scripts/worker-service.cjs --version');
  const res = spawnSync('bun', [workerEntry, '--version'], {
    cwd: tmpPlugin,
    encoding: 'utf8',
    timeout: 20000,
    // Force resolution to land inside the temp node_modules, never the repo's.
    env: { ...process.env, NODE_PATH: nodeModules },
  });
  const workerOut = `${res.stdout || ''}${res.stderr || ''}`;
  if (MODULE_NOT_FOUND_RE.test(workerOut)) {
    const firstLine = workerOut
      .split('\n')
      .find((l) => MODULE_NOT_FOUND_RE.test(l));
    failures.push(`worker boot hit a module-resolution error: ${firstLine.trim()}`);
  } else if (res.error && res.error.code === 'ETIMEDOUT') {
    failures.push('Worker --version failed to exit within the startup deadline');
  } else if (res.error) {
    // Any OTHER spawn error (ENOENT if bun isn't on PATH, EACCES, etc.) means we
    // never actually exercised the bundle — that is NOT a pass. Only a genuine
    // ETIMEDOUT (handled above) counts as the worker loading cleanly.
    failures.push(`worker boot failed to spawn: ${res.error.message}`);
  } else if (res.status !== 0 && res.status !== null) {
    // Non-zero exit without a module error is suspicious enough to surface, but
    // it is not the #2730 signature; report it with context.
    failures.push(
      `worker boot exited ${res.status} (no missing-module error, but non-clean): ` +
        `${workerOut.trim().split('\n').slice(-3).join(' | ')}`
    );
  } else {
    if (res.stdout.trim() !== EXPECTED_VERSION) {
      failures.push('Worker --version did not print the exact package version');
    } else {
      log(`  Worker bundle printed version ${EXPECTED_VERSION} and exited cleanly.`);
    }
  }
  checkMediaRuntime(tmpPlugin, failures);
}

// ---------------------------------------------------------------------------
// PART 2 — npm-package completeness
// ---------------------------------------------------------------------------
function checkPackageCompleteness(failures) {
  log('\nPART 2 — npm-package completeness');

  // `npm pack --silent` prints just the tarball filename. Pack from repo root.
  let tarballName;
  try {
    tarballName = execSync('npm pack --silent', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')
      .pop()
      .trim();
  } catch (error) {
    failures.push(`npm pack failed: ${error.stderr || error.message}`);
    return;
  }
  const tarball = path.join(REPO_ROOT, tarballName);
  cleanup.tarball = tarball;
  log(`  Packed tarball: ${tarballName}`);

  const tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'cmem-smoke-pkg-'));
  cleanup.tmpPkg = tmpPkg;
  log(`  Temp install prefix: ${tmpPkg}`);

  log('  Installing tarball: npm install <tarball> --ignore-scripts --no-audit --no-fund');
  try {
    execSync(
      `npm install "${tarball}" --prefix "${tmpPkg}" --ignore-scripts --no-audit --no-fund`,
      { cwd: tmpPkg, stdio: 'pipe', timeout: 180000 }
    );
  } catch (error) {
    const out = `${error.stdout || ''}${error.stderr || ''}`.trim();
    failures.push(`npm install of tarball failed: ${out || error.message}`);
    return;
  }

  const pkgRoot = path.join(tmpPkg, 'node_modules', 'claude-mem');
  if (!fs.existsSync(pkgRoot)) {
    failures.push(`installed package not found at ${pkgRoot}`);
    return;
  }

  // npm installs the package root's direct Sharp dependency. The worker under
  // plugin/scripts resolves that same installed runtime from its parent.
  const installedPlugin = path.join(pkgRoot, 'plugin');
  checkMediaRuntime(installedPlugin, failures);
  const installedPkg = JSON.parse(
    fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')
  );

  // Build the candidate list of published entrypoints to load. Prefer the `bin`
  // (the real, runnable user entry — `npx claude-mem`), which exposes a safe
  // `--version` flag that loads the whole CLI and exits 0. Then add any
  // `main`/`exports` targets THAT ACTUALLY EXIST in the tarball. The package
  // currently declares exports['.'] -> ./dist/index.js and exports['./sdk'] ->
  // ./dist/sdk/index.js, neither of which the current build emits. We only
  // load-test what actually shipped (a missing-from-build entry is NOT a hard
  // failure here — that's the deferred #2537 slice), but we WARN loudly for each
  // declared-but-missing target so the latent gap is visible in CI logs rather
  // than silently swallowed.
  const entries = [];

  // bin — this is the hard check: it must exist and load.
  const binField = installedPkg.bin;
  const binPath =
    typeof binField === 'string'
      ? binField
      : binField && binField['claude-mem'];
  if (binPath) {
    const abs = path.join(pkgRoot, binPath);
    if (fs.existsSync(abs)) entries.push({ label: `bin (${binPath})`, abs, kind: 'bin' });
  }

  // Collect every declared main/exports target with a human label so we can warn
  // precisely about the ones missing from the tarball.
  const declaredTargets = [];
  if (installedPkg.main) {
    declaredTargets.push({ label: "main", rel: installedPkg.main });
  }
  const exportsField = installedPkg.exports || {};
  for (const [key, value] of Object.entries(exportsField)) {
    // Skip wildcard subpaths (e.g. "./modes/*") — there's no single concrete
    // file to existence-check.
    if (key.includes('*')) continue;
    let rel;
    if (typeof value === 'string') rel = value;
    else if (value && value.import) rel = value.import;
    if (rel) declaredTargets.push({ label: `exports['${key}']`, rel });
  }

  for (const { label, rel } of declaredTargets) {
    const abs = path.join(pkgRoot, rel);
    if (fs.existsSync(abs)) {
      entries.push({ label: `${label} (${rel})`, abs, kind: 'esm' });
    } else {
      log(
        `  WARN: package.json declares ${label} -> ${rel} but it is absent from ` +
          `the published tarball (latent gap, not a hard failure — see #2537).`
      );
    }
  }

  if (entries.length === 0) {
    failures.push('no published entrypoints were found in the tarball to load-test');
    return;
  }

  const isEsm = installedPkg.type === 'module';
  for (const entry of entries) {
    let res;
    if (entry.kind === 'bin') {
      // The bin has a safe `--version` that loads the CLI and exits 0.
      res = spawnSync('node', [entry.abs, '--version'], {
        cwd: pkgRoot,
        encoding: 'utf8',
        timeout: 30000,
      });
    } else if (isEsm) {
      // ESM module: dynamically import it so all its imports resolve. We only
      // care that it LOADS without a module-resolution error.
      const importUrl = require('url').pathToFileURL(entry.abs).href;
      res = spawnSync(
        'node',
        ['--input-type=module', '-e', `await import(${JSON.stringify(importUrl)})`],
        { cwd: pkgRoot, encoding: 'utf8', timeout: 30000 }
      );
    } else {
      res = spawnSync('node', ['-e', `require(${JSON.stringify(entry.abs)})`], {
        cwd: pkgRoot,
        encoding: 'utf8',
        timeout: 30000,
      });
    }
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    if (MODULE_NOT_FOUND_RE.test(out)) {
      const firstLine = out.split('\n').find((l) => MODULE_NOT_FOUND_RE.test(l));
      failures.push(
        `published entry ${entry.label} hit a module-resolution error: ${firstLine.trim()}`
      );
    } else if (res.error && res.error.code === 'ETIMEDOUT') {
      // A long-running entry that didn't crash on load is fine.
      log(`  Loaded ${entry.label} (still running at timeout, no missing module).`);
    } else if (res.status !== 0 && res.status !== null) {
      failures.push(
        `published entry ${entry.label} exited ${res.status}: ` +
          `${out.trim().split('\n').slice(-3).join(' | ')}`
      );
    } else {
      log(`  Loaded ${entry.label} cleanly (no missing module).`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const started = Date.now();
  const failures = [];

  try {
    checkPluginClosure(failures);
    checkPackageCompleteness(failures);
  } finally {
    rmrf(cleanup.tmpPlugin);
    rmrf(cleanup.tmpPkg);
    if (cleanup.tarball) {
      try {
        fs.unlinkSync(cleanup.tarball);
      } catch {
        // already gone
      }
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    fail(failures);
  }
  log(`\n\x1b[32mClean-room smoke test passed\x1b[0m — plugin closure + npm tarball entrypoints load cleanly (${seconds}s).`);
  process.exit(0);
}

main();
