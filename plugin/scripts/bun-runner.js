#!/usr/bin/env node
/**
 * Bun Runner - Finds and executes Bun even when not in PATH
 *
 * This script solves the fresh install problem where:
 * 1. smart-install.js installs Bun to ~/.bun/bin/bun
 * 2. But Bun isn't in PATH until terminal restart
 * 3. Subsequent hooks fail because they can't find `bun`
 *
 * Usage: node bun-runner.js <script> [args...]
 *
 * Fixes #818: Worker fails to start on fresh install
 */
import { spawnSync, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const IS_WINDOWS = process.platform === 'win32';

// Self-resolve plugin root when CLAUDE_PLUGIN_ROOT is not set by Claude Code.
// Upstream bug: anthropics/claude-code#24529 — Stop hooks (and on Linux, all hooks)
// don't receive CLAUDE_PLUGIN_ROOT, causing script paths to resolve to /scripts/...
// which doesn't exist. This fallback derives the plugin root from bun-runner.js's
// own filesystem location (this file lives in <plugin-root>/scripts/).
const __bun_runner_dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVED_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || resolve(__bun_runner_dirname, '..');

/**
 * Fix script path arguments that were broken by empty CLAUDE_PLUGIN_ROOT.
 * When CLAUDE_PLUGIN_ROOT is empty, "${CLAUDE_PLUGIN_ROOT}/scripts/foo.cjs"
 * expands to "/scripts/foo.cjs" which doesn't exist. Detect this and rewrite
 * the path using our self-resolved plugin root.
 */
function fixBrokenScriptPath(argPath) {
  if (argPath.startsWith('/scripts/') && !existsSync(argPath)) {
    const fixedPath = join(RESOLVED_PLUGIN_ROOT, argPath);
    if (existsSync(fixedPath)) {
      return fixedPath;
    }
  }
  return argPath;
}

/**
 * Find Bun executable - checks PATH first, then common install locations
 */
function findBun() {
  // Try PATH first.
  // On Windows, pass a single command string to avoid Node 22+ DEP0190 deprecation warning
  // (triggered when an args array is combined with shell:true, as the args are only
  // concatenated, not escaped). Fixes #1503.
  const pathCheck = IS_WINDOWS
    ? spawnSync('where bun', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      })
    : spawnSync('which', ['bun'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    // On Windows, prefer bun.cmd over bun (bun is a shell script, bun.cmd is the Windows batch file)
    if (IS_WINDOWS) {
      const bunCmdPath = pathCheck.stdout.split('\n').find(line => line.trim().endsWith('bun.cmd'));
      if (bunCmdPath) {
        return bunCmdPath.trim();
      }
    }
    return 'bun'; // Found in PATH
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  // Windows: Bun installs to ~/.bun/bin/bun.exe (same as smart-install.js)
  // Unix: Check default location plus common package manager paths
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

// Early exit if plugin is disabled in Claude Code settings (#781).
// Sync read + JSON parse — fastest possible check before spawning Bun.
function isPluginDisabledInClaudeSettings() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(configDir, 'settings.json');
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return settings?.enabledPlugins?.['claude-mem@thedotmack'] === false;
  } catch {
    return false;
  }
}

if (isPluginDisabledInClaudeSettings()) {
  process.exit(0);
}

// Get args: node bun-runner.js <script> [args...]
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node bun-runner.js <script> [args...]');
  process.exit(1);
}

// Fix broken script paths caused by empty CLAUDE_PLUGIN_ROOT (#1215)
args[0] = fixBrokenScriptPath(args[0]);

const bunPath = findBun();

if (!bunPath) {
  console.error('Error: Bun not found. Please install Bun: https://bun.sh');
  console.error('After installation, restart your terminal.');
  process.exit(1);
}

// Fix #646: Buffer stdin in Node.js before passing to Bun.
// On Linux, Bun's libuv calls fstat() on inherited pipe fds and crashes with
// EINVAL when the pipe comes from Claude Code's hook system. By reading stdin
// in Node.js first and writing it to a fresh pipe, Bun receives a normal pipe
// that it can fstat() without errors.
function collectStdin() {
  return new Promise((resolve) => {
    // If stdin is a TTY (interactive), there's no piped data to collect
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
      // stdin may not be readable (e.g. already closed), treat as no data
      resolve(null);
    });

    // Safety: if no data arrives within 5s, proceed without stdin
    setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    }, 5000);
  });
}

const stdinData = await collectStdin();

// Spawn Bun with the provided script and args
// Use spawn (not spawnSync) to properly handle stdio
// On Windows, use cmd.exe to execute bun.cmd since npm-installed bun is a batch file
// Use windowsHide to prevent a visible console window from spawning on Windows
const spawnOptions = {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env
};

let spawnCmd = bunPath;
let spawnArgs = args;

if (IS_WINDOWS) {
  // On Windows, npm-installed bun is bun.cmd (a batch file) which spawn()
  // can't execute directly. The previous `cmd /c` wrapper made a visible
  // console window flash on every hook (issues #2150, #2186, #2187).
  // shell:true lets Node resolve via PATHEXT *and* respects windowsHide,
  // unlike an explicit cmd.exe wrapper. bun.exe paths work the same way.
  //
  // With shell:true we must pass a single fully-quoted command string and
  // an empty args array. Passing args separately concatenates them
  // unescaped, which breaks paths/args containing spaces and triggers
  // DEP0190 on Node 22+. Mirrors the quoting in findBun().
  const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  spawnOptions.shell = true;
  spawnCmd = [bunPath, ...args].map(quote).join(' ');
  spawnArgs = [];
}

const child = spawn(spawnCmd, spawnArgs, spawnOptions);

// Write buffered stdin to child's pipe, then close it so the child sees EOF.
// Fall back to '{}' when no stdin data is available so worker-service.cjs
// always receives valid JSON input even when Claude Code doesn't pipe stdin
// (e.g. during SessionStart on some platforms). Fixes #1560.
if (child.stdin) {
  child.stdin.write(stdinData || '{}');
  child.stdin.end();
}

child.on('error', (err) => {
  console.error(`Failed to start Bun: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  // Fix #1505: When the "start" subcommand forks a daemon, the parent bun
  // process may be killed by signal (e.g. SIGKILL, exit code 137). The daemon
  // is running fine — treat signal-based exits for "start" as success.
  if ((signal || code > 128) && args.includes('start')) {
    process.exit(0);
  }
  process.exit(code || 0);
});
