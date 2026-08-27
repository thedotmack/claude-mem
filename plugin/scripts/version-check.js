#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';
const VERSION_CHECK_LOG_PREFIX = '[version-check]';
const BUN_INSTALL_ARGS = Object.freeze(['install', '--production']);
const BUN_INSTALL_TIMEOUT_MS = 120_000;
const NODE_MODULES_DIRNAME = 'node_modules';

function findBun() {
  const pathCheck = IS_WINDOWS
    ? spawnSync('where', ['bun'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawnSync('which', ['bun'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    if (IS_WINDOWS) {
      const bunCmdPath = pathCheck.stdout.split('\n').find((line) => line.trim().endsWith('bun.cmd'));
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
// Names of declared dependencies that do not resolve to an installed package.
// Reads package.json rather than naming any package, so the check stays correct
// if dependencies are later renamed or added.
function missingDependencies(pluginRoot) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf-8'));
  } catch {
    // An unreadable package.json is not something an install can fix, and
    // reporting every dependency as missing would loop on it. Report none.
    return [];
  }

  const declared = Object.keys((pkg && pkg.dependencies) || {});
  return declared.filter(
    (name) => !existsSync(join(pluginRoot, NODE_MODULES_DIRNAME, ...name.split('/'), 'package.json')),
  );
}

function ensurePluginDependencies(pluginRoot) {
  if (!existsSync(join(pluginRoot, 'package.json'))) return;

  // Guard on COMPLETENESS, not on the mere existence of node_modules.
  //
  // The directory existing only tells us a package manager started. An
  // install interrupted by anything this script did not spawn — a killed
  // terminal, a half-finished extraction — leaves node_modules in place but
  // short of packages, and an existence check then skips the repair on every
  // later Setup run. The worker dies on the missing module each boot with no
  // recovery short of a manual rm -rf (#3755).
  //
  // Each declared dependency must resolve to its own package.json: one
  // existsSync per dependency, and it re-verifies the tree rather than
  // trusting a previous installer's exit code.
  const missing = missingDependencies(pluginRoot);
  if (missing.length === 0) return;

  if (existsSync(join(pluginRoot, NODE_MODULES_DIRNAME))) {
    console.error(
      `${VERSION_CHECK_LOG_PREFIX} node_modules is incomplete (missing: ${missing.join(', ')}); reinstalling`,
    );
  }

  const bunPath = findBun();
  if (!bunPath) {
    console.error(`${VERSION_CHECK_LOG_PREFIX} bun not found on PATH; cannot auto-install plugin dependencies`);
    return;
  }

  // Progress diagnostic so users understand the (one-time) Setup hang.
  console.error(`${VERSION_CHECK_LOG_PREFIX} installing plugin dependencies (first run, one-time)...`);

  let result;
  try {
    // Windows: findBun resolves to bun.cmd (npm/nvm shim) or, failing that,
    // the bare name. Node refuses to spawn a .cmd/.bat directly since the
    // CVE-2024-27980 mitigation — spawnSync throws EINVAL — and a bare name
    // is not resolved through PATHEXT either, so both shapes need a shell.
    // BUN_INSTALL_ARGS is a frozen constant, so the concatenation the shell
    // option performs carries nothing user-supplied; the path itself is
    // quoted because it routinely contains spaces.
    const command = IS_WINDOWS ? `"${bunPath}"` : bunPath;
    result = spawnSync(command, BUN_INSTALL_ARGS, {
      cwd: pluginRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: BUN_INSTALL_TIMEOUT_MS,
      windowsHide: true,
      shell: IS_WINDOWS,
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
