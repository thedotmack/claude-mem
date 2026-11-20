import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnHidden } from '../../shared/spawn.js';
import { getPackageRoot, MARKETPLACE_ROOT } from '../../shared/paths.js';
import { hasActiveSetupSession, readSetupState, writeSetupState } from '../../shared/setup-state.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { resolveWorkerRuntimePath } from '../infrastructure/ProcessManager.js';
import { BUN_NO_AUTO_INSTALL_FLAG } from '../../shared/bun-auto-install.js';
import { logger } from '../../utils/logger.js';
import { isPidAlive } from '../../supervisor/process-registry.js';

interface SetupInstallerProgram { runtime: string; cli: string }
export interface SetupInstallerResumerOptions {
  onStateChange?: () => void;
  /** Injectable process boundaries; production always uses the installed distribution. */
  resolveProgram?: () => SetupInstallerProgram;
  spawn?: typeof spawnHidden;
  isAlive?: (pid: number) => boolean;
}

function installedSetupProgram(): SetupInstallerProgram {
  // The bootstrap copies the complete npm distribution to the marketplace, so
  // this stays available after npx removes its temporary package directory.
  const cli = [join(MARKETPLACE_ROOT, 'dist', 'npx-cli', 'index.js'), resolve(getPackageRoot(), '..', 'dist', 'npx-cli', 'index.js')]
    .find(path => existsSync(path));
  const runtime = resolveWorkerRuntimePath();
  if (!cli || !runtime) throw new Error('The setup program is missing. Run npx claude-mem install --setup browser to restore it.');
  return { cli, runtime };
}

/** Resume only when a person opens pending onboarding. A failure needs an explicit retry. */
export function createSetupInstallerResumer(statePath: string, options: SetupInstallerResumerOptions = {}): (retry?: boolean) => Promise<void> {
  let launching: Promise<void> | null = null;
  let launchedPid: number | undefined;
  let currentChild: ReturnType<typeof spawnHidden> | null = null;
  const isAlive = options.isAlive ?? isPidAlive;
  const recordFailure = (error: Error): void => {
    try {
      const state = readSetupState(statePath);
      // A completed run, or another live installer, owns its newer state.
      if (state.status === 'complete' || !state.install || hasActiveSetupSession(statePath)) return;
      if (state.install.status === 'ready') {
        writeSetupState({ ...state, installer: { stage: 'failed', error: error.message, updatedAt: new Date().toISOString() } }, statePath);
      } else {
        writeSetupState({ ...state, install: { ...state.install, status: 'failed', error: error.message } }, statePath);
      }
      options.onStateChange?.();
    } catch (writeError) {
      logger.warn('SYSTEM', 'Could not record a stopped setup installer', { error: writeError instanceof Error ? writeError.message : String(writeError) });
    }
  };
  return async (retry = false) => {
    const state = readSetupState(statePath);
    if (state.status === 'complete' || !state.install || hasActiveSetupSession(statePath)) return;
    if (launching) return launching;
    if (launchedPid && isAlive(launchedPid)) return;
    launchedPid = undefined;
    if (!retry && (state.install.status === 'failed' || state.installer?.stage === 'failed')) return;
    launching = (async () => {
      try {
        const { cli, runtime } = (options.resolveProgram ?? installedSetupProgram)();
        await new Promise<void>((resolveLaunch, reject) => {
          const child = (options.spawn ?? spawnHidden)(runtime, [BUN_NO_AUTO_INSTALL_FLAG, cli, 'install', '--setup', 'resume'], {
            cwd: dirname(dirname(dirname(cli))),
            env: { ...sanitizeEnv(process.env), CLAUDE_MEM_DATA_DIR: dirname(statePath) },
            stdio: 'ignore', detached: true,
          });
          currentChild = child;
          let spawned = false;
          child.once('error', (error) => {
            if (currentChild !== child) return;
            currentChild = null; launchedPid = undefined;
            if (spawned) recordFailure(error);
            reject(error);
          });
          child.once('spawn', () => {
            if (currentChild !== child) return;
            spawned = true; launchedPid = child.pid; child.unref(); resolveLaunch();
          });
          child.once('exit', (code, signal) => {
            if (currentChild !== child) return;
            currentChild = null; launchedPid = undefined;
            const error = new Error(`The setup program stopped${signal ? ` (${signal})` : ` (exit ${code ?? 'unknown'})`}. Retry setup in this page, or run npx claude-mem install --setup browser.`);
            if (spawned) recordFailure(error);
            reject(error); // Covers an exit before the spawn event; harmless after a successful launch.
          });
        });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        recordFailure(failure);
        throw failure;
      }
    })().finally(() => { launching = null; });
    return launching;
  };
}
