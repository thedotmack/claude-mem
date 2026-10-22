/**
 * Which agent CLIs on this machine can run a headless job for claude-mem right
 * now, and are they already logged in?
 *
 * The install funnel extracts Work, Goals and Rules with whatever agent the
 * user already has and is already logged in to, so the user never logs in to
 * anything extra. This module only looks: it never starts a login, never
 * writes agent config, and makes no network call of its own. Every check is
 * bounded by a timeout, runs commands with `spawn` (argv, never a shell) and
 * never throws — a failure is recorded as `{ authenticated: false, reason }`.
 *
 * Priority order (the first authenticated agent wins downstream):
 * Claude Code → Codex → Gemini.
 *
 * Commands used, verified against local `--help` output:
 *   - `claude auth status --json`  (Claude Code 2.1.308: `--json  Output as JSON (default)`)
 *   - `codex login status`         (codex-cli 0.163.0: prints "Logged in using ChatGPT" to stderr, exit 0)
 *   - Gemini has no status subcommand (gemini 0.49.0), so its auth is read from
 *     `~/.gemini/settings.json` `security.auth.selectedType` + `~/.gemini/oauth_creds.json`,
 *     or `GEMINI_API_KEY`.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findClaudeExecutable } from '../../shared/find-claude-executable.js';
import { readClaudeOAuthToken, type OAuthTokenResult } from '../../shared/oauth-token.js';
import { hasAnthropicApiKey, hasAnthropicAuthToken } from '../../shared/EnvManager.js';

export type UsableAgentId = 'claude-code' | 'codex' | 'gemini';

export interface UsableAgent {
  id: UsableAgentId;
  /** Resolved executable path, or null when the CLI is not installed. */
  path: string | null;
  authenticated: boolean;
  /** Why the agent is or is not usable, in plain words. Never contains a credential. */
  reason: string;
}

export interface CommandResult {
  /** Exit code, or null when the process never started or was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started (e.g. ENOENT). */
  spawnError?: Error;
}

export const AGENT_CHECK_TIMEOUT_MS = 3_000;
/** Extra wait for a killed child to exit after SIGTERM, before we stop waiting. */
const KILL_GRACE_MS = 500;

/**
 * Run a command with argv (no shell) and a hard timeout. Never rejects.
 * Same shape as `spawnGit` in WorktreeAdoption.ts.
 */
export function runCommandWithTimeout(
  spawnImplementation: typeof spawn,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>(resolve => {
    const child = spawnImplementation(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        settle({ exitCode: null, stdout, stderr, timedOut: true });
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', error => {
      spawnError = error;
      // A child that never started may not emit 'close' on every runtime.
      settle({ exitCode: null, stdout, stderr, timedOut, spawnError });
    });
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', code => {
      settle({ exitCode: timedOut ? null : code, stdout, stderr, timedOut, spawnError });
    });
  }).catch((error: unknown) => ({
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnError: error instanceof Error ? error : new Error(String(error)),
  }));
}

export interface AgentDetectionDependencies {
  spawn: typeof spawn;
  findClaudeExecutable: () => string;
  readClaudeOAuthToken: () => Promise<OAuthTokenResult>;
  hasAnthropicApiKey: () => boolean;
  hasAnthropicAuthToken: () => boolean;
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string;
  environment: NodeJS.ProcessEnv;
  homeDirectory: () => string;
  platform: () => NodeJS.Platform;
  /** Per-agent check budget. */
  timeoutMs: number;
  /** Wall clock, for token expiry. */
  now: () => number;
}

const defaultDependencies: AgentDetectionDependencies = {
  spawn,
  findClaudeExecutable: () => findClaudeExecutable('WORKER'),
  readClaudeOAuthToken: () => readClaudeOAuthToken(),
  hasAnthropicApiKey,
  hasAnthropicAuthToken,
  fileExists: existsSync,
  readTextFile: path => readFileSync(path, 'utf8'),
  environment: process.env,
  homeDirectory: homedir,
  platform: () => process.platform,
  timeoutMs: AGENT_CHECK_TIMEOUT_MS,
  now: Date.now,
};

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].trim() || 'unknown error';
}

class CheckTimeoutError extends Error {}

/** Bound a whole check, including steps that are not a single spawn (token reads). */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeoutError(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a command on PATH the way ide-detection.ts does (`which` / `where.exe`). */
async function resolveOnPath(
  dependencies: AgentDetectionDependencies,
  command: string,
): Promise<{ path: string } | { path: null; reason: string }> {
  const lookup = dependencies.platform() === 'win32' ? 'where.exe' : 'which';
  const result = await runCommandWithTimeout(dependencies.spawn, lookup, [command], dependencies.timeoutMs);
  if (result.timedOut) {
    return { path: null, reason: commandFailureReason(`${lookup} ${command}`, result, dependencies.timeoutMs) };
  }
  const firstLine = result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (result.exitCode !== 0 || !firstLine) {
    return { path: null, reason: `not installed: \`${command}\` is not on PATH` };
  }
  return { path: firstLine };
}

function commandFailureReason(command: string, result: CommandResult, timeoutMs: number): string {
  if (result.timedOut) return `\`${command}\` timed out after ${timeoutMs} ms`;
  if (result.spawnError) return `\`${command}\` could not start: ${describeError(result.spawnError)}`;
  const output = `${result.stdout}\n${result.stderr}`.trim().split('\n')[0]?.trim();
  return `\`${command}\` exited ${result.exitCode}${output ? `: ${output}` : ''}`;
}

async function detectClaudeCode(dependencies: AgentDetectionDependencies): Promise<UsableAgent> {
  let path: string;
  try {
    path = dependencies.findClaudeExecutable();
  } catch (error) {
    return { id: 'claude-code', path: null, authenticated: false, reason: `not installed: ${describeError(error)}` };
  }

  if (dependencies.hasAnthropicApiKey()) {
    return { id: 'claude-code', path, authenticated: true, reason: 'ANTHROPIC_API_KEY in ~/.claude-mem/.env' };
  }
  if (dependencies.hasAnthropicAuthToken()) {
    return { id: 'claude-code', path, authenticated: true, reason: 'ANTHROPIC_AUTH_TOKEN in ~/.claude-mem/.env' };
  }

  const token = await dependencies.readClaudeOAuthToken();
  if (token.kind === 'present' && (token.expiresAt === undefined || token.expiresAt > dependencies.now())) {
    return { id: 'claude-code', path, authenticated: true, reason: `Claude Code OAuth login (${token.source})` };
  }

  // The token read is inconclusive: an expired access token is normally
  // refreshed by the CLI itself, and an absent read can be a keychain the
  // worker cannot see. Ask the CLI.
  const tokenSummary = token.kind === 'present' ? 'stored token expired' : `token ${token.kind}: ${token.reason}`;
  const status = await runCommandWithTimeout(dependencies.spawn, path, ['auth', 'status', '--json'], dependencies.timeoutMs);
  if (status.exitCode !== 0 && !status.stdout.trim()) {
    return {
      id: 'claude-code',
      path,
      authenticated: false,
      reason: `${tokenSummary}; ${commandFailureReason('claude auth status --json', status, dependencies.timeoutMs)}`,
    };
  }
  let parsed: { loggedIn?: unknown; authMethod?: unknown };
  try {
    parsed = JSON.parse(status.stdout);
  } catch (error) {
    return {
      id: 'claude-code',
      path,
      authenticated: false,
      reason: `${tokenSummary}; \`claude auth status --json\` printed unreadable JSON: ${describeError(error)}`,
    };
  }
  if (parsed.loggedIn === true) {
    const method = typeof parsed.authMethod === 'string' ? parsed.authMethod : 'unknown method';
    return { id: 'claude-code', path, authenticated: true, reason: `\`claude auth status\` reports logged in (${method})` };
  }
  return { id: 'claude-code', path, authenticated: false, reason: '`claude auth status` reports logged out' };
}

async function detectCodex(dependencies: AgentDetectionDependencies): Promise<UsableAgent> {
  const resolved = await resolveOnPath(dependencies, 'codex');
  if (resolved.path === null) return { id: 'codex', path: null, authenticated: false, reason: resolved.reason };
  const path = resolved.path;

  const status = await runCommandWithTimeout(dependencies.spawn, path, ['login', 'status'], dependencies.timeoutMs);
  // codex-cli prints the status line to stderr.
  const output = `${status.stdout}\n${status.stderr}`;
  if (status.exitCode === 0 && /Logged in/.test(output)) {
    const line = output.split('\n').map(text => text.trim()).find(text => /Logged in/.test(text));
    return { id: 'codex', path, authenticated: true, reason: line ?? 'Logged in' };
  }
  return {
    id: 'codex',
    path,
    authenticated: false,
    reason: commandFailureReason('codex login status', status, dependencies.timeoutMs),
  };
}

async function detectGemini(dependencies: AgentDetectionDependencies): Promise<UsableAgent> {
  const resolved = await resolveOnPath(dependencies, 'gemini');
  if (resolved.path === null) return { id: 'gemini', path: null, authenticated: false, reason: resolved.reason };
  const path = resolved.path;

  if (dependencies.environment.GEMINI_API_KEY?.trim()) {
    return { id: 'gemini', path, authenticated: true, reason: 'GEMINI_API_KEY is set' };
  }

  const geminiDirectory = join(dependencies.homeDirectory(), '.gemini');
  const settingsPath = join(geminiDirectory, 'settings.json');
  const credentialsPath = join(geminiDirectory, 'oauth_creds.json');
  if (!dependencies.fileExists(settingsPath)) {
    return { id: 'gemini', path, authenticated: false, reason: 'no GEMINI_API_KEY and no ~/.gemini/settings.json' };
  }
  let selectedType: unknown;
  try {
    const settings = JSON.parse(dependencies.readTextFile(settingsPath)) as { security?: { auth?: { selectedType?: unknown } } };
    selectedType = settings.security?.auth?.selectedType;
  } catch (error) {
    return { id: 'gemini', path, authenticated: false, reason: `~/.gemini/settings.json is unreadable: ${describeError(error)}` };
  }
  if (typeof selectedType !== 'string' || !selectedType) {
    return { id: 'gemini', path, authenticated: false, reason: '~/.gemini/settings.json names no auth type' };
  }
  if (!dependencies.fileExists(credentialsPath)) {
    return { id: 'gemini', path, authenticated: false, reason: `auth type ${selectedType} but no ~/.gemini/oauth_creds.json` };
  }
  return { id: 'gemini', path, authenticated: true, reason: `auth type ${selectedType} with ~/.gemini/oauth_creds.json` };
}

async function runCheck(
  id: UsableAgentId,
  check: (dependencies: AgentDetectionDependencies) => Promise<UsableAgent>,
  dependencies: AgentDetectionDependencies,
): Promise<UsableAgent> {
  try {
    return await withTimeout(check(dependencies), dependencies.timeoutMs);
  } catch (error) {
    return { id, path: null, authenticated: false, reason: `check failed: ${describeError(error)}` };
  }
}

/**
 * Report Claude Code, Codex and Gemini in priority order, each with whether
 * it is installed (`path`) and logged in (`authenticated`). Never throws.
 */
export async function detectUsableAgents(
  overrides: Partial<AgentDetectionDependencies> = {},
): Promise<UsableAgent[]> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return Promise.all([
    runCheck('claude-code', detectClaudeCode, dependencies),
    runCheck('codex', detectCodex, dependencies),
    runCheck('gemini', detectGemini, dependencies),
  ]);
}
