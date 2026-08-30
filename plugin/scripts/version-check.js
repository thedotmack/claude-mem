#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';
const VERSION_CHECK_LOG_PREFIX = '[version-check]';
const BUN_INSTALL_ARGS = Object.freeze(['install', '--production']);
const BUN_INSTALL_TIMEOUT_MS = 120_000;
const NODE_MODULES_DIRNAME = 'node_modules';
const INSTALL_COMPLETE_MARKER = '.claude-mem-install-complete';
const INSTALL_LOCK_DIRNAME = '.claude-mem-install.lock';
// A held lock older than this is assumed to belong to a process that was
// killed mid-install (e.g. the gh #3793 tree-kill) rather than one still
// running; BUN_INSTALL_TIMEOUT_MS is the longest a live install should ever
// hold it.
const INSTALL_LOCK_STALE_MS = BUN_INSTALL_TIMEOUT_MS + 30_000;

const INSTALL_LOCK_OWNER_FILE = 'owner';

/**
 * Acquire an exclusive, self-cleaning install lock so two Setup hooks racing
 * on the same pluginRoot (e.g. several Claude Code sessions launched at once,
 * gh #3793) cannot interleave: mkdir is atomic, so exactly one process wins.
 * A stale lock (holder was killed mid-install) is reclaimed after
 * INSTALL_LOCK_STALE_MS rather than blocking every future Setup run forever.
 *
 * Returns { lockPath, token } on success, or null if another process
 * currently owns it. `token` is a per-acquisition identity written into the
 * lock directory; releaseInstallLock only removes the lock if that token is
 * still the one on disk. Without this, a live-but-slow holder whose lock got
 * reclaimed as stale would, on reaching its own release, delete whatever
 * replacement lock now occupies the same path instead of nothing — handing
 * a third process the same false "it's free" signal (gh #3799 review).
 */
function acquireInstallLock(pluginRoot) {
  const lockPath = join(pluginRoot, INSTALL_LOCK_DIRNAME);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const claim = () => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, INSTALL_LOCK_OWNER_FILE), token);
    return { lockPath, token };
  };

  try {
    return claim();
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  let ageMs = Infinity;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Lock disappeared between the failed mkdir and this stat (the other
    // process finished) — fall through and retry acquisition below.
  }
  if (ageMs <= INSTALL_LOCK_STALE_MS) {
    return null;
  }

  // Reclaim atomically: rename the stale lock aside first, THEN mkdir a
  // fresh one. renameSync is a single winner-take-all filesystem op — if two
  // processes race to reclaim the same stale lock, only one rename succeeds;
  // the loser's rename throws ENOENT (source already moved) and backs off.
  // A naive rmSync-then-mkdirSync here (no shared atomic step between the
  // two racers) lets both believe they reclaimed it: the second rmSync
  // deletes the first's freshly-created lock, and both mkdirSync calls then
  // succeed in sequence (gh #3799 review).
  const staleAsidePath = `${lockPath}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockPath, staleAsidePath);
  } catch {
    return null;
  }
  try {
    rmSync(staleAsidePath, { recursive: true, force: true });
  } catch {
    // Non-fatal: orphaned under a unique name, won't be picked up by future
    // stale-lock checks (different path) — a cosmetic leak, not a hazard.
  }

  try {
    return claim();
  } catch {
    return null;
  }
}

function releaseInstallLock(lock) {
  if (!lock) return;
  const { lockPath, token } = lock;
  let currentToken;
  try {
    currentToken = readFileSync(join(lockPath, INSTALL_LOCK_OWNER_FILE), 'utf-8');
  } catch {
    // Owner file missing/unreadable: the lock is already gone, or mid-
    // replacement by a reclaimer. Nothing that's provably ours to remove.
    return;
  }
  if (currentToken !== token) {
    // Another process reclaimed this path as stale while we were still
    // alive. What's there now is its active lock, not ours — removing it
    // would repeat the exact bug this check exists to prevent.
    return;
  }
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.error(`${VERSION_CHECK_LOG_PREFIX} failed to release install lock (${reason})`);
  }
}

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
function ensurePluginDependencies(pluginRoot) {
  if (!existsSync(join(pluginRoot, 'package.json'))) return;

  const nodeModulesPath = join(pluginRoot, NODE_MODULES_DIRNAME);
  const markerPath = join(nodeModulesPath, INSTALL_COMPLETE_MARKER);

  // Guard on a completion marker written only after `bun install` exits 0,
  // not on node_modules existing. A worker version-mismatch tree-kill
  // (worker-utils.ts) SIGKILLs this script's whole process tree, including
  // this process itself, when this install runs as an observer descendant
  // (gh #3793). That leaves a partial node_modules with no chance for any
  // in-process cleanup to run. Trusting mere directory existence then skips
  // install forever, permanently short-circuiting on a broken plugin.
  if (existsSync(markerPath)) return;

  // Hold an exclusive lock for the rest of this function: a second Setup
  // hook racing on the same pluginRoot must never delete node_modules while
  // a peer is still installing into it (gh #3793 review). A process that
  // loses the race skips this Setup run entirely rather than touching
  // anything; the next Setup run (or the lock holder itself) retries.
  const lock = acquireInstallLock(pluginRoot);
  if (!lock) {
    console.error(`${VERSION_CHECK_LOG_PREFIX} another process is installing plugin dependencies; skipping this Setup run`);
    return;
  }

  try {
    // Re-check after acquiring the lock: the previous holder may have just
    // finished successfully while we were waiting.
    if (existsSync(markerPath)) return;

    if (existsSync(nodeModulesPath)) {
      // node_modules present without the completion marker means a previous
      // install was interrupted before finishing. Its mere presence also
      // disables Bun's own auto-install, so it must be removed before retrying.
      try {
        rmSync(nodeModulesPath, { recursive: true, force: true });
      } catch (rmErr) {
        const rmReason = rmErr && rmErr.message ? rmErr.message : String(rmErr);
        console.error(`${VERSION_CHECK_LOG_PREFIX} failed to remove incomplete node_modules (${rmReason}); worker may crash with missing module errors`);
        return;
      }
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
      result = spawnSync(bunPath, BUN_INSTALL_ARGS, {
        cwd: pluginRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: BUN_INSTALL_TIMEOUT_MS,
        windowsHide: true,
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
        rmSync(nodeModulesPath, { recursive: true, force: true });
      } catch (rmErr) {
        const rmReason = rmErr && rmErr.message ? rmErr.message : String(rmErr);
        console.error(`${VERSION_CHECK_LOG_PREFIX} failed to clean up partial node_modules (${rmReason}); next Setup run may skip retry`);
      }
    } else {
      // Close the diagnostic loop: a Setup hook that can block for up to
      // 120s needs an explicit completion line so users can distinguish a
      // hung install from one that finished silently (gh #2650 review).
      console.error(`${VERSION_CHECK_LOG_PREFIX} plugin dependencies installed successfully`);
      try {
        writeFileSync(markerPath, '');
      } catch (markerErr) {
        const markerReason = markerErr && markerErr.message ? markerErr.message : String(markerErr);
        console.error(`${VERSION_CHECK_LOG_PREFIX} failed to write install-complete marker (${markerReason}); next Setup run will reinstall`);
      }
    }
  } finally {
    releaseInstallLock(lock);
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
