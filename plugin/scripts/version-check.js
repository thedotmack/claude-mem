#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';
const VERSION_CHECK_LOG_PREFIX = '[version-check]';
const BUN_INSTALL_ARGS = Object.freeze(['install', '--production', '--ignore-scripts']);
const BUN_INSTALL_TIMEOUT_MS = 120_000;
const NODE_MODULES_DIRNAME = 'node_modules';
const PACKAGE_NAME_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const REQUIRED_DEPENDENCY_SUBPATHS = Object.freeze({
  zod: Object.freeze(['zod', 'zod/v3', 'zod/v4', 'zod/v4-mini']),
});
const TREE_SITTER_CLI = 'tree-sitter-cli';
const TREE_SITTER_BINARY = IS_WINDOWS ? 'tree-sitter.exe' : 'tree-sitter';
const TREE_SITTER_VERSION_TIMEOUT_MS = 10_000;

function dependencyPathSegments(name) {
  if (typeof name !== 'string') return null;

  const segments = name.split('/');
  if (segments.length === 1 && PACKAGE_NAME_SEGMENT_RE.test(segments[0])) {
    return segments;
  }
  if (
    segments.length === 2
    && /^@[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segments[0])
    && PACKAGE_NAME_SEGMENT_RE.test(segments[1])
  ) {
    return segments;
  }
  return null;
}

function readJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    return null;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isUsableTreeSitterBinary(path) {
  if (!isFile(path)) return false;

  try {
    const result = spawnSync(path, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TREE_SITTER_VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.status === 0 && /^tree-sitter \d+\.\d+\.\d+(?:\s|$)/.test(result.stdout.trim());
  } catch {
    return false;
  }
}

function hasCompletePluginDependencies(pluginRoot) {
  const packageManifest = readJsonObject(join(pluginRoot, 'package.json'));
  // Preserve the existing existence semantics when the manifest cannot be
  // trusted; Setup must remain fail-open for malformed plugin metadata.
  if (!packageManifest) return true;
  if (!packageManifest.dependencies || typeof packageManifest.dependencies !== 'object' || Array.isArray(packageManifest.dependencies)) return true;

  const nodeModulesRoot = join(pluginRoot, NODE_MODULES_DIRNAME);
  let requireFromPlugin;
  try {
    requireFromPlugin = createRequire(join(pluginRoot, 'package.json'));
  } catch {
    return true;
  }

  for (const dependencyName of Object.keys(packageManifest.dependencies)) {
    const segments = dependencyPathSegments(dependencyName);
    if (!segments) continue;

    const installedManifest = readJsonObject(join(nodeModulesRoot, ...segments, 'package.json'));
    if (installedManifest === false) return false;
    if (!installedManifest) continue;

    const requiredSubpaths = REQUIRED_DEPENDENCY_SUBPATHS[dependencyName] || [];
    for (const subpath of requiredSubpaths) {
      try {
        requireFromPlugin.resolve(subpath);
      } catch {
        return false;
      }
    }

    if (
      dependencyName === TREE_SITTER_CLI
      && !isUsableTreeSitterBinary(join(nodeModulesRoot, ...segments, TREE_SITTER_BINARY))
    ) {
      return false;
    }
  }
  return true;
}

function findBun() {
  const pathCheck = IS_WINDOWS
    ? spawnSync('where', ['bun'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawnSync('which', ['bun'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    if (IS_WINDOWS) {
      const bunPaths = pathCheck.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const bunExePath = bunPaths.find((line) => line.toLowerCase().endsWith('bun.exe'));
      if (bunExePath) return bunExePath;
      const bunCmdPath = bunPaths.find((line) => line.toLowerCase().endsWith('bun.cmd'));
      if (bunCmdPath) return bunCmdPath.trim();
    }
    return 'bun';
  }

  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun',
      ];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) return bunPath;
  }

  return null;
}

function bunInstallInvocation(bunPath) {
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(bunPath)) {
    const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
    const commandLine = [bunPath, ...BUN_INSTALL_ARGS].map(quote).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      options: { windowsVerbatimArguments: true },
    };
  }
  return { command: bunPath, args: BUN_INSTALL_ARGS, options: {} };
}

function provisionTreeSitterCliBinary(pluginRoot) {
  const cliDir = join(pluginRoot, NODE_MODULES_DIRNAME, TREE_SITTER_CLI);
  const binaryPath = join(cliDir, TREE_SITTER_BINARY);
  if (!existsSync(cliDir) || isUsableTreeSitterBinary(binaryPath)) return;

  const installScript = join(cliDir, 'install.js');
  if (!existsSync(installScript)) {
    console.error(`${VERSION_CHECK_LOG_PREFIX} tree-sitter-cli install script not found; plugin dependencies remain incomplete`);
    return;
  }

  let result;
  try {
    result = spawnSync(process.execPath, [installScript], {
      cwd: cliDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: BUN_INSTALL_TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.error(`${VERSION_CHECK_LOG_PREFIX} tree-sitter-cli binary provisioning threw (${reason})`);
    return;
  }

  const killedBySignal = result.status === null && !!result.signal;
  const nonZeroExit = result.status !== null && result.status !== 0;
  if (result.error || nonZeroExit || killedBySignal) {
    const reason = result.error
      ? result.error.message
      : killedBySignal
        ? `killed by ${result.signal}`
        : `exit ${result.status}`;
    console.error(`${VERSION_CHECK_LOG_PREFIX} tree-sitter-cli binary provisioning failed (${reason})`);
  }
}

// Setup-phase auto-install of plugin runtime dependencies.
//
// The plugin marketplace extracts files into ~/.claude/plugins/cache/...
// but does not run `bun install`. On fresh installs the worker crashes
// with `Cannot find module 'zod/v3'` on the very first hook invocation
// (gh #2640, #2637). The previous defense-in-depth fix (gh #2644) ran
// the install on the SessionStart / UserPromptSubmit hot path; review
// (gh #2649 — YOMXXX) flagged that as the wrong architectural home
// because it makes proxy / offline / OOM failures land on the user's
// first prompt instead of at install time.
//
// Running it here at Setup keeps the install off the hot path: Setup
// has a 300s timeout (vs 60s for SessionStart), runs once per Claude
// Code launch, and is the only standalone hook script — the natural
// place to materialise plugin runtime state.
function ensurePluginDependencies(pluginRoot) {
  if (!existsSync(join(pluginRoot, 'package.json'))) return;

  // Check the declared closure rather than treating the directory itself as
  // proof that an interrupted install finished.
  if (existsSync(join(pluginRoot, NODE_MODULES_DIRNAME)) && hasCompletePluginDependencies(pluginRoot)) return;

  const bunPath = findBun();
  if (!bunPath) {
    console.error(`${VERSION_CHECK_LOG_PREFIX} bun not found on PATH; cannot auto-install plugin dependencies`);
    return;
  }

  // Progress diagnostic so users understand the (one-time) Setup hang.
  console.error(`${VERSION_CHECK_LOG_PREFIX} installing plugin dependencies (first run, one-time)...`);

  let result;
  try {
    const invocation = bunInstallInvocation(bunPath);
    result = spawnSync(invocation.command, invocation.args, {
      cwd: pluginRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: BUN_INSTALL_TIMEOUT_MS,
      windowsHide: true,
      ...invocation.options,
    });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.error(`${VERSION_CHECK_LOG_PREFIX} bun install threw (${reason}); worker may crash with missing module errors`);
    return;
  }

  // spawnSync does NOT throw on a failed child. Three distinct failure
  // modes must be surfaced explicitly:
  //   1. result.error set (ENOENT / ETIMEDOUT / ...)
  //   2. non-zero exit code
  //   3. signal-killed (OOM SIGKILL, SIGTERM, ...) where result.status is
  //      null AND result.error is undefined — only result.signal is set.
  const killedBySignal = result.status === null && !!result.signal;
  const nonZeroExit = result.status !== null && result.status !== 0;
  if (result.error || nonZeroExit || killedBySignal) {
    let reason;
    if (result.error) {
      reason = result.error.message;
    } else if (killedBySignal) {
      reason = `killed by ${result.signal}`;
    } else {
      reason = `exit ${result.status}`;
    }
    console.error(`${VERSION_CHECK_LOG_PREFIX} bun install failed (${reason}); worker may crash with missing module errors`);
    // `bun install` often creates `node_modules/` BEFORE the failure point
    // (network timeout mid-fetch, OOM kill, registry 5xx after partial
    // resolution). The existence guard above would then permanently skip
    // retry on every subsequent Setup run, leaving the plugin broken with
    // no recovery path short of manual `rm -rf node_modules`. Remove the
    // partial dir so the next Setup invocation can retry automatically
    // (gh #2650 review).
    try {
      rmSync(join(pluginRoot, NODE_MODULES_DIRNAME), { recursive: true, force: true });
    } catch (rmErr) {
      const rmReason = rmErr && rmErr.message ? rmErr.message : String(rmErr);
      console.error(`${VERSION_CHECK_LOG_PREFIX} failed to clean up partial node_modules (${rmReason}); next Setup run may skip retry`);
    }
  } else {
    provisionTreeSitterCliBinary(pluginRoot);
    if (!hasCompletePluginDependencies(pluginRoot)) {
      console.error(`${VERSION_CHECK_LOG_PREFIX} plugin dependencies remain incomplete after install`);
      return;
    }
    // Close the diagnostic loop: a Setup hook that can block for up to
    // 120s needs an explicit completion line so users can distinguish a
    // hung install from one that finished silently (gh #2650 review).
    console.error(`${VERSION_CHECK_LOG_PREFIX} plugin dependencies installed successfully`);
  }
}

function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {}
  return null;
}

const ROOT = resolveRoot();
if (!ROOT) process.exit(0);

ensurePluginDependencies(ROOT);

function emitUpgradeHint(message) {
  if (process.env.CLAUDE_MEM_CODEX_HOOK === '1') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }));
  } else {
    console.error(message);
  }
}

const LEGACY_VERSION_MARKER_RE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readInstallMarkerVersion(markerPath) {
  const content = readFileSync(markerPath, 'utf-8');
  try {
    const marker = JSON.parse(content);
    return marker && typeof marker === 'object' && typeof marker.version === 'string'
      ? marker.version
      : null;
  } catch {
    const legacyVersion = content.trim();
    return LEGACY_VERSION_MARKER_RE.test(legacyVersion)
      ? legacyVersion.replace(/^v/i, '')
      : null;
  }
}

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const markerPath = join(ROOT, '.install-version');
  if (!existsSync(markerPath)) {
    emitUpgradeHint('claude-mem: runtime not yet set up - run: npx claude-mem@latest install');
    process.exit(0);
  }
  const markerVersion = readInstallMarkerVersion(markerPath);
  if (!markerVersion) {
    emitUpgradeHint('claude-mem: install marker unreadable - run: npx claude-mem@latest install');
  } else if (markerVersion !== pkg.version) {
    emitUpgradeHint(`claude-mem: upgraded to v${pkg.version} - run: npx claude-mem@latest install`);
  }
} catch {
  emitUpgradeHint('claude-mem: install marker unreadable - run: npx claude-mem@latest install');
}
process.exit(0);
