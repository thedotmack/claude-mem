/**
 * Which agent CLIs on this machine can run a headless job for claude-mem right
 * now, and are they already logged in?
 *
 * The install funnel extracts Work, Goals and Rules with whatever agent the
 * user already has and is already logged in to, so the user never logs in to
 * anything extra. This module only looks: it never starts a login, never
 * writes agent config, and makes no network call of its own (the agent CLIs
 * it runs may sign in to their own accounts). Every check runs
 * commands with `spawn` (argv, never a shell), waits as long as the CLI takes
 * (owner rule, Oct 22: no time limits or skip-if-slow fallbacks), and never
 * throws. An agent is "not usable" only when its CLI is not installed, says it
 * is logged out, its account is refused, or it exits with an error:
 * `{ authenticated: false, reason }`.
 *
 * Priority order (the first authenticated agent wins downstream):
 * Claude Code → Codex → Gemini.
 *
 * Commands used, verified against local `--help` output:
 *   - `claude auth status --json`  (Claude Code 2.1.308: `--json  Output as JSON (default)`)
 *   - `codex login status`         (codex-cli 0.163.0: prints "Logged in using ChatGPT" to stderr, exit 0)
 *   - Gemini has no status subcommand (gemini 0.49.0). Its login is found in
 *     `~/.gemini/settings.json` `security.auth.selectedType` + `~/.gemini/oauth_creds.json`,
 *     or `GEMINI_API_KEY`. Credential files alone are not proof: Google can refuse the
 *     account (`IneligibleTierError`, e.g. "This client is no longer supported for Gemini
 *     Code Assist for individuals"). So a Google login is checked with the account probe below.
 *
 * Gemini account probe: `gemini --skip-trust -e none --allowed-mcp-server-names <none> -o json`
 * with empty stdin. Headless startup signs in and sets up the Code Assist account first
 * (`refreshAuth` → `setupUser`, the call that throws `IneligibleTierError`), printing
 * "Error authenticating: <error>" to stderr on failure. With no prompt it then exits 42
 * ("No input provided via stdin") before any model request, so the probe uses no generation.
 * Verified against gemini 0.49.0's bundle and on the owner's Mac (about 6 s). One probe per
 * worker lifetime and login: cached until `oauth_creds.json`'s refresh token or the auth type changes.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { findClaudeExecutable } from '../../shared/find-claude-executable.js';
import { readClaudeOAuthToken, type OAuthTokenResult } from '../../shared/oauth-token.js';
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
 * Run a command with argv (no shell) and wait for it to exit, however long
 * that takes. Never rejects. The one spawn-and-collect helper for agent
 * detection, agent runs and the refresh's skill scripts.
 */
export function runCommand(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
export function runCommand(spawnImplementation: typeof spawn, command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
export function runCommand(first: typeof spawn | string, second: string | string[], third: string[] | CommandOptions = {}, fourth: CommandOptions = {}): Promise<CommandResult> {
  const spawnImplementation = typeof first === 'string' ? spawn : first;
  const command = typeof first === 'string' ? first : second as string;
  const args = (typeof first === 'string' ? second : third) as string[];
  const options = (typeof first === 'string' ? third : fourth) as CommandOptions;
  return new Promise<CommandResult>(resolve => {
    const invocation = commandInvocation(command, args);
    const child = spawnImplementation(invocation.command, invocation.args, {
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
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
  /** Wall clock, for token expiry. */
  now: () => number;
  /** Gemini account probe results by login (see the header), kept for the worker's lifetime. */
  geminiAccountChecks: Map<string, Promise<UsableAgent>>;
}

/** Gemini with no MCP server allowed (none is named this), so no MCP server starts. */
export const GEMINI_NO_MCP_SERVERS = 'claude-mem-refresh-uses-no-mcp-servers';
/** gemini 0.49.0 ExitCodes.FATAL_INPUT_ERROR: startup (including sign-in) finished, no prompt was given. */
const GEMINI_NO_INPUT_EXIT_CODE = 42;
const GEMINI_ACCOUNT_PROBE_ARGS = ['--skip-trust', '-e', 'none', '--allowed-mcp-server-names', GEMINI_NO_MCP_SERVERS, '-o', 'json'];

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
  now: Date.now,
  geminiAccountChecks: new Map(),
};

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].trim() || 'unknown error';
}

/** Resolve a command on PATH the way ide-detection.ts does (`which` / `where.exe`). */
async function resolveOnPath(
  dependencies: AgentDetectionDependencies,
  command: string,
): Promise<{ path: string } | { path: null; reason: string }> {
  const windows = dependencies.platform() === 'win32';
  const lookup = windows ? windowsWhereExecutablePath(dependencies.environment) : 'which';
  const result = await runCommand(dependencies.spawn, lookup, [command]);
  const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const firstLine = windows ? selectWindowsCommandCandidate(lines.filter(dependencies.fileExists), shim => resolveVoltaShim(command, shim)) : lines[0];
  if (result.exitCode !== 0 || !firstLine) {
    return { path: null, reason: `not installed: \`${command}\` is not on PATH` };
  }
  return { path: firstLine };
}

function commandFailureReason(command: string, result: CommandResult): string {
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
  const status = await runCommand(dependencies.spawn, path, ['auth', 'status', '--json']);
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

async function detectCodex(dependencies: AgentDetectionDependencies): Promise<UsableAgent> {
  const resolved = await resolveOnPath(dependencies, 'codex');
  if (resolved.path === null) return { id: 'codex', path: null, authenticated: false, reason: resolved.reason };
  const path = resolved.path;

  const status = await runCommand(dependencies.spawn, path, ['login', 'status']);
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
  const loginKey = [path, selectedType, geminiLoginFingerprint(dependencies, credentialsPath)].join('\0');
  let check = dependencies.geminiAccountChecks.get(loginKey);
  if (!check) {
    check = probeGeminiAccount(dependencies, path, selectedType);
    dependencies.geminiAccountChecks.set(loginKey, check);
  }
  const result = await check;
  // Share in-flight checks, but retry failed probes on the next detection pass.
  if (!result.authenticated && dependencies.geminiAccountChecks.get(loginKey) === check) dependencies.geminiAccountChecks.delete(loginKey);
  return result;
}

/** A hash of the stored refresh token (it changes only on a new login), never the token itself. */
function geminiLoginFingerprint(dependencies: AgentDetectionDependencies, credentialsPath: string): string {
  let material: string;
  try {
    const credentials = JSON.parse(dependencies.readTextFile(credentialsPath)) as { refresh_token?: unknown };
    material = typeof credentials.refresh_token === 'string' ? credentials.refresh_token : JSON.stringify(credentials);
  } catch (error) {
    material = `unreadable: ${describeError(error)}`;
  }
  return createHash('sha256').update(material).digest('hex');
}

/** Starts Gemini headless with no prompt: it signs in, then exits before any model request (see the header). */
async function probeGeminiAccount(dependencies: AgentDetectionDependencies, path: string, selectedType: string): Promise<UsableAgent> {
  // CLAUDE_MEM_INTERNAL=1 keeps claude-mem's own Gemini hooks from recording the probe.
  const result = await runCommand(dependencies.spawn, path, GEMINI_ACCOUNT_PROBE_ARGS, {
    cwd: dependencies.homeDirectory(), env: { ...dependencies.environment, CLAUDE_MEM_INTERNAL: '1' }, input: '',
  });
  const authenticationError = /Error authenticating:\s*(.+)/.exec(result.stderr)?.[1]?.trim();
  if (authenticationError) {
    const googleMessage = authenticationError.replace(/^[A-Za-z]*Error:\s*/, '');
    const reason = /IneligibleTierError/.test(authenticationError)
      ? `Gemini is installed, but this Google account can't use it: ${googleMessage}`
      : `Gemini is installed, but its Google sign-in failed: ${googleMessage}`;
    return { id: 'gemini', path, authenticated: false, reason };
  }
  // 42 = signed in, then stopped for lack of a prompt; 0 = a startup hook supplied one and Gemini answered it.
  if (result.exitCode === GEMINI_NO_INPUT_EXIT_CODE || result.exitCode === 0) {
    return { id: 'gemini', path, authenticated: true, reason: `auth type ${selectedType}: Gemini signed in to this Google account` };
  }
  return { id: 'gemini', path, authenticated: false, reason: commandFailureReason('gemini (account check)', result) };
}

async function runCheck(
  id: UsableAgentId,
  check: (dependencies: AgentDetectionDependencies) => Promise<UsableAgent>,
  dependencies: AgentDetectionDependencies,
): Promise<UsableAgent> {
  try {
    return await check(dependencies);
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
