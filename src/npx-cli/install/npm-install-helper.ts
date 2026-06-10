/**
 * npm install helpers for the marketplace dependency step.
 *
 * Strategy (see plans/04-installer-transparency.md Phase 4):
 *  1. Run `npm install --omit=dev --ignore-scripts` STRICTLY first.
 *  2. If it fails WITHOUT an ERESOLVE token in stderr, that's a real bug — ABORT,
 *     never retry (retrying a non-ERESOLVE failure just hides it).
 *  3. Only on a confirmed `ERESOLVE` token do we retry once with
 *     `--legacy-peer-deps`, announcing the fallback loudly.
 *
 * `--ignore-scripts` is the default: per the v12.6.1 -> v12.6.2 incident, a
 * transitive dep's network postinstall (tree-sitter-swift's nested
 * tree-sitter-cli) could hang `npx claude-mem install`. npm does NOT honor
 * `trustedDependencies` (Bun-only), so we suppress scripts at the CLI level.
 */

import { spawn } from 'child_process';

const IS_WINDOWS = process.platform === 'win32';

const TIMEOUT_FIRST_RUN_MS = 5 * 60 * 1000;
const TIMEOUT_SUBSEQUENT_MS = 2 * 60 * 1000;

export interface NpmResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function resolveInstallTimeoutMs(isFirstRun: boolean): number {
  const override = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  if (override && Number.isFinite(Number(override))) return Number(override);
  return isFirstRun ? TIMEOUT_FIRST_RUN_MS : TIMEOUT_SUBSEQUENT_MS;
}

/** Detect an npm ERESOLVE peer-dependency conflict in captured stderr. */
export function isEresolve(stderr: string): boolean {
  return /\bERESOLVE\b/.test(stderr) || /code ERESOLVE/.test(stderr);
}

/**
 * Pull the human-readable conflict block from npm's ERESOLVE stderr so we can
 * surface it verbatim. Defensive: returns the raw stderr if the markers aren't
 * found.
 */
export function extractEresolveBlock(stderr: string): string {
  const start = stderr.search(/While resolving:/);
  if (start === -1) return stderr.trim();
  return stderr.slice(start).trim();
}

// Async (spawn, not spawnSync) so the installer's clack spinner keeps
// animating during a multi-minute npm install — a blocked event loop freezes
// the spinner mid-frame and the install looks stalled.
export function runNpmStrict(cwd: string, flags: string[], isFirstRun = true): Promise<NpmResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', flags, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: Error | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, resolveInstallTimeoutMs(isFirstRun));

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: typeof code === 'number' ? code : (timedOut ? 124 : 1),
        stdout,
        stderr: stderr || (spawnError ? String(spawnError.message) : ''),
        timedOut,
      });
    };

    // 'close' never fires when the process fails to spawn (ENOENT), so the
    // error handler must settle too.
    child.on('error', (error) => { spawnError = error; settle(null); });
    child.on('close', (code) => { settle(code); });
  });
}
