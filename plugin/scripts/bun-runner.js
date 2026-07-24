#!/usr/bin/env node
import { spawnSync, spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const IS_WINDOWS = process.platform === 'win32';

const __bun_runner_dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVED_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__bun_runner_dirname, '..');

function fixBrokenScriptPath(argPath) {
  if (argPath.startsWith('/scripts/') && !existsSync(argPath)) {
    const fixedPath = join(RESOLVED_PLUGIN_ROOT, argPath);
    if (existsSync(fixedPath)) {
      return fixedPath;
    }
  }
  return argPath;
}

function findBun() {
  const pathCheck = IS_WINDOWS
    ? spawnSync('where', ['bun'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    : spawnSync('which', ['bun'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    if (IS_WINDOWS) {
      const bunPaths = pathCheck.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const firstBunPath = bunPaths.find(line => {
        const lowerPath = line.toLowerCase();
        return lowerPath.endsWith('bun.exe') || lowerPath.endsWith('bun.cmd');
      });
      const firstBunDir = firstBunPath ? dirname(firstBunPath).toLowerCase() : null;
      const firstInstallPaths = firstBunDir
        ? bunPaths.filter(line => dirname(line).toLowerCase() === firstBunDir)
        : [];
      const bunExePath = firstInstallPaths.find(line => line.toLowerCase().endsWith('bun.exe'));
      if (bunExePath) {
        return bunExePath;
      }
      const bunCmdPath = firstInstallPaths.find(line => line.toLowerCase().endsWith('bun.cmd'));
      if (bunCmdPath) {
        return bunCmdPath;
      }
      // The official installer ships bun.exe only (no bun.cmd shim). Return
      // the resolved absolute path instead of falling through to the bare
      // name: resolving a bare `bun` later relies on the child's PATH, which
      // cmd.exe drops entirely when it exceeds ~8191 chars (issue #3196).
      const firstWherePath = pathCheck.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
      if (firstWherePath) {
        return firstWherePath;
      }
    }
    return 'bun';
  }

  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun'
      ];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      return bunPath;
    }
  }

  return null;
}

function isPluginDisabledInClaudeSettings() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // No optional chaining (?.) here: this launcher must parse on the oldest
    // Node that any host might invoke it with. Some Claude Code installs run
    // hooks under a bundled pre-ES2020 Node whose ESM loader throws
    // "SyntaxError: Unexpected token '.'" on `?.` (issue #2791).
    return Boolean(
      settings &&
      settings.enabledPlugins &&
      settings.enabledPlugins['claude-mem@thedotmack'] === false
    );
  } catch {
    return false;
  }
}

if (isPluginDisabledInClaudeSettings()) {
  process.exit(0);
}

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node bun-runner.js <script> [args...]');
  process.exit(1);
}

args[0] = fixBrokenScriptPath(args[0]);

const bunPath = findBun();

if (!bunPath) {
  console.error('Error: Bun not found. Please install Bun: https://bun.sh');
  console.error('After installation, restart your terminal.');
  process.exit(1);
}

// Runtime self-heal: ensure the worker's externalized deps are present in
// plugin/node_modules before we spawn it. The build-time install + tarball
// bundling (build-hooks.js + package.json `files`) covers the npm channel,
// but the MARKETPLACE channel is a `git clone` of this repo where
// `plugin/node_modules` is gitignored and never committed — so a freshly
// installed marketplace plugin has no node_modules and every hook crashes
// with `Cannot find module 'zod/v3'` (issues #2407 / #2453 / #2640 / #2379).
// We can't fix that at build time (the install output is gitignored), so we
// heal once here, on first run, before the worker is invoked.
function ensureRuntimeDeps() {
  let pkgJsonPath;
  try {
    pkgJsonPath = join(RESOLVED_PLUGIN_ROOT, 'package.json');
    if (!existsSync(pkgJsonPath)) return; // not a plugin root with deps
    const pluginRequire = createRequire(pkgJsonPath);
    pluginRequire.resolve('zod/v3'); // resolves → deps present, nothing to do
    return;
  } catch {
    // zod/v3 unresolvable → install the one hook-critical EXTERNAL dep once.
    // The worker bundle marks `zod` external (see scripts/build-hooks.js), so it
    // must exist in plugin/node_modules or every hook crashes with
    // `Cannot find module 'zod/v3'`. shell-quote is *bundled* into the worker
    // (it appears in no `external` list), so it does NOT need a runtime install.
    // We install with --ignore-scripts: npm resolves the full dep tree from the
    // existing package.json, and the tree-sitter grammars are native node-gyp
    // builds — on a Node version without a prebuilt binding (e.g. Node 26) a
    // grammar build fails and aborts the whole install, leaving zod uninstalled.
    // --ignore-scripts skips those native postinstalls (zod is pure JS and needs
    // none), so the hook always recovers. Grammar/code-graph deps heal
    // separately via `npx claude-mem install` and aren't required for hooks.
    //
    // stdio fd1 is 'ignore', NOT 'inherit': this process's stdout IS the Claude
    // Code hook-response channel. npm prints its "added N packages" summary to
    // stdout, which would prepend to the hook JSON and break parsing on exactly
    // the fresh-install path this self-heal exists to fix. npm errors go to
    // stderr (fd2='inherit'), and we emit our own status lines to stderr below.
    console.error('[bun-runner] plugin/node_modules missing zod — installing hook-critical deps (first run on this install)...');

    // hooks.json registers two SessionStart command hooks (matcher
    // startup|clear|compact), so on a fresh marketplace install two
    // bun-runner processes hit this catch near-simultaneously against the same
    // RESOLVED_PLUGIN_ROOT and would otherwise both run `npm install` in the
    // same cwd — a concurrent-write race that can corrupt node_modules. Gate
    // the install behind an atomic O_EXCL lock file so exactly one process
    // heals; the other skips straight to the re-verify below (which observes
    // the holder's success, or self-heals on the next hook if it lost the race).
    const lockPath = join(RESOLVED_PLUGIN_ROOT, '.claude-mem-heal.lock');
    // Stale-lock reclaim: a crashed/killed holder must not block heal forever.
    // TTL is >= the 60s hook timeout so we never steal a lock a live holder is
    // still working under. Best-effort — a peer may win this unlink, which is fine.
    const LOCK_TTL_MS = 120000;
    try {
      if (existsSync(lockPath) && (Date.now() - statSync(lockPath).mtimeMs) > LOCK_TTL_MS) {
        unlinkSync(lockPath);
      }
    } catch {}

    let haveLock = false;
    try {
      // 'wx' === O_CREAT | O_EXCL | O_WRONLY: atomic create-or-fail on POSIX
      // and Windows Node. EEXIST → another process holds it; skip the install.
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      haveLock = true;
    } catch {}

    if (haveLock) {
      try {
        const install = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', 'zod@^4.4.3'], {
          cwd: RESOLVED_PLUGIN_ROOT,
          stdio: ['ignore', 'ignore', 'inherit'],
          // npm on Windows is a .cmd shim — spawn without shell hits ENOENT.
          shell: IS_WINDOWS,
        });
        if (install.error) {
          console.error(`[bun-runner] could not run npm install in ${RESOLVED_PLUGIN_ROOT}: ${install.error.message}`);
        } else if (install.status !== 0) {
          console.error(`[bun-runner] npm install exited with code ${install.status}. Run \`cd ${RESOLVED_PLUGIN_ROOT} && npm install\` manually.`);
        }
      } finally {
        try { unlinkSync(lockPath); } catch {}
      }
    }

    // Post-install re-verify (covers both the heal we just ran and the skip-
    // because-locked path). Use a fresh createRequire scoped to the plugin
    // package.json so the resolve runs against the now-populated node_modules.
    // Best-effort/non-blocking: log only — the worker spawn proceeds regardless
    // and crashes loudly if truly unhealed, now with this clearer preceding line.
    try {
      createRequire(pkgJsonPath).resolve('zod/v3');
      console.error('[bun-runner] runtime deps installed.');
    } catch {
      console.error(`[bun-runner] heal failed — zod/v3 still unresolved after npm install. Run \`cd ${RESOLVED_PLUGIN_ROOT} && npm install\` manually.`);
    }
  }
}

ensureRuntimeDeps();

function collectStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
    process.stdin.on('error', () => {
      resolve(null);
    });

    setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    }, 5000);
  });
}

const stdinData = await collectStdin();

const spawnOptions = {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env
};

let spawnCmd = bunPath;
let spawnArgs = args;

// Only .cmd/.bat shims need cmd.exe; a resolved bun.exe must be spawned
// directly. Routing it through `shell: true` breaks when the environment
// grows past cmd.exe's ~8191-char per-variable limit (e.g. a long PATH,
// which these hooks double via the login-shell prepend): cmd silently
// sees an empty PATH and fails with `"bun" is not recognized` even though
// `where bun` succeeded moments earlier (issue #3196).
const needsCmdShell = IS_WINDOWS && /\.(cmd|bat)$/i.test(bunPath);

if (needsCmdShell) {
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  spawnOptions.shell = true;
  spawnCmd = [bunPath, ...args].map(quote).join(' ');
  spawnArgs = [];
}

const child = spawn(spawnCmd, spawnArgs, spawnOptions);

if (child.stdin) {
  if (stdinData && stdinData.length > 0) {
    child.stdin.write(stdinData);
    child.stdin.end();
  } else {
    // Lifecycle subcommands (start, stop, restart, status) never consume stdin —
    // they manage the worker daemon, not hook payloads.  Killing the child here
    // prevents the daemon from starting/stopping on platforms where Claude Code
    // doesn't pipe a payload for SessionStart (e.g. Windows CC ≤ 2.1.145).
    const lifecycleCommands = ['start', 'stop', 'restart', 'status'];
    const isLifecycle = lifecycleCommands.some(cmd => args.includes(cmd));

    if (isLifecycle) {
      // Lifecycle commands don't need stdin — close pipe and let child run.
      try { child.stdin.end(); } catch {}
    } else {
      // Issue #2188: empty/missing stdin previously masked by `|| '{}'` fallback,
      // which silently hid WSL bash failures (e.g. hooks invoked under a broken
      // shell that never piped a payload). Surface the failure mode instead.
      const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
      const payloadType = stdinData === null
        ? 'null (no data event or stream error)'
        : stdinData === undefined
          ? 'undefined'
          : Buffer.isBuffer(stdinData) && stdinData.length === 0
            ? 'empty Buffer (zero bytes received)'
            : `unexpected (${typeof stdinData})`;
      const payloadByteLength = (stdinData && typeof stdinData.length === 'number')
        ? stdinData.length
        : 0;
      const diagnostic = [
        `[bun-runner] empty stdin payload received — issue #2188`,
        `  script: ${args[0]}`,
        `  payload byte length: ${payloadByteLength}`,
        `  payload type: ${payloadType}`,
        `  platform: ${process.platform}`,
        `  shell: ${process.env.SHELL || 'n/a'}`,
        `  stdin TTY: ${process.stdin.isTTY === true ? 'true' : process.stdin.isTTY === false ? 'false' : 'undefined'}`,
        `  timestamp: ${new Date().toISOString()}`,
        `  CLAUDE_PLUGIN_ROOT: ${RESOLVED_PLUGIN_ROOT}`,
      ].join('\n');

      // IO discipline (see src/shared/hook-io.ts intent vocabulary):
      // - this stderr write is a USER_HINT (Claude Code surfaces it inline).
      // - the CAPTURE_BROKEN marker file below is a DIAGNOSTIC durable signal for
      //   the next session-start hint.
      // - exit 0 below is the EXIT_SIGNAL per CLAUDE.md (Windows Terminal tab
      //   management); the marker file, not the exit code, is the durable failure
      //   signal. bun-runner runs in its own node process BEFORE hookCommand's
      //   stderr buffer is installed, so this write is never swallowed.

      // Write to stderr so Claude Code surfaces the diagnostic.
      console.error(diagnostic);

      // Persist diagnostic to the runner-errors log and drop a CAPTURE_BROKEN marker
      // file so the next session-start hint can surface the failure. We exit 0 to
      // honor the project's exit-code strategy (worker/hook errors exit 0 to
      // prevent Windows Terminal tab pileup) — the marker file is the durable
      // signal that something is wrong, not the exit code.
      try {
        const logsDir = join(dataDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        appendFileSync(join(logsDir, 'runner-errors.log'), diagnostic + '\n\n');
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'CAPTURE_BROKEN'), diagnostic + '\n');
      } catch (writeErr) {
        console.error(`[bun-runner] failed to persist diagnostic: ${writeErr && writeErr.message ? writeErr.message : writeErr}`);
      }

      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
      process.exit(0);
    }
  }
}

child.on('error', (err) => {
  // EXCEPTION to CLAUDE.md exit-0-on-error: Bun-not-found is a user environment
  // problem, not a hook execution failure. Surfacing exit 1 here forces Claude
  // Code to display the stderr message rather than silently retrying. This runs
  // before any hook handler, so the exit-0 tab-management rationale doesn't apply.
  console.error(`Failed to start Bun: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if ((signal || code > 128) && args.includes('start')) {
    process.exit(0);
  }
  process.exit(code || 0);
});
