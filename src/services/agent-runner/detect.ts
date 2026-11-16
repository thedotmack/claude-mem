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

import { spawn, type SpawnOptions } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { findClaudeExecutable } from '../../shared/find-claude-executable.js';
import { readClaudeOAuthToken, type OAuthTokenResult } from '../../shared/oauth-token.js';
import { hasAnthropicApiKey, hasAnthropicAuthToken, hasConfiguredClaudeOAuthToken } from '../../shared/EnvManager.js';

import { commandInvocation, resolveVoltaShim, selectWindowsCommandCandidate, windowsWhereExecutablePath } from '../../shared/spawn.js';
import { PROCESS_EXIT_POLL_INTERVAL_MS, processGroupHasProcesses } from '../../supervisor/process-registry.js';

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
  /** Exit code, or null when the process never started or a signal ended it. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * Set only when the process could not be started (e.g. ENOENT). A command stopped through `CommandOptions.signal`
   * did start, so a stop never sets it: `exitCode` and the output tell how the command ended.
   */
  spawnError?: Error;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed; without it stdin is ignored. */
  input?: string;
  /**
   * Aborting it stops the command with `killSignal` (SIGTERM when none is given). The result still comes once the
   * command has exited, with everything it printed.
   *
   * On macOS and Linux the command starts as the leader of a process group of its own, and the signal goes to that
   * whole group, as Ctrl+C in a terminal does. The command found on PATH can be a launcher script that runs the real
   * CLI as its child and passes no signal on: an agent wrapper written in bash that traps INT is one, because bash runs
   * a trap only after its foreground child has exited, so a signal sent to the script alone never reaches the CLI.
   *
   * There the command has exited only once no process is left in its group. A launcher can exit before the CLI it
   * started: one with no SIGINT handler (a Node script, by Node's default) dies on the stop at once, while the CLI it ran,
   * sent the same stop, goes on writing out its turn. Its 'close' then comes when the CLI's output closes, or at once
   * when the CLI does not write to the command's own stdout and stderr. So the result comes once the group is empty
   * (onProcessesLeftInItsGroup), and until then aborting still sends `killSignal` to what is left of it.
   *
   * On Windows the signal goes to the command alone, through Node's own `signal` and `killSignal` options, as before.
   * Windows has no process group a signal can be sent to, Node ends a Windows process forcefully whatever the signal,
   * and a `.cmd` shim's program runs in a child of cmd.exe that this does not reach. Reaching that child would take
   * `taskkill /T /F`, which also kills outright: unlike SIGINT, it leaves the CLI no way to end its turn. So on
   * Windows a stop may not stop the program behind a shim.
   */
  signal?: AbortSignal;
  killSignal?: NodeJS.Signals;
  /**
   * Told at once, with the error, when the stop could not be sent to the command's process group on macOS and Linux:
   * during the abort, or before runCommand returns when `signal` was aborted already. "No such process" is not such an
   * error: the command has exited, so nothing was left to stop. After it, the command runs on until it ends by itself,
   * and its result comes as usual. Without it, the error is thrown during the abort, which reaches no caller: the
   * runtime reports it as an uncaught exception.
   */
  onStopNotSent?: (error: Error) => void;
  /**
   * Told the command's process id once it has started, with the process group a stop goes to: its own pid on macOS and
   * Linux when `signal` is given (see CommandOptions.signal), and undefined otherwise. Not told when it never started.
   * The conversation runner keeps a command with them while it runs, among its own running commands and in the worker's
   * process registry like every other process the worker starts, so the worker's shutdown waits for it and force-stops
   * it if it has not exited before the worker does.
   */
  onSpawn?: (started: { pid: number; processGroupId: number | undefined }) => void;
  /**
   * Told once, on macOS and Linux when `signal` is given, when everything the command wrote has been read and the
   * command has exited, but processes are still left in its process group (see CommandOptions.signal): the processes
   * it started, such as the CLI behind a launcher that has exited. The result comes once none is left, and a stop sent
   * meanwhile still reaches them.
   */
  onProcessesLeftInItsGroup?: (left: { processGroupId: number; exitCode: number | null }) => void;
}

/** The spawn options that let `signal` stop the command (see CommandOptions.signal), and none without a signal. */
function stopOptionsFor(options: CommandOptions): Pick<SpawnOptions, 'detached' | 'signal' | 'killSignal'> {
  if (options.signal === undefined) return {};
  if (process.platform !== 'win32') return { detached: true };
  return { signal: options.signal, killSignal: options.killSignal };
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
    const stopOptions = stopOptionsFor(options);
    const child = spawnImplementation(invocation.command, invocation.args, {
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      cwd: options.cwd,
      env: options.env,
      ...stopOptions,
      windowsHide: true,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    // A group's id is its leader's pid, and `detached` made the command one (stopOptionsFor).
    if (child.pid !== undefined) options.onSpawn?.({ pid: child.pid, processGroupId: stopOptions.detached ? child.pid : undefined });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let settled = false;
    // macOS and Linux: aborting signals the command's whole process group, which `detached` made it the leader of.
    const processGroupStopSignal = stopOptions.detached ? options.signal : undefined;
    const stopProcessGroup = () => {
      // A command that never started has no group to stop; its 'error' reports that it did not start.
      if (child.pid === undefined) return;
      try {
        // A group's id is its leader's pid.
        process.kill(-child.pid, options.killSignal ?? 'SIGTERM');
      } catch (error) {
        // ESRCH: every process in the group has exited already, so nothing is left to stop.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        // Anything else: the stop was not sent, and the command runs on until it ends by itself (onStopNotSent).
        if (!options.onStopNotSent) throw error;
        options.onStopNotSent(error as Error);
      }
    };
    const settle = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      // Once the command has ended, a late abort must not signal a process group that may no longer be its own.
      processGroupStopSignal?.removeEventListener('abort', stopProcessGroup);
      resolve(result);
    };
    if (processGroupStopSignal?.aborted) stopProcessGroup();
    else processGroupStopSignal?.addEventListener('abort', stopProcessGroup, { once: true });
    child.on('error', error => {
      // Windows: Node's own abort (see CommandOptions.signal) stops a command that did start, and emits this
      // AbortError at once, while the command may still be finishing. It is not a failure to start: the command's
      // 'close' follows when it has exited, so wait for that.
      if (error.name === 'AbortError' && options.signal?.aborted) return;
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
      const result: CommandResult = { exitCode: code, stdout, stderr, spawnError };
      // It has exited now when it has no process group of its own (no signal, or Windows), or none is left in its group.
      if (processGroupStopSignal === undefined || child.pid === undefined || !processGroupHasProcesses(child.pid)) {
        settle(result);
        return;
      }
      // macOS and Linux: processes it started are still running in its group (CommandOptions.signal). It ends once none
      // is left, looked for again at the supervisor's interval for its own waits on processes to exit.
      const processGroupId = child.pid;
      options.onProcessesLeftInItsGroup?.({ processGroupId, exitCode: code });
      const settleOnceTheGroupIsEmpty = () => {
        if (processGroupHasProcesses(processGroupId)) setTimeout(settleOnceTheGroupIsEmpty, PROCESS_EXIT_POLL_INTERVAL_MS);
        else settle(result);
      };
      setTimeout(settleOnceTheGroupIsEmpty, PROCESS_EXIT_POLL_INTERVAL_MS);
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
  hasConfiguredClaudeOAuthToken: () => boolean;
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
  hasConfiguredClaudeOAuthToken,
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
  if (dependencies.hasConfiguredClaudeOAuthToken()) {
    return { id: 'claude-code', path, authenticated: true, reason: 'CLAUDE_CODE_OAUTH_TOKEN in ~/.claude-mem/.env' };
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

  const configuredHome = dependencies.environment.GEMINI_CLI_HOME;
  const geminiDirectory = join(configuredHome ? resolve(configuredHome) : dependencies.homeDirectory(), '.gemini');
  const settingsPath = join(geminiDirectory, 'settings.json');
  const credentialsPath = join(geminiDirectory, 'oauth_creds.json');
  const settingsLabel = configuredHome ? settingsPath : '~/.gemini/settings.json';
  const credentialsLabel = configuredHome ? credentialsPath : '~/.gemini/oauth_creds.json';
  if (!dependencies.fileExists(settingsPath)) {
    return { id: 'gemini', path, authenticated: false, reason: `no GEMINI_API_KEY and no ${settingsLabel}` };
  }
  let selectedType: unknown;
  try {
    const settings = JSON.parse(dependencies.readTextFile(settingsPath)) as { security?: { auth?: { selectedType?: unknown } } };
    selectedType = settings.security?.auth?.selectedType;
  } catch (error) {
    return { id: 'gemini', path, authenticated: false, reason: `${settingsLabel} is unreadable: ${describeError(error)}` };
  }
  if (typeof selectedType !== 'string' || !selectedType) {
    return { id: 'gemini', path, authenticated: false, reason: `${settingsLabel} names no auth type` };
  }
  if (!dependencies.fileExists(credentialsPath)) {
    return { id: 'gemini', path, authenticated: false, reason: `auth type ${selectedType} but no ${credentialsLabel}` };
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
    cwd: dependencies.homeDirectory(), env: { ...dependencies.environment, CLAUDE_MEM_INTERNAL: '1',
      // The probe runs in a different cwd; retain the profile selected here.
      ...(dependencies.environment.GEMINI_CLI_HOME ? { GEMINI_CLI_HOME: resolve(dependencies.environment.GEMINI_CLI_HOME) } : {}),
    }, input: '',
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

/** Each agent's own check, by id: what detectUsableAgent runs. */
const AGENT_CHECKS: Record<UsableAgentId, (dependencies: AgentDetectionDependencies) => Promise<UsableAgent>> = {
  'claude-code': detectClaudeCode,
  codex: detectCodex,
  gemini: detectGemini,
};

/**
 * Report one agent as detectUsableAgents reports it: whether it is installed (`path`) and logged in (`authenticated`).
 * Only that agent's own check runs, so no other CLI is started; with a Google login, Gemini's check starts the Gemini
 * CLI headless (see the header). Never throws.
 */
export async function detectUsableAgent(
  id: UsableAgentId,
  overrides: Partial<AgentDetectionDependencies> = {},
): Promise<UsableAgent> {
  return runCheck(id, AGENT_CHECKS[id], { ...defaultDependencies, ...overrides });
}
