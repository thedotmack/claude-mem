#!/usr/bin/env node
import { spawnSync, spawn } from 'child_process';
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

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
    ? spawnSync('where bun', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true
      })
    : spawnSync('which', ['bun'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    if (IS_WINDOWS) {
      const bunCmdPath = pathCheck.stdout.split('\n').find(line => line.trim().endsWith('bun.cmd'));
      if (bunCmdPath) {
        return bunCmdPath.trim();
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

let shouldEmitHookContinueJson = false;
if (args[0] === '--hook-continue-json') {
  shouldEmitHookContinueJson = true;
  args.shift();
}

if (args.length === 0) {
  console.error('Usage: node bun-runner.js <script> [args...]');
  process.exit(1);
}

args[0] = fixBrokenScriptPath(args[0]);

// Lifecycle commands manage the long-lived worker daemon; every other invocation
// is a hook payload whose runtime blocks the Claude Code event that spawned it
// (UserPromptSubmit, PostToolUse, ...). A wedged worker on one of those must never
// hang the user's prompt — see the watchdog below.
const LIFECYCLE_COMMANDS = ['start', 'stop', 'restart', 'status'];
const isLifecycle = LIFECYCLE_COMMANDS.some(cmd => args.includes(cmd));

// Kill the child and everything it spawned. On Windows the child is a cmd.exe
// wrapper (shell:true), so child.kill() leaves the real `bun` grandchild running
// — the orphan pileup that stacks up one hung worker per prompt. taskkill /T /F
// tears down the whole tree.
function killChildTree(child) {
  if (!child || child.killed) return;
  if (IS_WINDOWS && child.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

const bunPath = findBun();

if (!bunPath) {
  console.error('Error: Bun not found. Please install Bun: https://bun.sh');
  console.error('After installation, restart your terminal.');
  process.exit(1);
}

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

// Wrapped in an async IIFE: top-level `await` is unsupported in the ESM loader
// of Node < 14.8, which some Claude Code installs invoke hooks with (e.g. the
// Node 12 shipped by Ubuntu 22.04 / many WSL setups). There it throws
// "SyntaxError: Unexpected reserved word" at module load, breaking the hook.
// Same oldest-Node compatibility reason as the optional-chaining note above.
(async () => {
const stdinData = await collectStdin();

const spawnOptions = {
  stdio: ['pipe', shouldEmitHookContinueJson ? 'ignore' : 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env
};

let spawnCmd = bunPath;
let spawnArgs = args;

if (IS_WINDOWS) {
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  spawnOptions.shell = true;
  spawnCmd = [bunPath, ...args].map(quote).join(' ');
  spawnArgs = [];
}

const child = spawn(spawnCmd, spawnArgs, spawnOptions);

// Watchdog: a hook payload invocation must never block its Claude Code event for
// longer than this. If the worker wedges (e.g. a stuck daemon connection on
// Windows), kill the process tree and exit 0 — honoring the exit-0 strategy, with
// the runner-errors log as the durable signal. Lifecycle commands are exempt: the
// daemon they start is meant to outlive this launcher.
let watchdog = null;
if (!isLifecycle) {
  const timeoutMs = Number(process.env.CLAUDE_MEM_HOOK_TIMEOUT_MS) || 8000;
  watchdog = setTimeout(() => {
    try {
      const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
      const logsDir = join(dataDir, 'logs');
      mkdirSync(logsDir, { recursive: true });
      appendFileSync(
        join(logsDir, 'runner-errors.log'),
        `[bun-runner] worker hook exceeded ${timeoutMs}ms — killed to unblock prompt\n` +
        `  script: ${args[0]}\n` +
        `  timestamp: ${new Date().toISOString()}\n\n`
      );
    } catch {}
    killChildTree(child);
    process.exit(0);
  }, timeoutMs);
  if (watchdog.unref) watchdog.unref();
}

if (child.stdin) {
  if (stdinData && stdinData.length > 0) {
    child.stdin.write(stdinData);
    child.stdin.end();
  } else {
    // Lifecycle subcommands (start, stop, restart, status) never consume stdin —
    // they manage the worker daemon, not hook payloads.  Killing the child here
    // prevents the daemon from starting/stopping on platforms where Claude Code
    // doesn't pipe a payload for SessionStart (e.g. Windows CC ≤ 2.1.145).
    if (isLifecycle) {
      try { child.stdin.end(); } catch {}
    } else {
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

      console.error(diagnostic);

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
  console.error(`Failed to start Bun: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (watchdog) clearTimeout(watchdog);
  const exitCode = typeof code === 'number' ? code : 0;
  if (shouldEmitHookContinueJson && !signal && exitCode === 0) {
    process.stdout.write('{"continue":true,"suppressOutput":true}\n');
  }
  if ((signal || exitCode > 128) && args.includes('start')) {
    process.exit(0);
  }
  process.exit(exitCode);
});
})();
