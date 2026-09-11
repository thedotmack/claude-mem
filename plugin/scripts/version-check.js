#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { join, dirname, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';
const VERSION_CHECK_LOG_PREFIX = '[version-check]';
const BUN_INSTALL_ARGS = Object.freeze(['install', '--production']);
const BUN_INSTALL_TIMEOUT_MS = 120_000;
const NODE_MODULES_DIRNAME = 'node_modules';
// zod ships its public API behind subpath exports that worker-service.cjs
// requires directly (19 external zod requires, 4 of them `zod/v3`). The
// package directory existing does NOT imply these resolve - a stale or
// integrity-failed install leaves the dir in place while the subpaths break,
// surfacing as the `Cannot find module 'zod/v3'` crash in gh #3755 / #2730.
// Mirrors ZOD_REQUIRED_SUBPATHS in src/npx-cli/install/setup-runtime.ts:243.
const ZOD_REQUIRED_SUBPATHS = Object.freeze(['zod/v3', 'zod/v4', 'zod/v4-mini']);
// A fresh extract can have all ~26 declared deps missing at once; cap the
// diagnostic so the Setup transcript stays readable.
const MISSING_DEPS_LOG_LIMIT = 5;

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

// realpathSync throws on a path that does not exist (ENOENT) or that cannot be
// walked (EACCES). Falling back to the input keeps the containment check below
// total: an unresolvable path simply compares as itself and fails containment,
// which is the conservative answer.
function realpathOrSelf(candidatePath) {
  try {
    return realpathSync(candidatePath);
  } catch {
    return candidatePath;
  }
}

// True when `candidatePath` sits strictly inside `dirPath`. Uses path.relative
// rather than string prefixing so that a sibling directory sharing a name
// prefix (…/node_modules/zod-extra next to …/node_modules/zod) is not counted
// as inside, and so Windows path separators and casing are handled by the
// platform's own path logic.
function isInsideDir(candidatePath, dirPath) {
  const rel = relative(dirPath, candidatePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Completeness probe for the plugin's declared dependency closure.
//
// `verifyCriticalModules` in src/npx-cli/install/setup-runtime.ts:245 applies
// the same contract on the npx install path, but it is TypeScript ESM compiled
// into the npx bundle while this script is standalone and dependency-free (run
// by whatever Node the host provides), so the probe is inlined here rather than
// imported.
//
// It deliberately does NOT copy that function's resolution strategy. Presence
// is checked by statting inside this tree; see the comment on the loop below
// for why require.resolve cannot be trusted to stay tree-local. The same
// escape exists in verifyCriticalModules, where it is far less dangerous - it
// runs as a post-install assertion that fails loud, not as the gate deciding
// whether repair happens at all - but it is worth tightening there too.
//
// Returns the list of specifiers that are missing; an empty array means the
// install tree is complete.
function findMissingDependencies(pluginRoot) {
  try {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf-8'));
    } catch {
      // An unreadable or absent manifest is not this guard's problem to report:
      // the install-marker check further down already emits its own
      // `install marker unreadable` hint for exactly that state. Returning
      // "complete" here avoids double-reporting the same condition.
      return [];
    }

    const declared = Object.keys((pkg && pkg.dependencies) || {});
    // LOAD-BEARING: a manifest declaring no dependencies is complete by
    // definition. tests/plugin-version-check.test.ts builds precisely that
    // fixture (version-only package.json, empty node_modules) and asserts
    // stderr is exactly empty, so this early return must come before any
    // install attempt or diagnostic.
    if (declared.length === 0) return [];

    const nodeModulesPath = join(pluginRoot, NODE_MODULES_DIRNAME);
    const missing = [];

    // Presence is checked against THIS tree only, by direct stat rather than
    // require.resolve. `require.resolve(dep, { paths: [nodeModulesPath] })`
    // looks tree-scoped but is not: `paths` seeds Node's lookup, which then
    // walks every ancestor directory and always consults the global folders
    // ($HOME/.node_modules, $PREFIX/lib/node). Plugin roots live at
    // ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/, so a copy of a
    // dependency anywhere above them - or installed globally - would satisfy
    // the probe and let this guard report a gutted tree as complete, silently
    // reintroducing the very bug it exists to catch (gh #3872 review).
    //
    // Statting `<node_modules>/<dep>/package.json` cannot escape the tree, and
    // it is the same signal the repo already uses in
    // scripts/check-postinstall-allowlist.js:75-78. It also handles the two
    // awkward cases for free: scoped names split into their path segments, and
    // bin-only packages like `tree-sitter-cli` - whose package.json has `bin`
    // but no `main`/`module`/`exports`/`index.js`, so bare-name resolution
    // fails even when they are perfectly installed (gh #2730).
    for (const dep of declared) {
      if (!existsSync(join(nodeModulesPath, ...dep.split('/'), 'package.json'))) {
        missing.push(dep);
      }
    }

    // zod is the one package whose subpaths must be probed by real resolution:
    // they are `exports`-map entries, so a present-and-correct directory does
    // not imply `zod/v3` resolves (setup-runtime.ts:282, gh #2730). Skip it
    // when zod is absent or undeclared - the manifest may drop it later, and a
    // missing zod is already reported above.
    if (declared.indexOf('zod') !== -1 && missing.indexOf('zod') === -1) {
      // Anchored inside the install tree so the installed package's `exports`
      // map is what gets consulted (setup-runtime.ts:250-252).
      const requireFromPlugin = createRequire(join(nodeModulesPath, 'noop.js'));
      // Both sides are realpath'd before comparison: bun can materialise
      // node_modules entries as links into a shared store, and Node returns
      // the real path of what it resolved. Comparing the two literally would
      // then report a healthy linked install as missing and loop the install
      // forever.
      const zodDir = realpathOrSelf(join(nodeModulesPath, 'zod'));
      for (const subpath of ZOD_REQUIRED_SUBPATHS) {
        let resolved;
        try {
          resolved = requireFromPlugin.resolve(subpath, { paths: [nodeModulesPath] });
        } catch {
          missing.push(subpath);
          continue;
        }
        // Same ancestor/global escape as above: a host-level zod could answer
        // for the plugin's. Only a path inside this plugin's own zod counts.
        if (!isInsideDir(realpathOrSelf(resolved), zodDir)) missing.push(subpath);
      }
    }

    return missing;
  } catch {
    // This probe runs inside the Setup hook. An unexpected throw (an exotic
    // createRequire failure, an EACCES walking the tree) must never take Setup
    // down - degrade to "assume complete" and let the worker surface the real
    // error rather than blocking Claude Code startup here.
    return [];
  }
}

// Cap the named-module list so a fresh extract (every dep missing) does not
// bury the Setup transcript.
function formatMissing(missing) {
  if (missing.length <= MISSING_DEPS_LOG_LIMIT) return missing.join(', ');
  return missing.slice(0, MISSING_DEPS_LOG_LIMIT).join(', ') + ', +' + (missing.length - MISSING_DEPS_LOG_LIMIT) + ' more';
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

  // Guard on COMPLETENESS of the declared dependency closure, not on the mere
  // existence of node_modules. A tree that is simply present - because an
  // install was interrupted mid-fetch, or because it was complete for an older
  // version before a new dependency was added - satisfied the old existence
  // check and permanently short-circuited repair on every subsequent Setup run.
  // The worker then died at boot with `Cannot find module 'zod/v3'` while
  // memory search kept working (mcp-server.cjs bundles zod), so the breakage
  // was silent: users saw search succeed and never learned the worker was dead
  // (gh #3755). Deriving the expected set from package.json `dependencies`
  // keeps the check correct if dependencies are later renamed.
  const missingBefore = findMissingDependencies(pluginRoot);
  if (missingBefore.length === 0) return;

  const bunPath = findBun();
  if (!bunPath) {
    console.error(`${VERSION_CHECK_LOG_PREFIX} bun not found on PATH; cannot auto-install plugin dependencies`);
    return;
  }

  // Progress diagnostic so users understand the Setup hang - and, critically,
  // so this failure mode stops being silent: name the modules that are actually
  // unresolvable rather than implying a first run (gh #3755).
  console.error(`${VERSION_CHECK_LOG_PREFIX} installing plugin dependencies (missing: ${formatMissing(missingBefore)})...`);

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
    // The partial `node_modules/` a failed install leaves behind is deliberately
    // PRESERVED. Retry no longer depends on deleting it: the completeness guard
    // above re-detects the missing deps on the next Setup run, so the old
    // recursive delete bought nothing - while actively destroying packages that
    // still work. A half-installed tree still powers memory search (mcp-server.cjs
    // bundles zod, zero external requires), so nuking it turns a degraded
    // install into a dead one (gh #3755).
  } else {
    // A zero exit is NOT proof of a complete tree: `bun install` can exit 0
    // while its integrity check silently failed, leaving the closure short
    // (reported on gh #3755). Re-run the probe and report what actually
    // resolves now rather than trusting the exit code.
    //
    // This second probe assumes a resolver that does NOT negatively cache the
    // lookups the first probe just missed. Node is that resolver, and the Setup
    // hook invokes this script under node explicitly (plugin/hooks/hooks.json:11
    // ends in `node "$_P/scripts/version-check.js"`). Bun caches negative CJS
    // lookups process-wide, so running this file under bun would make the
    // re-check cry wolf on every successful fresh install. Keep the hook on node.
    const missingAfter = findMissingDependencies(pluginRoot);
    if (missingAfter.length === 0) {
      // Close the diagnostic loop: a Setup hook that can block for up to
      // 120s needs an explicit completion line so users can distinguish a
      // hung install from one that finished silently (gh #2650 review).
      console.error(`${VERSION_CHECK_LOG_PREFIX} plugin dependencies installed successfully`);
    } else {
      console.error(`${VERSION_CHECK_LOG_PREFIX} bun install exited 0 but dependencies are still missing: ${formatMissing(missingAfter)}; worker may crash with missing module errors`);
    }
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
