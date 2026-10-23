/**
 * Which agent CLIs on this machine can run a headless job for claude-mem right
 * now, and are they already logged in?
 *
 * The install funnel extracts Work, Goals and Rules with whatever agent the
 * user already has and is already logged in to, so the user never logs in to
 * anything extra. This module only looks: it never starts a login, never
 * writes agent config, and makes no network call of its own. Every check runs
 * commands with `spawn` (argv, never a shell), waits as long as the CLI takes
 * (owner rule, Oct 22: no time limits or skip-if-slow fallbacks), and never
 * throws. An agent is "not usable" only when its CLI is not installed, says it
 * is logged out, or exits with an error: `{ authenticated: false, reason }`.
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
import { readClaudeOAuthToken } from '../../shared/oauth-token.js';
import { hasAnthropicApiKey, hasAnthropicAuthToken } from '../../shared/EnvManager.js';
import { commandInvocation, resolveVoltaShim, selectWindowsCommandCandidate, windowsWhereExecutablePath } from '../../shared/spawn.js';

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
  /** Exit code, or null when the process never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started (e.g. ENOENT). */
  spawnError?: Error;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed; without it stdin is ignored. */
  input?: string;
}

/**
 * Run a command with argv (no shell; a Windows .cmd/.bat shim through cmd.exe)
 * and wait for it to exit, however long that takes. Never rejects. The one
 * spawn-and-collect helper for agent detection, agent runs and the refresh's skill scripts.
 */
export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>(resolve => {
    const invocation = commandInvocation(command, args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let settled = false;
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.on('error', error => {
      spawnError = error;
      // A child that never started may not emit 'close' on every runtime.
      settle({ exitCode: null, stdout, stderr, spawnError });
    });
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', code => {
      settle({ exitCode: code, stdout, stderr, spawnError });
    });
    if (options.input !== undefined) {
      child.stdin?.on('error', () => { /* The exit code reports a command that stopped reading. */ });
      child.stdin?.end(options.input);
    }
  // A spawn that throws synchronously (bad arguments) rejects the executor; report it like a failed start.
  }).catch((error: unknown) => ({
    exitCode: null,
    stdout: '',
    stderr: '',
    spawnError: error instanceof Error ? error : new Error(String(error)),
  }));
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].trim() || 'unknown error';
}

/**
 * Resolve a command on PATH: `which`, or on Windows the system where.exe with
 * the hit chosen the way the rest of claude-mem chooses it (a native .exe, else
 * the npm .cmd shim, never the extensionless sh script npm installs beside it).
 */
async function resolveOnPath(command: string): Promise<{ path: string } | { path: null; reason: string }> {
  const windows = process.platform === 'win32';
  const result = await runCommand(windows ? windowsWhereExecutablePath() : 'which', [command]);
  const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // where.exe can garble a non-ASCII profile folder (lookupWindowsCommandCandidates): keep the paths that exist.
  const found = result.exitCode !== 0 ? null
    : windows ? selectWindowsCommandCandidate(lines.filter(line => existsSync(line)), shim => resolveVoltaShim(command, shim))
      : lines[0] ?? null;
  if (!found) {
    return { path: null, reason: `not installed: \`${command}\` is not on PATH` };
  }
  return { path: found };
}

function commandFailureReason(command: string, result: CommandResult): string {
  if (result.spawnError) return `\`${command}\` could not start: ${describeError(result.spawnError)}`;
  const output = `${result.stdout}\n${result.stderr}`.trim().split('\n')[0]?.trim();
  return `\`${command}\` exited ${result.exitCode}${output ? `: ${output}` : ''}`;
}

async function detectClaudeCode(): Promise<UsableAgent> {
  let path: string;
  try {
    path = findClaudeExecutable('WORKER');
  } catch (error) {
    return { id: 'claude-code', path: null, authenticated: false, reason: `not installed: ${describeError(error)}` };
  }

  if (hasAnthropicApiKey()) {
    return { id: 'claude-code', path, authenticated: true, reason: 'ANTHROPIC_API_KEY in ~/.claude-mem/.env' };
  }
  if (hasAnthropicAuthToken()) {
    return { id: 'claude-code', path, authenticated: true, reason: 'ANTHROPIC_AUTH_TOKEN in ~/.claude-mem/.env' };
  }

  const token = await readClaudeOAuthToken();
  if (token.kind === 'present' && (token.expiresAt === undefined || token.expiresAt > Date.now())) {
    return { id: 'claude-code', path, authenticated: true, reason: `Claude Code OAuth login (${token.source})` };
  }

  // The token read is inconclusive: an expired access token is normally
  // refreshed by the CLI itself, and an absent read can be a keychain the
  // worker cannot see. Ask the CLI.
  const tokenSummary = token.kind === 'present' ? 'stored token expired' : `token ${token.kind}: ${token.reason}`;
  const status = await runCommand(path, ['auth', 'status', '--json']);
  if (status.exitCode !== 0 && !status.stdout.trim()) {
    return {
      id: 'claude-code',
      path,
      authenticated: false,
      reason: `${tokenSummary}; ${commandFailureReason('claude auth status --json', status)}`,
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

async function detectCodex(): Promise<UsableAgent> {
  const resolved = await resolveOnPath('codex');
  if (resolved.path === null) return { id: 'codex', path: null, authenticated: false, reason: resolved.reason };
  const path = resolved.path;

  const status = await runCommand(path, ['login', 'status']);
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
    reason: commandFailureReason('codex login status', status),
  };
}

async function detectGemini(): Promise<UsableAgent> {
  const resolved = await resolveOnPath('gemini');
  if (resolved.path === null) return { id: 'gemini', path: null, authenticated: false, reason: resolved.reason };
  const path = resolved.path;

  if (process.env.GEMINI_API_KEY?.trim()) {
    return { id: 'gemini', path, authenticated: true, reason: 'GEMINI_API_KEY is set' };
  }

  const geminiDirectory = join(homedir(), '.gemini');
  const settingsPath = join(geminiDirectory, 'settings.json');
  const credentialsPath = join(geminiDirectory, 'oauth_creds.json');
  if (!existsSync(settingsPath)) {
    return { id: 'gemini', path, authenticated: false, reason: 'no GEMINI_API_KEY and no ~/.gemini/settings.json' };
  }
  let selectedType: unknown;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { security?: { auth?: { selectedType?: unknown } } };
    selectedType = settings.security?.auth?.selectedType;
  } catch (error) {
    return { id: 'gemini', path, authenticated: false, reason: `~/.gemini/settings.json is unreadable: ${describeError(error)}` };
  }
  if (typeof selectedType !== 'string' || !selectedType) {
    return { id: 'gemini', path, authenticated: false, reason: '~/.gemini/settings.json names no auth type' };
  }
  if (!existsSync(credentialsPath)) {
    return { id: 'gemini', path, authenticated: false, reason: `auth type ${selectedType} but no ~/.gemini/oauth_creds.json` };
  }
  return { id: 'gemini', path, authenticated: true, reason: `auth type ${selectedType} with ~/.gemini/oauth_creds.json` };
}

async function runCheck(id: UsableAgentId, check: () => Promise<UsableAgent>): Promise<UsableAgent> {
  try {
    return await check();
  } catch (error) {
    return { id, path: null, authenticated: false, reason: `check failed: ${describeError(error)}` };
  }
}

/**
 * Report Claude Code, Codex and Gemini in priority order, each with whether
 * it is installed (`path`) and logged in (`authenticated`). Never throws.
 */
export async function detectUsableAgents(): Promise<UsableAgent[]> {
  return Promise.all([
    runCheck('claude-code', detectClaudeCode),
    runCheck('codex', detectCodex),
    runCheck('gemini', detectGemini),
  ]);
}
