import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const VERSION_CHECK_PATH = join(REPO_ROOT, 'plugin', 'scripts', 'version-check.js');
const SPAWN_TIMEOUT_MS = 15_000;
const INSTALL_DIAGNOSTIC = '[version-check] installing plugin dependencies';
const INSTALL_SUCCESS_DIAGNOSTIC = '[version-check] plugin dependencies installed successfully';
const INSTALL_FAILURE_DIAGNOSTIC = '[version-check] bun install failed';
const FAKE_INSTALLED_MARKER_REL = join('node_modules', 'zod', 'v3', 'index.js');
const FAKE_ZOD_ENTRY_FILES = ['v3/index.js', 'v4/index.js', 'v4-mini/index.js'];
const FAKE_TREE_SITTER_BINARY = join('node_modules', 'tree-sitter-cli', process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter');
const SKIP_NON_UNIX = process.platform === 'win32';

let tmpRoot: string;

function runVersionCheck(pluginRoot: string, fakeBinDir: string): Promise<{ stderr: string; stdout: string; code: number | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [VERSION_CHECK_PATH], {
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

type BunBehavior = 'success' | 'partial-then-fail';

function makeFreshPlugin(
  name: string,
  bunBehavior: BunBehavior = 'success',
  dependencies: Record<string, string> = { zod: '^3.0.0' },
): { pluginRoot: string; fakeBinDir: string } {
  const pluginRoot = join(tmpRoot, name);
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
    name: 'fake-plugin',
    version: '0.0.0',
    dependencies,
  }));
  writeFileSync(join(pluginRoot, '.install-version'), JSON.stringify({ version: '0.0.0' }));

  const fakeBinDir = join(pluginRoot, '.bin');
  mkdirSync(fakeBinDir, { recursive: true });

  // Fake bun behaviors:
  //   - success: creates the install marker file and exits 0 (happy path).
  //   - partial-then-fail: creates the partial node_modules dir THEN exits
  //     non-zero. Mirrors real bun's behavior under network timeout / OOM /
  //     registry 5xx where node_modules already exists when the failure
  //     surfaces. Required to cover the gh #2650 review-fix path that
  //     cleans up the partial dir so the next Setup run can retry.
  const fakeBunPath = join(fakeBinDir, 'bun');
  const installedPackageCommands = Object.keys(dependencies)
    .filter((dependencyName) => /^@?[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)?$/.test(dependencyName))
    .map((dependencyName) => {
      const packagePath = dependencyName.split('/').join('/');
      const packageManifest = dependencyName === 'zod'
        ? '{"name":"zod","version":"1.0.0","exports":{".":"./index.js","./v3":"./v3/index.js","./v4":"./v4/index.js","./v4-mini":"./v4-mini/index.js"}}'
        : `{"name":"${dependencyName}","version":"1.0.0"}`;
      const commands = [
        `  mkdir -p "${pluginRoot}/node_modules/${packagePath}"`,
        `  printf '${packageManifest}\n' > "${pluginRoot}/node_modules/${packagePath}/package.json"`,
      ];
      if (dependencyName === 'zod') {
        commands.push(`  : > "${pluginRoot}/node_modules/${packagePath}/index.js"`);
      }
      if (dependencyName === 'tree-sitter-cli') {
        commands.push(
          `  printf '%s\n' '#!/usr/bin/env node' 'const fs = require("fs"); const path = require("path"); const target = path.join(__dirname, "${process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter'}"); fs.writeFileSync(target, "#!/usr/bin/env node\\nprocess.stdout.write(\\"tree-sitter 0.26.5\\\\n\\");\\n"); fs.chmodSync(target, 0o755);' > "${pluginRoot}/node_modules/${packagePath}/install.js"`,
        );
      }
      return commands;
    })
    .flat();
  const installBody = bunBehavior === 'success'
    ? [
        ...installedPackageCommands,
        ...FAKE_ZOD_ENTRY_FILES.flatMap((entryFile) => [
          `  mkdir -p "${pluginRoot}/node_modules/zod/${entryFile.split('/')[0]}"`,
          `  : > "${pluginRoot}/node_modules/zod/${entryFile}"`,
        ]),
        '  exit 0',
      ]
    : [
        `  mkdir -p "${pluginRoot}/node_modules"`,
        '  echo "fake bun install failure mid-fetch" 1>&2',
        '  exit 42',
      ];
  const fakeBunScript = [
    '#!/usr/bin/env bash',
    'if [ "$2" != "--production" ] || [ "$3" != "--ignore-scripts" ]; then exit 43; fi',
    'if [ "$1" = "install" ]; then',
    ...installBody,
    'fi',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(fakeBunPath, fakeBunScript);
  chmodSync(fakeBunPath, 0o755);

  return { pluginRoot, fakeBinDir };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'version-check-deps-'));
});

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe.skipIf(SKIP_NON_UNIX)('version-check Setup-phase ensurePluginDependencies (gh #2649)', () => {
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
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
  });

  test('cleans up partial node_modules after a failed install so next Setup can retry (gh #2650 review)', async () => {
    // Reproduces the Greptile review concern: `bun install` often creates
    // the node_modules directory BEFORE it fails (mid-fetch network
    // timeout, registry 5xx, OOM kill). Without explicit cleanup, the
    // `existsSync(node_modules)` guard would permanently short-circuit
    // every subsequent Setup run and the user has no recovery path short
    // of a manual `rm -rf node_modules`. Verify that after a failed
    // install the partial dir is removed.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-partial-fail', 'partial-then-fail');

    // Sanity-check the failure path: node_modules MUST exist before our
    // cleanup runs (otherwise we are not exercising the gh #2650 scenario).
    // Run version-check once and confirm both the failure diagnostic and
    // the post-cleanup absence of node_modules.
    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_FAILURE_DIAGNOSTIC);
    expect(stderr).toContain('exit 42');
    expect(existsSync(join(pluginRoot, 'node_modules'))).toBe(false);
  });

  test('repairs an existing partial node_modules tree', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-partial');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
  });

  test('repairs an unreadable installed dependency manifest', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-corrupt-zod');
    mkdirSync(join(pluginRoot, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'), '{not-json');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, 'node_modules', 'zod', 'v4', 'index.js'))).toBe(true);
  });

  test('skips install when every declared package has a readable manifest', async () => {
    // Setup runs on every Claude Code launch. If node_modules already exists,
    // the install MUST be skipped — otherwise we re-run a 100 MB+ install on
    // every cold start and burn the user's bandwidth.
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-already-installed');
    mkdirSync(join(pluginRoot, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '3.0.0' }));
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'index.js'), '');
    for (const entryFile of FAKE_ZOD_ENTRY_FILES) {
      mkdirSync(join(pluginRoot, 'node_modules', 'zod', entryFile.split('/')[0]), { recursive: true });
      writeFileSync(join(pluginRoot, 'node_modules', 'zod', ...entryFile.split('/')), '');
    }

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    // The required Zod entry file is already present, so a successful skip
    // cannot be distinguished by the materialized file alone.
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(true);
  });

  test('repairs a Zod install whose root manifest lacks worker entry points', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-zod-subpath');
    mkdirSync(join(pluginRoot, 'node_modules', 'zod', 'v3'), { recursive: true });
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '4.4.3' }));
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'v3', 'index.js'), '');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, 'node_modules', 'zod', 'v4', 'index.js'))).toBe(true);
    expect(existsSync(join(pluginRoot, 'node_modules', 'zod', 'v4-mini', 'index.js'))).toBe(true);
  });

  test('provisions tree-sitter-cli after script-suppressed installation', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin(
      'plugin-tree-sitter-cli',
      'success',
      { zod: '^4.4.3', 'tree-sitter-cli': '^0.26.5' },
    );

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_SUCCESS_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_TREE_SITTER_BINARY))).toBe(true);
  });

  test('does not repeat Bun install when tree-sitter provisioning fails', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin(
      'plugin-tree-sitter-provision-failed',
      'success',
      { zod: '^4.4.3', 'tree-sitter-cli': '^0.26.5' },
    );
    const zodRoot = join(pluginRoot, 'node_modules', 'zod');
    mkdirSync(zodRoot, { recursive: true });
    writeFileSync(join(zodRoot, 'package.json'), JSON.stringify({
      name: 'zod',
      version: '4.4.3',
      exports: {
        '.': './index.js',
        './v3': './v3/index.js',
        './v4': './v4/index.js',
        './v4-mini': './v4-mini/index.js',
      },
    }));
    for (const entryFile of ['index.js', ...FAKE_ZOD_ENTRY_FILES]) {
      const entryPath = join(zodRoot, ...entryFile.split('/'));
      mkdirSync(join(entryPath, '..'), { recursive: true });
      writeFileSync(entryPath, '');
    }

    const treeSitterRoot = join(pluginRoot, 'node_modules', 'tree-sitter-cli');
    mkdirSync(treeSitterRoot, { recursive: true });
    writeFileSync(join(treeSitterRoot, 'package.json'), JSON.stringify({ name: 'tree-sitter-cli', version: '0.26.5' }));
    writeFileSync(join(treeSitterRoot, 'install.js'), 'process.exit(42);');

    const bunInvocationMarker = join(pluginRoot, 'bun-invoked');
    const fakeBunPath = join(fakeBinDir, 'bun');
    writeFileSync(fakeBunPath, `#!/usr/bin/env bash\n: > "${bunInvocationMarker}"\nexit 0\n`);
    chmodSync(fakeBunPath, 0o755);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    expect(stderr).toContain('tree-sitter-cli binary provisioning failed (exit 42)');
    expect(stderr).toContain('tree-sitter-cli binary remains unavailable');
    expect(existsSync(bunInvocationMarker)).toBe(false);
  });

  test('repairs a Zod tree whose exports map omits the bare worker entry point', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-zod-exports');
    mkdirSync(join(pluginRoot, 'node_modules', 'zod', 'v3'), { recursive: true });
    mkdirSync(join(pluginRoot, 'node_modules', 'zod', 'v4'), { recursive: true });
    mkdirSync(join(pluginRoot, 'node_modules', 'zod', 'v4-mini'), { recursive: true });
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'), JSON.stringify({
      name: 'zod',
      version: '4.4.3',
      exports: {
        './v3': './v3/index.js',
        './v4': './v4/index.js',
        './v4-mini': './v4-mini/index.js',
      },
    }));
    for (const entryFile of FAKE_ZOD_ENTRY_FILES) {
      writeFileSync(join(pluginRoot, 'node_modules', 'zod', ...entryFile.split('/')), '');
    }

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, 'node_modules', 'zod', 'v4-mini', 'index.js'))).toBe(true);
  });

  test('fails open for an invalid plugin manifest', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-invalid-manifest');
    writeFileSync(join(pluginRoot, 'package.json'), '{not-json');
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
  });

  test('fails open for an array-valued dependency field', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-array-dependencies');
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'fake-plugin',
      version: '0.0.0',
      dependencies: [],
    }));
    mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true });

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).not.toContain(INSTALL_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, FAKE_INSTALLED_MARKER_REL))).toBe(false);
  });

  test('reports incomplete output once when install exits successfully without repairing it', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin('plugin-still-partial');
    const fakeBunPath = join(fakeBinDir, 'bun');
    writeFileSync(fakeBunPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(fakeBunPath, 0o755);

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain('plugin dependencies remain incomplete after install');
    expect(stderr).not.toContain(INSTALL_SUCCESS_DIAGNOSTIC);
  });

  test('checks scoped dependencies and continues after an unreadable manifest', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin(
      'plugin-corrupt-scoped',
      'success',
      { zod: '^3.0.0', '@scope/tool': '^1.0.0' },
    );
    mkdirSync(join(pluginRoot, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'), '{not-json');

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, 'node_modules', '@scope', 'tool', 'package.json'))).toBe(true);
  });

  test('does not let an unsafe dependency key bypass later missing packages', async () => {
    const { pluginRoot, fakeBinDir } = makeFreshPlugin(
      'plugin-unsafe-dependency',
      'success',
      { '../outside': '^1.0.0', zod: '^3.0.0' },
    );

    const { stderr, code } = await runVersionCheck(pluginRoot, fakeBinDir);

    expect(code).toBe(0);
    expect(stderr).toContain(INSTALL_DIAGNOSTIC);
    expect(existsSync(join(pluginRoot, 'node_modules', 'zod', 'package.json'))).toBe(true);
    expect(existsSync(join(pluginRoot, '..', 'outside', 'package.json'))).toBe(false);
  });
});
