import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const VERSION_CHECK_PATH = join(REPO_ROOT, 'plugin', 'scripts', 'version-check.js');
const SPAWN_TIMEOUT_MS = 15_000;
const INSTALL_DIAGNOSTIC = '[version-check] installing plugin dependencies';
const INSTALL_SUCCESS_DIAGNOSTIC = '[version-check] plugin dependencies installed successfully';
const INSTALL_FAILURE_DIAGNOSTIC = '[version-check] bun install failed';
// Emitted when `bun install` returns 0 but the declared closure is still short —
// the integrity-check-failed-but-exit-0 profile reported on gh #3755.
const INSTALL_INCOMPLETE_DIAGNOSTIC =
  '[version-check] bun install exited 0 but dependencies are still missing';
// The fake bun touches this file on every `install` invocation, so "the install
// path was not taken" is provable directly rather than inferred from a side
// effect that a given behavior may or may not produce.
const BUN_INVOKED_MARKER = '.bun-invoked';
// A leftover fetch artifact the partial-then-fail bun drops inside node_modules.
// Its survival is what proves the failed-install tree is preserved, not deleted.
const PARTIAL_FETCH_ARTIFACT_REL = join('node_modules', 'zod', 'partial-fetch.tmp');
// The exports map a genuinely resolvable zod must expose: worker-service.cjs
// requires `zod/v3` directly, and version-check probes all three subpaths
// (ZOD_REQUIRED_SUBPATHS, mirroring src/npx-cli/install/setup-runtime.ts:243).
const ZOD_COMPLETE_EXPORTS: Record<string, string> = {
  '.': './index.js',
  './v3': './v3/index.js',
  './v4': './v4/index.js',
  './v4-mini': './v4-mini/index.js',
};
const SKIP_NON_UNIX = process.platform === 'win32';

let tmpRoot: string;

// Spawn `node` explicitly, NOT process.execPath. Under `bun test` execPath is
// the bun binary, and bun's CJS resolver caches negative module lookups for the
// life of the process: the pre-install probe would poison the post-install
// re-check, making a perfectly good install report its dependencies as still
// missing. Production runs this script under node (plugin/hooks/hooks.json
// Setup command ends in `node "$_P/scripts/version-check.js"`), and
// tests/plugin-version-check.test.ts already spawns 'node' for the same reason,
// so node is both the honest and the matching runtime here.
const NODE_BIN = 'node';

function runVersionCheck(pluginRoot: string, fakeBinDir: string): Promise<{ stderr: string; stdout: string; code: number | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(NODE_BIN, [VERSION_CHECK_PATH], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_MEM_DATA_DIR: join(pluginRoot, '.claude-mem'),
        CLAUDE_CONFIG_DIR: join(pluginRoot, '.claude'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

      child.stdin.end();

      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`version-check subprocess exceeded ${SPAWN_TIMEOUT_MS}ms`));
      }, SPAWN_TIMEOUT_MS);

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolveResult({ stderr, stdout, code });
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      reject(err);
    }
  });
}

/**
 * Write a genuinely resolvable fake package into <pluginRoot>/node_modules/<name>.
 * Shape borrowed from tests/cli/verify-critical-modules.test.ts:11-31 — the
 * package.json `exports` map is what makes subpaths like `zod/v3` resolve, and
 * every file the map points at is materialized so resolution actually succeeds.
 */
function writeFakePackage(
  pluginRoot: string,
  name: string,
  exportsMap: Record<string, string>,
): void {
  const pkgDir = join(pluginRoot, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });

  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', exports: exportsMap }),
  );

  for (const target of Object.values(exportsMap)) {
    const rel = target.replace(/^\.\//, '');
    const stubPath = join(pkgDir, ...rel.split('/'));
    mkdirSync(dirname(stubPath), { recursive: true });
    writeFileSync(stubPath, 'export default {};\n');
  }
}

/**
 * Write a bin-only fake package, mirroring `tree-sitter-cli`: package.json has
 * ONLY a `bin` field — no `main`/`module`/`exports` and no index.js — so its
 * bare name is unresolvable by Node's rules even though it is fully installed.
 * Copied from tests/cli/verify-critical-modules.test.ts:33-48 (gh #2730).
 */
function writeFakeBinOnlyPackage(pluginRoot: string, name: string, binName: string): void {
  const pkgDir = join(pluginRoot, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', bin: { [binName]: './cli.js' } }),
  );
  writeFileSync(join(pkgDir, 'cli.js'), '#!/usr/bin/env node\n');
}

/**
 * Resolve a specifier the same way version-check's findMissingDependencies does:
 * a require anchored inside the install tree, with the tree as the sole resolve
 * path, so the installed `exports` map governs subpath resolution. Lets a test
 * assert real resolvability instead of mere file existence.
 *
 * Runs in a throwaway `node -e` subprocess on purpose. The bun process running
 * this suite caches module-resolution misses, so probing a specifier before an
 * install would make the same probe keep failing after it; a fresh process per
 * probe is immune, and node is the runtime the Setup hook actually uses.
 */
function resolvesFromPluginTree(pluginRoot: string, specifier: string): boolean {
  const nodeModulesPath = join(pluginRoot, 'node_modules');
  const probe = [
    "const { createRequire } = require('module');",
    "const { join } = require('path');",
    `const nm = ${JSON.stringify(nodeModulesPath)};`,
    "const req = createRequire(join(nm, 'noop.js'));",
    `req.resolve(${JSON.stringify(specifier)}, { paths: [nm] });`,
  ].join('\n');
  const probeResult = spawnSync(NODE_BIN, ['-e', probe], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return probeResult.status === 0;
}

/**
 * Shell lines that make the fake bun materialize a resolvable package, i.e. the
 * same tree writeFakePackage() produces but from inside the spawned installer.
 * The old fake bun only touched `node_modules/zod/v3/index.js`, which is NOT a
 * resolvable package (no package.json), so a "successful" install used to be
 * indistinguishable from a broken one.
 */
function fakeInstallLinesFor(
  pluginRoot: string,
  name: string,
  exportsMap: Record<string, string>,
): string[] {
  const pkgDir = join(pluginRoot, 'node_modules', ...name.split('/'));
  const manifest = JSON.stringify({ name, version: '0.0.0', type: 'module', exports: exportsMap });
  const lines = [
    `  mkdir -p "${pkgDir}"`,
    `  cat > "${pkgDir}/package.json" <<'PKGJSON'`,
    manifest,
    'PKGJSON',
  ];
  for (const target of Object.values(exportsMap)) {
    const rel = target.replace(/^\.\//, '');
    const stubPath = join(pkgDir, ...rel.split('/'));
    lines.push(`  mkdir -p "${dirname(stubPath)}"`);
    lines.push(`  printf 'export default {};\\n' > "${stubPath}"`);
  }
  return lines;
}

type BunBehavior =
  // Installs a genuinely resolvable zod (package.json + full exports map + stubs).
  | 'install-zod'
  // Installs resolvable zod AND late-added-dep — the "repair after a manifest
  // gained a dependency" path (gh #3755 second report).
  | 'install-zod-and-late-dep'
  // Exits 0 without writing anything: bun's integrity check silently failed.
  | 'noop-zero'
  // Creates a partial node_modules THEN exits non-zero (network timeout / OOM).
  | 'partial-then-fail';

function makeFreshPlugin(
  name: string,
  bunBehavior: BunBehavior = 'install-zod',
  dependencies: Record<string, string> = { zod: '^3.0.0' },
): { pluginRoot: string; fakeBinDir: string } {
  const pluginRoot = join(tmpRoot, name);
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
    name: 'fake-plugin',
    version: '0.0.0',
    dependencies,
  }));
  // Matching marker so the version-drift hint never pollutes stderr — these
  // tests assert on the absence of install diagnostics, not on empty stderr.
  writeFileSync(join(pluginRoot, '.install-version'), JSON.stringify({ version: '0.0.0' }));

  const fakeBinDir = join(pluginRoot, '.bin');
  mkdirSync(fakeBinDir, { recursive: true });

  const fakeBunPath = join(fakeBinDir, 'bun');
  let installBody: string[];
  if (bunBehavior === 'install-zod') {
    installBody = [...fakeInstallLinesFor(pluginRoot, 'zod', ZOD_COMPLETE_EXPORTS), '  exit 0'];
  } else if (bunBehavior === 'install-zod-and-late-dep') {
    installBody = [
      ...fakeInstallLinesFor(pluginRoot, 'zod', ZOD_COMPLETE_EXPORTS),
      ...fakeInstallLinesFor(pluginRoot, 'late-added-dep', { '.': './index.js' }),
      '  exit 0',
    ];
  } else if (bunBehavior === 'noop-zero') {
    installBody = [
      '  echo "fake bun integrity check silently failed" 1>&2',
      '  exit 0',
    ];
  } else {
    installBody = [
      `  mkdir -p "${pluginRoot}/node_modules/zod"`,
      `  : > "${pluginRoot}/${PARTIAL_FETCH_ARTIFACT_REL}"`,
      '  echo "fake bun install failure mid-fetch" 1>&2',
      '  exit 42',
    ];
  }

  const fakeBunScript = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "install" ]; then',
    `  : > "${join(pluginRoot, BUN_INVOKED_MARKER)}"`,
    ...installBody,
    'fi',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(fakeBunPath, fakeBunScript);
  chmodSync(fakeBunPath, 0o755);

  return { pluginRoot, fakeBinDir };
}

function bunWasInvoked(pluginRoot: string): boolean {
  return existsSync(join(pluginRoot, BUN_INVOKED_MARKER));
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'version-check-deps-'));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe.skipIf(SKIP_NON_UNIX)('version-check Setup-phase ensurePluginDependencies (gh #2649, #3755)', () => {
  test('installs plugin dependencies when node_modules is missing on fresh extract', async () => {
    // This is the gh #2640 / #2637 scenario: marketplace extracts files but
    // never runs `bun install`. Setup MUST detect the missing node_modules and
    // invoke dependency installation, otherwise the next hook (SessionStart
    // worker spawn) crashes with `Cannot find module 'zod/v3'`.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-fresh');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    // Success is now asserted against real resolvability, not a stray file:
    // the post-install re-check in version-check.js only reports success when
    // every declared specifier — zod and its three subpaths — resolves.
    expect(resolvesFromPluginTree(pluginRoot, 'zod')).toBe(true);
    expect(resolvesFromPluginTree(pluginRoot, 'zod/v3')).toBe(true);
  });

  test('installs when node_modules exists but is empty (gh #3755)', async () => {
    // REGRESSION PIN, inverted. The old guard was `existsSync(node_modules)`,
    // so a directory that merely EXISTED — created by an interrupted install,
    // or left behind after a partial fetch — permanently short-circuited repair
    // on every subsequent Setup run. The worker then died at boot with
    // `Cannot find module 'zod/v3'` while memory search kept working (zod is
    // bundled into mcp-server.cjs), which is why the breakage stayed silent for
    // months. An empty node_modules alongside a declared dependency MUST now
    // trigger the install, and the diagnostic MUST name what is missing so the
    // failure stops being invisible.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-empty-node-modules');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain('missing: zod');
    expect(bunWasInvoked(pluginRoot)).toBe(true);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(resolvesFromPluginTree(pluginRoot, 'zod/v3')).toBe(true);
  });

  test('preserves a partial node_modules after a failed install and retries on the next run', async () => {
    // The gh #2650 review added an `rmSync(node_modules)` after a failed
    // install, because the existence guard would otherwise block retry forever.
    // With the completeness guard that delete is not merely unnecessary, it is
    // harmful: the gh #3755 reporter had 12 of 26 packages on disk, still
    // powering memory search, and nuking them would have turned a degraded
    // install into a dead one. So assert the inverse of the old test — the
    // partial tree SURVIVES, and retry happens anyway because the guard
    // re-detects the missing closure rather than depending on deletion.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-partial-fail', 'partial-then-fail');

    const first = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(first.code).toBe(0);
    expect(first.stderr).toContain(INSTALL_FAILURE_DIAGNOSTIC);
    expect(first.stderr).toContain('exit 42');
    // The partially-fetched tree is still on disk, artifact and all.
    expect(existsSync(join(pluginRoot, 'node_modules'))).toBe(true);
    expect(existsSync(join(pluginRoot, PARTIAL_FETCH_ARTIFACT_REL))).toBe(true);

    // Second Setup run: node_modules exists (and would have satisfied the old
    // existence guard), but zod still does not resolve, so the install is
    // attempted again. This is the proof that retry no longer depends on rm.
    rmSync(join(pluginRoot, BUN_INVOKED_MARKER), { force: true });
    const second = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(second.code).toBe(0);
    expect(bunWasInvoked(pluginRoot)).toBe(true);
    expect(second.stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(second.stderr).toContain(INSTALL_FAILURE_DIAGNOSTIC);
    expect(second.stderr).toContain('exit 42');
    expect(existsSync(join(pluginRoot, PARTIAL_FETCH_ARTIFACT_REL))).toBe(true);
  });

  test('skips install when the declared closure fully resolves', async () => {
    // Setup runs on every Claude Code launch. A complete tree MUST short-circuit
    // — otherwise we re-run a 100 MB+ install on every cold start and burn the
    // user's bandwidth. "Complete" now means genuinely resolvable (package.json
    // + exports map + stub files), not just a directory named node_modules.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-complete-tree');
    writeFakePackage(pluginRoot, 'zod', ZOD_COMPLETE_EXPORTS);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    expect(bunWasInvoked(pluginRoot)).toBe(false);
  });

  test('detects and names a missing scoped dependency', async () => {
    // 6 of the plugin's 26 real dependencies are scoped (`@scope/pkg`), so the
    // scoped-path split in the probe is load-bearing: a naive single-segment
    // join would look for `node_modules/@scope%2Fpkg` and mis-report every
    // scoped package as missing (or, worse, as present).
    const { pluginRoot, fakeBinDir } = makeFreshPlugin(
      'plugin-missing-scoped',
      'noop-zero',
      { zod: '^3.0.0', '@fake-scope/missing-pkg': '^1.0.0' },
    );
    // zod resolves, so the scoped package is the ONLY thing that can be named.
    writeFakePackage(pluginRoot, 'zod', ZOD_COMPLETE_EXPORTS);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(`${INSTALL_DIAGNOSTIC} (missing: @fake-scope/missing-pkg)`);
    expect(bunWasInvoked(pluginRoot)).toBe(true);
  });

  test('treats a bin-only dependency as present, not missing (gh #2730)', async () => {
    // `tree-sitter-cli` is bin-only: its package.json has a `bin` field and no
    // `main`/`module`/`exports`/`index.js`, so bare-name resolution fails for a
    // perfectly installed package. Without the `${dep}/package.json` fallback
    // the guard would report it missing forever and re-run `bun install` on
    // every single Setup — the false-positive that gh #2730 pinned.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin(
      'plugin-bin-only-dep',
      'install-zod',
      { zod: '^3.0.0', 'faux-cli': '^1.0.0' },
    );
    writeFakePackage(pluginRoot, 'zod', ZOD_COMPLETE_EXPORTS);
    writeFakeBinOnlyPackage(pluginRoot, 'faux-cli', 'faux');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain('faux-cli');
    // Bin-only-ness alone must not drag the whole tree back into install.
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    expect(bunWasInvoked(pluginRoot)).toBe(false);
  });

  test('detects an unresolvable zod subpath even when zod itself resolves (gh #3755)', async () => {
    // The literal crash string in the bug report is `Cannot find module
    // 'zod/v3'` — with `node_modules/zod` sitting right there on disk. A stale
    // or integrity-failed install leaves the package directory intact while the
    // subpath exports break, so probing the package root is not enough: the
    // three subpaths worker-service.cjs requires must be probed individually.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-zod-missing-subpath', 'noop-zero');
    writeFakePackage(pluginRoot, 'zod', {
      '.': './index.js',
      './v4': './v4/index.js',
      './v4-mini': './v4-mini/index.js',
    });

    // Precondition: zod itself resolves, so only the subpath can be reported.
    expect(resolvesFromPluginTree(pluginRoot, 'zod')).toBe(true);
    expect(resolvesFromPluginTree(pluginRoot, 'zod/v3')).toBe(false);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(`${INSTALL_DIAGNOSTIC} (missing: zod/v3)`);
    expect(bunWasInvoked(pluginRoot)).toBe(true);
  });

  test('reports failure when bun install exits 0 but installs nothing (gh #3755)', async () => {
    // `bun install` can exit 0 while its integrity check silently failed,
    // leaving the closure short. Trusting the exit code would print "installed
    // successfully" over a tree that still cannot boot the worker — exactly the
    // reassuring-but-wrong transcript users saw. The post-install re-check must
    // downgrade this to a named failure.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-exit-zero-noop', 'noop-zero');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_INCOMPLETE_DIAGNOSTIC);
    expect(stderr).toContain('zod');
    expect(stderr).not.toContain(INSTALL_SUCCESS_DIAGNOSTIC);
  });

  test('detects and repairs a dependency added to the manifest after a complete install (gh #3755)', async () => {
    // The second gh #3755 report, end to end: the tree was complete for the
    // PREVIOUS manifest, then an upgrade added a dependency. Under the old
    // existence guard node_modules was present, so Setup skipped forever and
    // the new dependency was never installed. Deriving the expected set from
    // package.json `dependencies` makes the delta detectable, and the install
    // then repairs it in the same run.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin(
      'plugin-newly-added-dep',
      'install-zod-and-late-dep',
      { zod: '^3.0.0', 'late-added-dep': '^1.0.0' },
    );
    // Tree as it was left by the previous version's install: zod only.
    writeFakePackage(pluginRoot, 'zod', ZOD_COMPLETE_EXPORTS);
    expect(resolvesFromPluginTree(pluginRoot, 'late-added-dep')).toBe(false);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    // Only the delta is named — the already-satisfied zod must not be reported.
    expect(stderr).toContain(`${INSTALL_DIAGNOSTIC} (missing: late-added-dep)`);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(resolvesFromPluginTree(pluginRoot, 'late-added-dep')).toBe(true);
  });

  test('does not accept a dependency resolved from OUTSIDE the plugin tree (gh #3872 review)', async () => {
    // The completeness probe must answer "is it installed HERE", not "can this
    // machine resolve it from somewhere".
    //
    // `require.resolve(dep, { paths: [nodeModules] })` reads as tree-scoped but
    // is not: `paths` only seeds Node's lookup, which then walks every ancestor
    // directory and always consults the global folders. Real plugin roots sit
    // at ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/, so a zod
    // anywhere above them — or installed globally — answered for the plugin's
    // own. The guard reported a gutted tree as complete and skipped repair,
    // silently reinstating the gh #3755 bug it exists to catch.
    //
    // Fixture: an EMPTY plugin node_modules with a complete zod one directory
    // up, which is exactly the shape that fooled the probe.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('leak-host/plugin');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });
    // `leak-host` is the plugin root's parent, so its node_modules is the first
    // ancestor Node's lookup reaches after the plugin's own.
    writeFakePackage(join(tmpRoot, 'leak-host'), 'zod', ZOD_COMPLETE_EXPORTS);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    // The ancestor copy must not satisfy the closure: repair has to run.
    expect(stderr).toContain(`${INSTALL_DIAGNOSTIC} (missing: zod)`);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    // And the repair must have populated the plugin's OWN tree.
    expect(existsSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'))).toBe(true);
  });
});
