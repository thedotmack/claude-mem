import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { getBunPath } from '../install/setup-runtime.js';
import { resolvePluginRoot } from '../utils/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

/**
 * The plugin root the runtime loads, or exit(1) when none is found. Resolves the
 * same way the hooks do ($CLAUDE_PLUGIN_ROOT, then cache, then marketplace), so
 * a cache-based install the hooks run from is not reported as "not installed".
 */
function pluginRootOrExit(): string {
  const root = resolvePluginRoot();
  if (!root) {
    console.error(styleText('red', 'claude-mem is not installed.'));
    console.error(`Run: ${styleText('bold', 'npx claude-mem install')}`);
    process.exit(1);
  }
  return root;
}

function resolveBunOrExit(): string {
  const bunPath = getBunPath();
  if (!bunPath) {
    console.error(styleText('red', 'Bun not found.'));
    console.error('Install Bun: https://bun.sh');
    console.error('After installation, restart your terminal.');
    process.exit(1);
  }
  return bunPath;
}

function workerServiceScriptPath(root: string): string {
  return join(root, 'scripts', 'worker-service.cjs');
}

function serverServiceScriptPath(root: string): string {
  // Plan §1c line 149: prefer the renamed `server-service.cjs`, but fall
  // back to the legacy `server-beta-service.cjs` for installed plugin
  // caches that pre-date the rename (forced reinstall not required).
  const scriptsDir = join(root, 'scripts');
  const renamed = join(scriptsDir, 'server-service.cjs');
  if (existsSync(renamed)) {
    return renamed;
  }
  return join(scriptsDir, 'server-beta-service.cjs');
}

/**
 * Spawn a plugin .cjs script under Bun with inherited stdio, exiting this
 * process with the child's exit code. `args[0]` is the script path. Sanitizes
 * host CLI bleed-through and Anthropic credentials before launch; credentials
 * are re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
 */
function spawnPlugin(bunPath: string, args: string[], cwd: string, startFailureLabel = 'Bun'): void {
  const child = spawnHidden(bunPath, args, {
    stdio: 'inherit',
    cwd,
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(styleText('red', `Failed to start ${startFailureLabel}: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

function spawnBunWorkerCommand(command: string, extraArgs: string[] = []): void {
  const root = pluginRootOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath(root);

  if (!existsSync(workerScript)) {
    console.error(styleText('red', `Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx claude-mem install');
    process.exit(1);
  }

  spawnPlugin(bunPath, [workerScript, command, ...extraArgs], root);
}

function spawnBunServerCommand(command: string, extraArgs: string[] = []): void {
  const root = pluginRootOrExit();
  const bunPath = resolveBunOrExit();
  const serverScript = serverServiceScriptPath(root);

  if (!existsSync(serverScript)) {
    console.error(styleText('red', `Server script not found at: ${serverScript}`));
    console.error('The installation may be corrupted. Try: npx claude-mem install');
    process.exit(1);
  }

  spawnPlugin(bunPath, [serverScript, command, ...extraArgs], root);
}

export function runServerStartCommand(): void {
  spawnBunServerCommand('start');
}

export function runServerStopCommand(): void {
  spawnBunServerCommand('stop');
}

export function runServerRestartCommand(): void {
  spawnBunServerCommand('restart');
}

export function runServerStatusCommand(): void {
  spawnBunServerCommand('status');
}

// Phase 10 — start the BullMQ generation worker (no HTTP). Use this in
// Compose to scale generation horizontally while a single (or multiple)
// HTTP-only server replicas serve writes/reads.
export function runServerWorkerStartCommand(): void {
  spawnBunServerCommand('worker', ['start']);
}

export function runStartCommand(): void {
  spawnBunWorkerCommand('start');
}

export function runStopCommand(): void {
  spawnBunWorkerCommand('stop');
}

export function runRestartCommand(): void {
  spawnBunWorkerCommand('restart');
}

export function runStatusCommand(): void {
  spawnBunWorkerCommand('status');
}

export function runServerApiKeyCommand(extraArgs: string[] = []): void {
  spawnBunWorkerCommand('server', ['api-key', ...extraArgs]);
}

export function runAdoptCommand(extraArgs: string[] = []): void {
  const root = pluginRootOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath(root);

  if (!existsSync(workerScript)) {
    console.error(styleText('red', `Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx claude-mem install');
    process.exit(1);
  }

  const userCwd = process.cwd();
  spawnPlugin(bunPath, [workerScript, 'adopt', '--cwd', userCwd, ...extraArgs], root);
}

export function runCleanupCommand(extraArgs: string[] = []): void {
  spawnBunWorkerCommand('cleanup', extraArgs);
}

export async function runSearchCommand(queryParts: string[]): Promise<void> {
  pluginRootOrExit();

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(styleText('red', 'Usage: npx claude-mem search <query>'));
    process.exit(1);
  }

  const workerHost = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  const searchUrl = `http://${workerHost}:${workerPort}/api/search?query=${encodeURIComponent(query)}`;

  let response: Response;
  try {
    response = await fetch(searchUrl);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(styleText('red', 'Worker is not running.'));
      console.error(`Start it with: ${styleText('bold', 'npx claude-mem start')}`);
      process.exit(1);
    }
    console.error(styleText('red', `Search failed: ${message}`));
    process.exit(1);
  }

  if (!response.ok) {
    if (response.status === 404) {
      console.error(styleText('red', 'Search endpoint not found. Is the worker running?'));
      console.error(`Try: ${styleText('bold', 'npx claude-mem start')}`);
      process.exit(1);
    }
    console.error(styleText('red', `Search failed: HTTP ${response.status}`));
    process.exit(1);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(styleText('red', `Search failed: invalid JSON response (${message})`));
    process.exit(1);
  }

  if (typeof data === 'object' && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

export function runTranscriptWatchCommand(): void {
  const root = pluginRootOrExit();
  const bunPath = resolveBunOrExit();

  const transcriptWatcherPath = join(root, 'scripts', 'transcript-watcher.cjs');

  if (!existsSync(transcriptWatcherPath)) {
    spawnBunWorkerCommand('transcript', ['watch']);
    return;
  }

  spawnPlugin(bunPath, [transcriptWatcherPath, 'watch'], root, 'transcript watcher');
}
