/**
 * `claude-mem` on-PATH hook launcher (plan-17 #3605, Hook Wrapper Contract).
 *
 * Claude Code runs every hook in exec form, with no shell:
 *   { "command": "claude-mem", "args": ["hook", "claude-code", "<event>"] }
 * This launcher's only job is to find the installed plugin root, run
 * `<root>/scripts/worker-service.cjs <args…>` under Bun with the same argv
 * (plus the hook's stdin for `hook`), and fail open (exit 0 + one stderr line)
 * on every failure. Subcommands are never interpreted here, so new worker
 * subcommands work without recompiling the on-PATH binary.
 *
 * VERSION-STABLE: the compiled binary sits on PATH and is not refreshed by
 * marketplace auto-update, so it must carry no claude-mem logic that changes
 * between releases. Every block below is a port of an existing shell-free
 * resolver or of plugin/scripts/bun-runner.js — no handlers, no HTTP, and no
 * imports from the worker, hook handlers or shared worker helpers (Phase 6
 * sweep greps this directory for those paths).
 * Bump LAUNCHER_PROTOCOL (src/launcher/launcher-protocol.ts) only when the
 * launcher's contract with hooks.json or the installer changes.
 *
 * Runs as `bun`/`node plugin/scripts/claude-mem-launcher.cjs` and as a
 * `bun build --compile` binary (process.argv[0..1] is runtime + entry in both).
 */
import { spawn, spawnSync, type SpawnOptions } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { LAUNCHER_PROTOCOL } from './launcher-protocol.js';

const IS_WINDOWS = process.platform === 'win32';
const STDIN_COLLECTION_TIMEOUT_MS = 5000;
const USAGE_TEXT = 'usage: claude-mem hook <platform> <event> | claude-mem <worker-service subcommand> | claude-mem --version';
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/**
 * Fail-open exit, matching hookCommand() in the CLI hook pipeline: an unexpected claude-mem
 * failure never blocks the user. Exit 2 means "block" to Claude Code (dropped
 * prompt, denied tool, Stop re-wake loop), so this launcher never exits 2.
 */
function exitContinuingWithoutMemory(reason: string): never {
  process.stderr.write(`claude-mem: ${reason}, continuing without memory\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Plugin root resolution. Ported from buildCodexWindowsCommand and
// buildMcpNodeLauncher in src/build/hook-shell-template.ts. Order:
// $CLAUDE_PLUGIN_ROOT, $PLUGIN_ROOT, version-sorted cache (orphans skipped),
// then the marketplace install dir.
// ---------------------------------------------------------------------------

function resolveClaudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

// parseVersionTriple/compareCacheVersionNamesDescending mirror
// compareVersionsDescending in the shared worker helpers: highest
// major.minor.patch first, a release ahead of a prerelease at the same base.
// Every resolver ranking candidates identically (by version, never mtime) is
// the restart-storm invariant (2026-07-22).
function parseVersionTriple(versionName: string): [number, number, number] {
  const versionParts = versionName.split('-')[0].split('.');
  return [
    parseInt(versionParts[0], 10) || 0,
    parseInt(versionParts[1], 10) || 0,
    parseInt(versionParts[2], 10) || 0,
  ];
}

function compareCacheVersionNamesDescending(leftName: string, rightName: string): number {
  const leftVersion = parseVersionTriple(leftName);
  const rightVersion = parseVersionTriple(rightName);
  return (
    (rightVersion[0] - leftVersion[0]) ||
    (rightVersion[1] - leftVersion[1]) ||
    (rightVersion[2] - leftVersion[2]) ||
    ((leftName.indexOf('-') < 0 ? 0 : 1) - (rightName.indexOf('-') < 0 ? 0 : 1)) ||
    (leftName < rightName ? 1 : leftName > rightName ? -1 : 0)
  );
}

/** Version dirs under the plugin cache, highest first, skipping Claude Code's .orphaned_at-stamped dirs. */
function listCacheVersionRootsDescending(cacheDirectory: string): string[] {
  try {
    return readdirSync(cacheDirectory)
      .filter((entryName) => {
        const firstCharacter = entryName.charAt(0);
        return firstCharacter >= '0' && firstCharacter <= '9';
      })
      .map((entryName) => join(cacheDirectory, entryName))
      .filter((versionRoot) => {
        try {
          return statSync(versionRoot).isDirectory() && !existsSync(join(versionRoot, '.orphaned_at'));
        } catch {
          return false;
        }
      })
      .sort((leftRoot, rightRoot) => compareCacheVersionNamesDescending(basename(leftRoot), basename(rightRoot)));
  } catch {
    return [];
  }
}

function resolvePluginRootForLauncher(): string | null {
  const claudeConfigDirectory = resolveClaudeConfigDirectory();
  const candidateRoots: string[] = [];
  for (const environmentRoot of [process.env.CLAUDE_PLUGIN_ROOT, process.env.PLUGIN_ROOT]) {
    if (environmentRoot) candidateRoots.push(environmentRoot);
  }
  candidateRoots.push(
    ...listCacheVersionRootsDescending(join(claudeConfigDirectory, 'plugins', 'cache', 'thedotmack', 'claude-mem')),
  );
  candidateRoots.push(join(claudeConfigDirectory, 'plugins', 'marketplaces', 'thedotmack', 'plugin'));

  for (const candidateRoot of candidateRoots) {
    // Same normalization as the bash template's `_E` handling: trim a trailing
    // separator, and step into `plugin/` when the candidate is a repo-shaped
    // checkout (`<root>/plugin/scripts`) rather than the plugin dir itself.
    const trimmedRoot = candidateRoot.replace(/[\\/]+$/, '') || candidateRoot;
    const pluginRoot = existsSync(join(trimmedRoot, 'plugin', 'scripts')) ? join(trimmedRoot, 'plugin') : trimmedRoot;
    if (existsSync(join(pluginRoot, 'scripts', 'worker-service.cjs'))) {
      return pluginRoot;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin-disabled check, Bun discovery, stdin buffering, empty-stdin
// diagnostic and spawn: ported from plugin/scripts/bun-runner.js.
// ---------------------------------------------------------------------------

function isPluginDisabledInClaudeSettings(): boolean {
  try {
    const settingsPath = join(resolveClaudeConfigDirectory(), 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return Boolean(
      settings &&
      settings.enabledPlugins &&
      settings.enabledPlugins['claude-mem@thedotmack'] === false
    );
  } catch {
    return false;
  }
}

/** Ported verbatim from bun-runner.js findBun(): PATH first, then explicit overrides and well-known homes. */
function findBun(): string | null {
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

  if (pathCheck.status === 0 && pathCheck.stdout && pathCheck.stdout.trim()) {
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

  const bunInstall = typeof process.env.BUN_INSTALL === 'string' ? process.env.BUN_INSTALL.trim() : '';
  const bunEnv = typeof process.env.BUN === 'string' ? process.env.BUN.trim() : '';
  const bunPathEnv = typeof process.env.BUN_PATH === 'string' ? process.env.BUN_PATH.trim() : '';

  // Explicit overrides + BUN_INSTALL (official installer) + well-known homes.
  // Hook PATH from Git Bash often omits ~/.bun/bin (#3224).
  const bunPaths = IS_WINDOWS
    ? [
        bunEnv,
        bunPathEnv,
        bunInstall ? join(bunInstall, 'bin', 'bun.exe') : '',
        bunInstall ? join(bunInstall, 'bin', 'bun') : '',
        bunInstall ? join(bunInstall, 'bun.exe') : '',
        join(homedir(), '.bun', 'bin', 'bun.exe'),
      ]
    : [
        bunEnv,
        bunPathEnv,
        bunInstall ? join(bunInstall, 'bin', 'bun') : '',
        bunInstall ? join(bunInstall, 'bun') : '',
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun'
      ];

  for (const bunPath of bunPaths) {
    if (bunPath && existsSync(bunPath)) {
      return bunPath;
    }
  }

  return null;
}

/**
 * True when this process is a `bun build --compile` binary (the on-PATH
 * `claude-mem`), not `bun`/`node` running the bundle as a script. Only then can
 * `BUN_BE_BUN=1` turn our own executable into the bun CLI (SPIKE item 7).
 */
function isRunningAsCompiledBunExecutable(): boolean {
  if (!process.versions.bun) return false;
  const executableName = basename(process.execPath).toLowerCase().replace(/\.exe$/, '');
  return executableName !== 'bun' && executableName !== 'node';
}

interface BunRuntimeSelection {
  bunExecutablePath: string;
  extraEnvironment: Record<string, string>;
}

/**
 * findBun is primary so the worker and its daemon keep the user's real `bun`
 * as process.execPath and track its version (SPIKE Decision 3). BUN_BE_BUN on
 * our own executable is the fallback for machines where Bun was removed.
 */
function selectBunRuntime(): BunRuntimeSelection | null {
  const discoveredBunPath = findBun();
  if (discoveredBunPath) {
    return { bunExecutablePath: discoveredBunPath, extraEnvironment: {} };
  }
  if (isRunningAsCompiledBunExecutable()) {
    // BUN_BE_BUN rides in the child's env, so the worker (and any daemon it
    // spawns via process.execPath) inherits it — only on this fallback path.
    return { bunExecutablePath: process.execPath, extraEnvironment: { BUN_BE_BUN: '1' } };
  }
  return null;
}

function collectStdin(): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    const collectionTimeout = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    }, STDIN_COLLECTION_TIMEOUT_MS);
    const finish = (stdinData: Buffer | null) => {
      clearTimeout(collectionTimeout);
      resolve(stdinData);
    };
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      finish(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
    process.stdin.on('error', () => {
      finish(null);
    });
  });
}

/**
 * Issue #2188: an empty hook payload once got masked by a `|| '{}'` fallback,
 * hiding broken-shell captures. Surface it on stderr, persist it to
 * runner-errors.log, and drop the CAPTURE_BROKEN marker the next session-start
 * hint reads. Exit 0: the marker file, not the exit code, is the durable signal.
 */
function reportEmptyStdinAndExit(stdinData: Buffer | null, workerScriptPath: string, pluginRoot: string): never {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  const payloadType = stdinData === null
    ? 'null (no data event or stream error)'
    : 'empty Buffer (zero bytes received)';
  const diagnostic = [
    `[claude-mem-launcher] empty stdin payload received — issue #2188`,
    `  script: ${workerScriptPath}`,
    `  payload byte length: ${stdinData ? stdinData.length : 0}`,
    `  payload type: ${payloadType}`,
    `  platform: ${process.platform}`,
    `  shell: ${process.env.SHELL || 'n/a'}`,
    `  stdin TTY: ${process.stdin.isTTY === true ? 'true' : process.stdin.isTTY === false ? 'false' : 'undefined'}`,
    `  timestamp: ${new Date().toISOString()}`,
    `  CLAUDE_PLUGIN_ROOT: ${pluginRoot}`,
  ].join('\n');

  process.stderr.write(diagnostic + '\n');

  try {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(join(logsDir, 'runner-errors.log'), diagnostic + '\n\n');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'CAPTURE_BROKEN'), diagnostic + '\n');
  } catch (writeError) {
    process.stderr.write(`[claude-mem-launcher] failed to persist diagnostic: ${writeError instanceof Error ? writeError.message : writeError}\n`);
  }

  process.exit(0);
}

async function runThroughWorker(workerServiceArguments: string[]): Promise<never> {
  if (isPluginDisabledInClaudeSettings()) {
    process.exit(0);
  }

  const pluginRoot = resolvePluginRootForLauncher();
  if (!pluginRoot) {
    exitContinuingWithoutMemory('plugin scripts not found');
  }
  const workerScriptPath = join(pluginRoot, 'scripts', 'worker-service.cjs');

  const bunRuntime = selectBunRuntime();
  if (!bunRuntime) {
    exitContinuingWithoutMemory('Bun not found (install Bun, then restart your terminal)');
  }

  // Only `hook` carries a payload. Every other subcommand (start, stop, …) gets
  // the treatment bun-runner gives lifecycle commands with no payload: stdin is
  // not read, the child's pipe is closed, and the child runs.
  const isHookInvocation = workerServiceArguments[0] === 'hook';
  let stdinData: Buffer | null = null;
  if (isHookInvocation) {
    stdinData = await collectStdin();
    // A hook always needs a payload, so an empty one is reported before spawning.
    if (!stdinData || stdinData.length === 0) {
      reportEmptyStdinAndExit(stdinData, workerScriptPath, pluginRoot);
    }
  }

  const workerArguments = [workerScriptPath, ...workerServiceArguments];
  const spawnOptions: SpawnOptions = {
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
    env: { ...process.env, ...bunRuntime.extraEnvironment },
  };
  let spawnCommand = bunRuntime.bunExecutablePath;
  let spawnArguments = workerArguments;

  // Only .cmd/.bat shims need cmd.exe; a resolved bun.exe must be spawned
  // directly. Routing it through `shell: true` breaks when the environment
  // grows past cmd.exe's ~8191-char per-variable limit (issue #3196).
  const needsCmdShell = IS_WINDOWS && /\.(cmd|bat)$/i.test(bunRuntime.bunExecutablePath);
  if (needsCmdShell) {
    const quote = (value: string) => `"${String(value).replace(/"/g, '\\"')}"`;
    spawnOptions.shell = true;
    spawnCommand = [bunRuntime.bunExecutablePath, ...workerArguments].map(quote).join(' ');
    spawnArguments = [];
  }

  return new Promise<never>(() => {
    const child = spawn(spawnCommand, spawnArguments, spawnOptions);
    // Same forwarding as buildMcpNodeLauncher in src/build/hook-shell-template.ts.
    for (const forwardedSignal of FORWARDED_SIGNALS) {
      process.on(forwardedSignal, () => {
        try { child.kill(forwardedSignal); } catch {}
      });
    }

    child.on('error', (spawnError) => {
      exitContinuingWithoutMemory(`failed to start Bun (${spawnError.message})`);
    });

    child.on('close', (exitCode, exitSignal) => {
      if (exitCode === 0) {
        process.exit(0);
      }
      exitContinuingWithoutMemory(`worker exited ${exitSignal ?? exitCode}`);
    });

    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (stdinData) child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}

async function main(): Promise<void> {
  const launcherArguments = process.argv.slice(2);

  if (launcherArguments.length === 0) {
    // stderr, not stdout: Claude Code parses hook stdout as JSON.
    process.stderr.write(`${USAGE_TEXT}\n`);
    process.exit(0);
  }

  if (launcherArguments[0] === '--version') {
    process.stdout.write(`${LAUNCHER_PROTOCOL}\n`);
    process.exit(0);
  }

  await runThroughWorker(launcherArguments);
}

main().catch((unexpectedError: unknown) => {
  exitContinuingWithoutMemory(
    `launcher error (${unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError)})`,
  );
});
