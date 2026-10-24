import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { spawnHidden } from '../../shared/spawn.js';
import { writeAllSync } from '../../shared/write-all-sync.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { INSTALLER_NODE_PATH_ENV } from '../../services/integrations/install-paths.js';
import { LIBRARY_CHANGE_ID_ENV, newLibraryChangeId } from '../../services/wire-gateway/library/backups.js';
import { getBunPath } from '../install/setup-runtime.js';
import { npmPackageRootDirectory } from '../utils/paths.js';

// `claude-mem library …` and every IDE install/uninstall that edits agent
// configs go through the Library engine (src/services/wire-gateway/library),
// which runs under Bun: its TOML and YAML edits are checked with Bun.TOML and
// Bun.YAML. The npx CLI runs under Node, so there the work goes to a Bun
// child running this package's own worker-service.cjs (present for as long as
// npx runs, unlike the marketplace copy uninstall removes). Under Bun (tests,
// bunx, the launcher) it runs in this process.

/**
 * How long an install or uninstall child may run: its slowest steps are the
 * agents' own CLIs (DSH's `plugin add` allows 120 s, Codex and T3 Code
 * marketplace steps 30 s each). A child still running after this is hung;
 * the bound reports it instead of waiting forever.
 */
const LIBRARY_CHILD_TIMEOUT_MS = 10 * 60 * 1000;

export function libraryRunsInThisProcess(): boolean {
  return typeof Bun !== 'undefined';
}

function packagedWorkerServiceScript(): string {
  return join(npmPackageRootDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
}

function bunPathOrError(script: string = packagedWorkerServiceScript()): { bunPath: string } | { error: string } {
  const bunPath = getBunPath();
  if (!bunPath) return { error: 'Bun not found: claude-mem edits agent configs with Bun. Install Bun (https://bun.sh), then retry.' };
  if (!existsSync(script)) return { error: `worker-service.cjs not found at ${script}; the claude-mem package looks incomplete.` };
  return { bunPath };
}

/** This user command's Library change id, made once: every Bun child of the command gets it (backups.ts). */
let thisCommandLibraryChangeId: string | undefined;
function libraryChangeIdOfThisCommand(): string {
  thisCommandLibraryChangeId ??= newLibraryChangeId();
  return thisCommandLibraryChangeId;
}

/**
 * The Bun child's environment: the caller's (sanitized), plus the Node that
 * runs this CLI, so MCP servers the child registers launch with that Node as
 * they did when the installers ran here (install-paths.ts getNodeAbsolutePath),
 * plus this command's Library change id, so the Bun children of one command
 * (one per agent) keep their backups in one folder (backups.ts).
 */
export function libraryChildEnvironment(parentEnvironment: NodeJS.ProcessEnv = process.env, nodePath: string = process.execPath): NodeJS.ProcessEnv {
  return {
    ...sanitizeEnv(parentEnvironment),
    [INSTALLER_NODE_PATH_ENV]: parentEnvironment[INSTALLER_NODE_PATH_ENV] || nodePath,
    [LIBRARY_CHANGE_ID_ENV]: parentEnvironment[LIBRARY_CHANGE_ID_ENV] || libraryChangeIdOfThisCommand(),
  };
}

/** What a `library <args>` child that did not exit by itself is reported as: the real cause, never a guess. */
export function describeLibraryChildFailure(args: string[], child: { error?: Error & { code?: string }; signal?: NodeJS.Signals | null }): string {
  const command = `claude-mem library ${args.join(' ')}`;
  if (child.error?.code === 'ETIMEDOUT') return `${command} did not finish within ${LIBRARY_CHILD_TIMEOUT_MS / 60_000} minutes and was stopped`;
  if (child.error) return `${command} could not run: ${child.error.message}`;
  return `${command} was killed by ${child.signal ?? 'an unknown signal'}`;
}

/**
 * Run `library <args>` in a Bun child (`workerServiceScript`: this package's
 * worker-service.cjs; tests pass the repo's build), its output captured for the
 * installer to show (the spinner shows it on failure; uninstall prints it).
 * The capture has no size cap (`maxBuffer: Infinity`): it is the installers'
 * own console lines, and spawnSync's default 1 MB cap would kill the child
 * part way through an install and drop the output that says what happened.
 */
export function runLibraryInBunChild(args: string[], workerServiceScript: string = packagedWorkerServiceScript()): { result: number; output: string } {
  const resolved = bunPathOrError(workerServiceScript);
  if ('error' in resolved) return { result: 1, output: resolved.error };
  const child = spawnSync(resolved.bunPath, [workerServiceScript, 'library', ...args], {
    cwd: process.cwd(),
    env: libraryChildEnvironment(),
    encoding: 'utf-8',
    maxBuffer: Infinity,
    timeout: LIBRARY_CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (child.error || child.status === null) return { result: 1, output: `${output}\n${describeLibraryChildFailure(args, child)}` };
  return { result: child.status, output };
}

/** `npx claude-mem library …`: in this process under Bun, otherwise a Bun child with inherited output. */
export async function runLibraryCommand(argv: string[]): Promise<number> {
  if (libraryRunsInThisProcess()) {
    const { runLibraryCli } = await import('../../services/wire-gateway/library/library-cli.js');
    // Written whole (shared/write-all-sync.ts): Bun 1.3.9's console.log to a pipe keeps only 64 KB.
    return runLibraryCli(argv, { writeLine: (line) => writeAllSync(1, `${line}\n`), writeError: (line) => writeAllSync(2, `${line}\n`) });
  }
  const resolved = bunPathOrError();
  if ('error' in resolved) {
    console.error(styleText('red', resolved.error));
    return 1;
  }
  return new Promise((resolve) => {
    const child = spawnHidden(resolved.bunPath, [packagedWorkerServiceScript(), 'library', ...argv], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: libraryChildEnvironment(),
    });
    child.on('error', (error) => {
      console.error(styleText('red', `Failed to start Bun: ${error.message}`));
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
