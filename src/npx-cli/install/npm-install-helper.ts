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
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { IS_WINDOWS } from '../utils/paths.js';

const TIMEOUT_MS = 5 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;

export interface NpmResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function resolveInstallTimeoutMs(): number {
  const override = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
  if (override && Number.isFinite(Number(override))) return Number(override);
  return TIMEOUT_MS;
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

/** npm's own error code from its stderr (`npm error code X` / `npm ERR! code X`), or null. */
export function npmErrorCode(stderr: string): string | null {
  return /npm (?:error|ERR!) code (\w+)/.exec(stderr)?.[1] ?? null;
}

// npm 11.16+ refuses an `allow-scripts` value from the command line in a
// project-scoped install (EALLOWSCRIPTS), and it counts the environment as the
// command line. npx (npm 11.16 through 12.1) exports a user's `allow-scripts=`
// line from ~/.npmrc to this process as npm_config_allow_scripts, so every
// child npm aborted before reading any manifest (#3697, #3835, #3774). The child
// still reads ~/.npmrc itself, where the setting is allowed. npm accepts `-` or
// `_` in the name, and Windows env names are case-insensitive.
const INHERITED_ALLOW_SCRIPTS_ENV = /^npm_config_allow[-_]scripts$/i;

/** The env for a child npm: the parent's, minus an inherited allow-scripts setting. */
export function npmChildEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(parentEnv).filter(([name]) => !INHERITED_ALLOW_SCRIPTS_ENV.test(name)),
  );
}

// Async (spawn, not spawnSync) so the installer's clack spinner keeps
// animating during a multi-minute npm install — a blocked event loop freezes
// the spinner mid-frame and the install looks stalled.
export function runNpmStrict(cwd: string, flags: string[]): Promise<NpmResult> {
  return new Promise((resolve) => {
    const child = spawn('npm', flags, {
      cwd,
      env: npmChildEnv(sanitizeEnv(process.env)),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(IS_WINDOWS ? { shell: process.env.ComSpec ?? 'cmd.exe' } : {}),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: Error | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // An installer can ignore SIGTERM; the timeout must still end the wait.
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
    }, resolveInstallTimeoutMs());

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resolve({
        code: timedOut ? 124 : (typeof code === 'number' ? code : 1),
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
