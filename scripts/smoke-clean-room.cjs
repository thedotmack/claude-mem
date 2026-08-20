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
// It is ALSO the backstop for the embedded-vector-index packaging class of bug:
// LocalEmbedder reaches @huggingface/transformers through a REQUEST-TIME
// `await import(...)`, so nothing on the worker's eager boot path touches it.
// A `--version` boot therefore cannot see a missing embedder closure — the
// first user to actually search is the one who finds out. PART 1b exercises
// that lazy path directly, and asserts the onnxruntime-node pin survived:
// @huggingface/transformers declares an EXACT transitive `onnxruntime-node:
// 1.24.3`, and 1.24.x ships no darwin/x64 prebuilt, which would strand exactly
// the Intel-Mac cohort the vector index exists to help. Only the `overrides`
// block in plugin/package.json (plugin/ is its own install root) forces 1.21.0.
//
// Three independent checks:
//   PART 1 — Plugin runtime closure: bun-install plugin/ from its frozen
//            lockfile into a fresh temp dir (parity with the real runtime
//            install in src/npx-cli/install/setup-runtime.ts:415), assert the
//            zod subpaths resolve, and boot the bundled worker so every
//            top-level require executes — surfacing any missing module.
//   PART 1b — Embedder lazy path: from that same fresh install, perform the
//            exact dynamic import LocalEmbedder performs, assert
//            onnxruntime-node resolved to the 1.21.0 pin (not transformers'
//            1.24.3), assert a prebuilt binding exists for THIS platform/arch,
//            and dlopen it. Also asserts the shipped worker bundle keeps
//            transformers external rather than inlining it. Set
//            CLAUDE_MEM_SMOKE_EMBED=1 to additionally run a real 384-dim
//            embed (downloads the model from HuggingFace; off by default).
//   PART 2 — npm-package completeness: `npm pack` the repo, install the tarball
//            into a second fresh temp dir, and load the published entrypoints to
//            catch dist runtime deps that are missing from the tarball.
//
// NETWORK: this script makes network calls ONLY for the two installs
//          (bun install in PART 1, npm install of the tarball in PART 2).
//          Everything else is local. Both installs pass --ignore-scripts.
//          EXCEPTION: with CLAUDE_MEM_SMOKE_EMBED=1, PART 1b additionally
//          downloads the all-MiniLM-L6-v2 weights from HuggingFace.
//
// SAFETY: runs exclusively against FRESH temp dirs — it never touches the
//          repo's already-installed node_modules. Both temp dirs and the .tgz
//          are removed in a finally block, even on failure.
//
// RUNTIME: roughly 30s–2min wall-clock, dominated by the two installs.
//          CLAUDE_MEM_SMOKE_EMBED=1 adds a one-off model download (~1min).
//
// EXIT: 0 on success (both parts pass); non-zero with a precise message naming
//       the missing module(s) on any failure.

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugin');

// zod v4 subpath exports that @modelcontextprotocol/sdk (and friends) require at
// runtime. These are the exact specifiers behind the #2730 incident.
const ZOD_SPECIFIERS = ['zod', 'zod/v3', 'zod/v4', 'zod/v4-mini'];

// Patterns that mean "a require/import blew up because a module was missing".
const MODULE_NOT_FOUND_RE = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/;

// onnxruntime-node MUST resolve to this exact version in the plugin closure.
// 1.24.x ships bin/napi-v6/{linux,darwin,win32} WITHOUT darwin/x64 — every Intel
// Mac then dies with "Cannot find module '../bin/napi-v6/darwin/x64/
// onnxruntime_binding.node'". 1.21.0 ships all six {linux,darwin,win32} x
// {x64,arm64} targets. See src/services/vector/LocalEmbedder.ts.
const EXPECTED_ONNXRUNTIME_VERSION = '1.21.0';

// Track everything we create so `finally` can clean up unconditionally.
const cleanup = { tmpPlugin: null, tmpPkg: null, tarball: null };

function log(msg) {
  console.log(msg);
}

function fail(messages) {
  console.error('\n\x1b[31mClean-room smoke test FAILED.\x1b[0m');
  for (const m of messages) console.error(`  - ${m}`);
  console.error('\nThis is the clean-room backstop (#2730 module resolution + the');
  console.error('embedded-vector-index embedder closure). A fresh user install would');
  console.error('hit exactly these failures. Do NOT ship until the runtime dependency');
  console.error('closure (plugin/package.json deps + overrides, plugin/bun.lock, the');
  console.error('build-hooks external arrays, and the tarball files) is fixed.');
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

  // PART 1b — the lazy embedder path. Runs before the worker boot so an absent
  // worker bundle cannot silently skip it.
  checkEmbedderLazyPath(tmpPlugin, failures);

  // Boot the bundled worker so EVERY top-level require executes. The worker is a
  // long-running server, so we invoke it via `--version`. Invoking with
  // `--version` loads the full bundle — executing every eager top-level require,
  // including `require("zod/v3")` — and exits without starting the long-running
  // server (the worker has no `--version` handler; argv simply falls through to a
  // no-op path that prints nothing and exits 0). We bound it with a timeout as
  // belt-and-suspenders: a TIMEOUT means the bundle loaded fine and started
  // running (treated as success); the ONLY failure signal we assert on is a
  // module-resolution error in the output. We deliberately do NOT assert on the
  // minified internals of the bundle — only on the absence of
  // `Cannot find module` / `MODULE_NOT_FOUND` and a non-crash exit.
  const workerEntry = path.join(tmpPlugin, 'scripts', 'worker-service.cjs');
  if (!fs.existsSync(workerEntry)) {
    failures.push(`bundled worker not found at ${workerEntry}`);
    return;
  }

  checkWorkerBundleKeepsEmbedderExternal(workerEntry, failures);
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
    // Loaded fine and kept running — that's a healthy worker. Success.
    log('  Worker loaded and started running (timeout reached, no missing module).');
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
    log('  Worker bundle loaded cleanly (no missing module).');
  }
}


// ---------------------------------------------------------------------------
// PART 1b — Embedder lazy path (the embedded-vector-index guard)
// ---------------------------------------------------------------------------

// Probe source, written into the fresh plugin temp dir and run with `bun` so it
// resolves EXACTLY the way the installed worker does. It prints one JSON line.
//
// Why a probe file and not an inline `bun -e`: the checks must resolve against
// <tmpPlugin>/node_modules, and a real file on disk inside that dir is the only
// way to get natural, unforced module resolution — the same resolution the
// shipped worker-service.cjs gets.
const EMBEDDER_PROBE_SOURCE = `
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const NM = path.join(process.cwd(), 'node_modules');
const req = createRequire(path.join(process.cwd(), 'probe.cjs'));
const EXPECTED_ORT = ${JSON.stringify(EXPECTED_ONNXRUNTIME_VERSION)};
const failures = [];
const notes = [];

const readVersion = (rel) =>
  JSON.parse(fs.readFileSync(path.join(NM, rel, 'package.json'), 'utf8')).version;

// A — the exact request-time import LocalEmbedder performs. This is the line the
//     --version boot can never reach.
let pipeline = null;
try {
  ({ pipeline } = await import('@huggingface/transformers'));
  notes.push('dynamic import("@huggingface/transformers") resolved (v' + readVersion('@huggingface/transformers') + ')');
} catch (e) {
  failures.push("LocalEmbedder's dynamic import(\\"@huggingface/transformers\\") FAILED: " + String(e && e.message).split('\\n')[0]);
}

// B — the onnxruntime-node pin must have survived transformers' EXACT transitive
//     "onnxruntime-node": "1.24.3". Only plugin/package.json's overrides block
//     can do that, and only because plugin/ is its own install root.
let ortVersion = null;
try {
  ortVersion = readVersion('onnxruntime-node');
  if (ortVersion !== EXPECTED_ORT) {
    failures.push('onnxruntime-node resolved to ' + ortVersion + ', expected ' + EXPECTED_ORT +
      ' — the plugin/package.json overrides pin did not take effect');
  } else {
    notes.push('onnxruntime-node pinned at ' + ortVersion);
  }
} catch (e) {
  failures.push('onnxruntime-node is absent from the plugin closure: ' + String(e && e.message).split('\\n')[0]);
}

// B2 — and no NESTED copy may shadow it for transformers' own require.
try {
  const nested = req.resolve('onnxruntime-node', { paths: [path.join(NM, '@huggingface/transformers')] });
  const nestedPkg = path.join(nested.slice(0, nested.indexOf('onnxruntime-node') + 'onnxruntime-node'.length), 'package.json');
  const nestedV = JSON.parse(fs.readFileSync(nestedPkg, 'utf8')).version;
  if (ortVersion && nestedV !== ortVersion) {
    failures.push('@huggingface/transformers resolves onnxruntime-node@' + nestedV +
      ', not the pinned ' + ortVersion + ' (a nested copy is shadowing the override)');
  } else {
    notes.push('transformers resolves the same onnxruntime-node@' + nestedV);
  }
} catch (e) {
  notes.push('nested-resolution probe inconclusive: ' + String(e && e.message).split('\\n')[0]);
}

// C — a prebuilt native binding must exist for THIS platform/arch. On an Intel
//     Mac this is the assertion that catches a 1.24.x regression.
const binRoot = path.join(NM, 'onnxruntime-node', 'bin');
const listShipped = () => {
  const out = [];
  if (!fs.existsSync(binRoot)) return '(no bin/ directory at all)';
  for (const napi of fs.readdirSync(binRoot)) {
    const napiDir = path.join(binRoot, napi);
    if (!fs.statSync(napiDir).isDirectory()) continue;
    for (const plat of fs.readdirSync(napiDir)) {
      const platDir = path.join(napiDir, plat);
      if (!fs.statSync(platDir).isDirectory()) continue;
      for (const arch of fs.readdirSync(platDir)) out.push(napi + '/' + plat + '/' + arch);
    }
  }
  return out.join(', ') || '(empty bin/ tree)';
};
let binding = null;
if (fs.existsSync(binRoot)) {
  for (const napi of fs.readdirSync(binRoot)) {
    const candidate = path.join(binRoot, napi, process.platform, process.arch, 'onnxruntime_binding.node');
    if (fs.existsSync(candidate)) { binding = candidate; break; }
  }
}
if (binding) {
  notes.push('prebuilt binding present: ' + path.relative(NM, binding));
} else {
  failures.push('onnxruntime-node@' + ortVersion + ' ships no prebuilt binding for ' +
    process.platform + '/' + process.arch + '. Shipped targets: ' + listShipped());
}

// D — actually dlopen it. Existence is not loadability.
try {
  req('onnxruntime-node');
  notes.push('onnxruntime-node native binding loaded');
} catch (e) {
  failures.push('onnxruntime-node failed to load its native binding: ' + String(e && e.message).split('\\n')[0]);
}

// E — opt-in end-to-end embed. Off by default: it downloads model weights, which
//     would add a third (and much larger) network dependency to every run.
if (process.env.CLAUDE_MEM_SMOKE_EMBED === '1' && pipeline) {
  try {
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
    const out = await extractor(['clean-room smoke probe'], { pooling: 'mean', normalize: true });
    if (out.dims[1] !== 384) {
      failures.push('embedder returned ' + out.dims[1] + ' dims, expected 384');
    } else {
      notes.push('end-to-end embed produced a 384-dim vector');
    }
  } catch (e) {
    failures.push('end-to-end embed FAILED: ' + String(e && e.message).split('\\n')[0]);
  }
}

console.log('__PROBE__' + JSON.stringify({ failures, notes }));
`;

function checkEmbedderLazyPath(tmpPlugin, failures) {
  log('\n  PART 1b — Embedder lazy path (vector-index guard)');

  const probePath = path.join(tmpPlugin, 'embedder-probe.mjs');
  fs.writeFileSync(probePath, EMBEDDER_PROBE_SOURCE, 'utf8');

  const deep = process.env.CLAUDE_MEM_SMOKE_EMBED === '1';
  if (deep) log('    CLAUDE_MEM_SMOKE_EMBED=1 — running a real embed (downloads model weights)');

  const res = spawnSync('bun', [probePath], {
    cwd: tmpPlugin,
    encoding: 'utf8',
    timeout: deep ? 300000 : 120000,
    env: { ...process.env, NODE_PATH: path.join(tmpPlugin, 'node_modules') },
  });

  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.error) {
    failures.push(`embedder probe failed to spawn: ${res.error.message}`);
    return;
  }

  const line = out.split('\n').find((l) => l.startsWith('__PROBE__'));
  if (!line) {
    // No verdict line means the probe itself died — that is a failure, not a pass.
    failures.push(
      `embedder probe produced no verdict (exit ${res.status}): ` +
        `${out.trim().split('\n').slice(-4).join(' | ') || '(no output)'}`
    );
    return;
  }

  let verdict;
  try {
    verdict = JSON.parse(line.slice('__PROBE__'.length));
  } catch (e) {
    failures.push(`embedder probe emitted unparseable verdict: ${line.slice(0, 200)}`);
    return;
  }

  for (const note of verdict.notes) log(`    ${note}`);
  for (const f of verdict.failures) failures.push(f);
  if (verdict.failures.length === 0) log('    Embedder lazy path is intact.');
}

// The worker bundle must reach @huggingface/transformers through an EXTERNAL
// dynamic import. If esbuild inlines transformers, its ONNX glue comes along
// while onnxruntime-node stays external, and the lazy path dies at runtime with
// "Cannot find module 'onnxruntime-node'" — see the external arrays in
// scripts/build-hooks.js.
function checkWorkerBundleKeepsEmbedderExternal(workerEntry, failures) {
  const bundle = fs.readFileSync(workerEntry, 'utf8');

  const hasEmbedder = bundle.includes('all-MiniLM-L6-v2');
  const externalImport = bundle.includes('import("@huggingface/transformers")');
  const bareOrtRequire = bundle.includes('require("onnxruntime-node")');
  const inlinedOrtGlue = bundle.includes('ort-wasm');

  if (!hasEmbedder && !externalImport) {
    // Not a hard failure: the bundle may legitimately predate the vector index.
    // But a STALE artifact is exactly how a fixed build config ships broken, so
    // say it loudly rather than passing in silence.
    log(
      '    WARN: the bundled worker contains no embedder code at all — this build ' +
        'artifact predates the vector index. Run `bun run build` and re-run this ' +
        'test before shipping; PART 1b above only proved the INSTALL closure.'
    );
    return;
  }

  if (bareOrtRequire || inlinedOrtGlue) {
    failures.push(
      'worker-service.cjs has @huggingface/transformers INLINED (found ' +
        `${bareOrtRequire ? 'require("onnxruntime-node")' : 'ort-wasm glue'}). ` +
        'Add @huggingface/transformers and sharp to the external arrays in ' +
        'scripts/build-hooks.js so the lazy import resolves from plugin/node_modules.'
    );
    return;
  }

  if (!externalImport) {
    failures.push(
      'worker-service.cjs references the embedder model but has no external ' +
        'import("@huggingface/transformers") — the dynamic import specifier did ' +
        'not survive bundling.'
    );
    return;
  }

  log('    Worker bundle keeps @huggingface/transformers external.');
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
  log(`\n\x1b[32mClean-room smoke test passed\x1b[0m — plugin closure, embedder lazy path, and npm tarball entrypoints all load cleanly (${seconds}s).`);
  process.exit(0);
}

main();
