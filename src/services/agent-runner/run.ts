/**
 * Runs one claude-mem job on the first installed, logged-in agent the user
 * already has (detect.ts order: Claude Code → Codex → Gemini). Shared by My
 * Work's automatic refresh and the install funnel's extraction.
 *
 * Owner rules (Oct 22): no permission-bypass or "dangerous" flags, read-only
 * tools only, and no time limits. A run ends when the agent finishes or exits
 * with an error, never because it is slow. The next agent is tried only when
 * a run actually fails.
 *
 *   - Claude Code: one Agent SDK `query` per step with the claude-mem plugin
 *     loaded for its memory-search MCP tools, only the task's allowed tools,
 *     Read/Grep/Glob only inside the task's readable folders (everything else is
 *     denied), `cwd` = the task's folder and no session persistence.
 *   - Codex: `codex exec --strict-config -c default_permissions=claude-mem-refresh --ephemeral --ignore-user-config --skip-git-repo-check -C <cwd> -o <file> [--output-schema <file>] [-m <model>] [-c model_reasoning_effort="<effort>"] -`
 *     (codex-cli 0.163.0 `exec --help`), prompt on stdin, no MCP servers. A step that names an answer
 *     schema gets it as `--output-schema`, so the final message is that JSON shape and nothing else.
 *   - Gemini: `gemini -p <line> --approval-mode plan -e none --allowed-mcp-server-names <none> -o json [-m <model>]`
 *     (gemini 0.49.0 `--help`: plan = read-only mode), prompt on stdin, no extensions or MCP servers.
 *   Each step names its model per backend (the task's table); Claude Code takes it as the SDK `model` option.
 *
 * No agent can save anything itself. The task's `run` function drives every
 * backend the same way, one step at a time: code runs claude-mem's CLI, the
 * agent answers one JSON question per step, and code saves each answer
 * through claude-mem's own validators.
 */

import { randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { query, type CanUseTool, type Options, type SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import { runtimeReadRoots } from './runtime-read-roots.js';
import { detectUsableAgents, GEMINI_NO_MCP_SERVERS, runCommand, type CommandResult, type UsableAgent, type UsableAgentId } from './detect.js';

/** The model one step runs on: a Claude Code alias, a Codex model id (with reasoning effort) or a Gemini alias.
 * A missing entry or field leaves that CLI's own default. */
export { GEMINI_NO_MCP_SERVERS };

export interface StepModel { model?: string; reasoningEffort?: string }
export type StepModels = Partial<Record<UsableAgentId, StepModel>>;

/** A JSON Schema for a step's answer, strict-mode shaped (every property required, no extra properties). */
export type AnswerSchema = Record<string, unknown>;

/** Ask a read-only agent one prompt, on the step's model, and get its final answer text.
 * With `answerSchema`, an agent CLI that supports structured output (Codex) must answer in that shape. */
export type AskAgent = (prompt: string, models: StepModels, answerSchema?: AnswerSchema) => Promise<string>;

export interface ClaudeCodeTaskOptions {
  /** Plugins whose MCP servers the steps need. */
  plugins: SdkPluginConfig[];
  /** The built-in tools the model can see at all. */
  tools: string[];
  /** Tools approved without a check (read-only MCP tools). Never Read, Grep or Glob: the SDK's
   * allowedTools approves a path anywhere on disk, so those go through `readableFolders`. */
  allowedTools: string[];
  /** The only folders Read, Grep and Glob may touch, checked per call (links resolved). Every other tool is denied. */
  readableFolders: string[];
}

export interface AgentTask {
  /** Why this run happened, for logs and the run record (e.g. 'scheduled', 'setup-scan'). */
  reason: string;
  /** Working directory for every backend (My Work's refresh: the work-view folder). */
  cwd: string;
  claudeCode: ClaudeCodeTaskOptions;
  /** Drives the agent step by step; returns a short result line. */
  run: (ask: AskAgent, agent: UsableAgentId) => Promise<string>;
  /** Input every backend reads, prepared once a logged-in agent is found (e.g. the owner's prompts file). */
  prepare?: () => Promise<void>;
}

export interface AgentAttempt { agent: UsableAgentId; error: string }

export interface AgentRunResult {
  state: 'ok' | 'failed' | 'waiting-for-agent';
  agent: UsableAgentId | null;
  result: string | null;
  error: string | null;
  attempts: AgentAttempt[];
}

export interface AgentRunnerDependencies {
  detect: () => Promise<UsableAgent[]>;
  query: typeof query;
  /** Environment for the agent process: the worker's isolated credentials, never tracked by claude-mem's own hooks.
   * Built fresh for every step: a run can outlive the OAuth access token it started with (Oct 22: the Mac slept
   * 11 hours mid-run, and the token injected at the start was revoked by the time the next step asked). */
  buildEnv: () => Promise<NodeJS.ProcessEnv>;
}

async function defaultEnv(): Promise<NodeJS.ProcessEnv> {
  // CLAUDE_MEM_INTERNAL=1 keeps claude-mem's hooks from recording this run as
  // the owner's own work, so a refresh never makes itself due again.
  return { ...sanitizeEnv(await buildIsolatedEnvWithFreshOAuth()), CLAUDE_MEM_INTERNAL: '1' };
}

const defaultDependencies: AgentRunnerDependencies = {
  detect: () => detectUsableAgents(),
  query,
  buildEnv: defaultEnv,
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim() || 'unknown error';

const FILE_TOOLS = ['Read', 'Grep', 'Glob'];

/** `path` with every existing link resolved; the part that does not exist yet is kept as written. */
function realPath(path: string): string {
  try { return realpathSync(path); }
  catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), relative(parent, path));
  }
}

/** True when the file tool call stays inside `folders`: its path (relative to `cwd`) and, for Glob, its pattern. */
export function fileToolStaysInside(toolName: string, input: Record<string, unknown>, cwd: string, folders: string[]): boolean {
  const named = toolName === 'Read' ? input.file_path : input.path ?? cwd;
  if (typeof named !== 'string' || !named) return false;
  const inside = (path: string) => {
    const real = realPath(resolve(cwd, path));
    return folders.some(folder => { const from = relative(realPath(resolve(folder)), real); return from === '' || (!from.startsWith('..') && !isAbsolute(from)); });
  };
  if (!inside(named)) return false;
  // A Glob pattern is matched from its path; an absolute or climbing pattern could leave it.
  if (toolName === 'Glob' && (typeof input.pattern !== 'string' || isAbsolute(input.pattern) || input.pattern.split(/[\\/]/).includes('..'))) return false;
  return true;
}

/** One Agent SDK query per step, with read-only tools only. */
function claudeCodeAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  const { claudeCode } = task;
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (FILE_TOOLS.includes(toolName) && fileToolStaysInside(toolName, input, task.cwd, claudeCode.readableFolders)) {
      return { behavior: 'allow', updatedInput: input };
    }
    logger.warn('WORKER', `Agent run (${task.reason}) was refused ${toolName}`);
    return { behavior: 'deny', message: `${toolName} is not available to this read-only step.` };
  };
  return async (prompt, models) => {
    const env = await dependencies.buildEnv();
    let stderr = '';
    const options: Options = {
      pathToClaudeCodeExecutable: agent.path!,
      model: models['claude-code']?.model,
      cwd: task.cwd,
      env,
      persistSession: false,
      settingSources: [],
      plugins: claudeCode.plugins,
      tools: claudeCode.tools,
      allowedTools: claudeCode.allowedTools,
      permissionMode: 'default',
      canUseTool,
      stderr: data => { stderr = (stderr + data).slice(-4000); },
    };
    type FinalResult = { is_error?: boolean; subtype?: string; result?: string };
    let final = null as FinalResult | null;
    try {
      for await (const message of dependencies.query({ prompt, options })) {
        if (message.type === 'result') final = message as FinalResult;
      }
    } catch (error) {
      throw new Error(`Claude Code stopped: ${describeError(error)}${stderr.trim() ? ` (${stderr.trim().split('\n').pop()})` : ''}`);
    }
    if (!final) throw new Error('Claude Code ended without a result.');
    if (final.is_error || final.subtype !== 'success') throw new Error(`Claude Code run failed (${final.subtype ?? 'error'}): ${String(final.result ?? '').slice(0, 500)}`);
    return String(final.result ?? '');
  };
}

/** Run an agent CLI with the prompt on stdin and wait for it, however long it takes. */
async function runCli(
  command: string,
  args: string[],
  prompt: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const result = await runCommand(command, args, { ...options, input: prompt });
  if (result.spawnError) throw result.spawnError;
  return result;
}

function failure(name: string, result: CommandResult): Error {
  const detail = `${result.stderr}\n${result.stdout}`.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 500);
  return new Error(`${name} exited ${result.exitCode}${detail ? `: ${detail}` : ''}`);
}

/**
 * A named permissions profile confines reads to the task workspace and minimal runtime,
 * with the installed Codex executable reopened so its sandbox helper can start.
 * Network and writes are denied. Strict config makes unsupported versions fail closed.
 * `--ephemeral`
 * still loads $CODEX_HOME/config.toml, where the user's write-capable MCP
 * servers (claude-mem's save_memory and work_state_write among them) live.
 * `--ignore-user-config` skips that file, so the run has no MCP tools; auth
 * still comes from CODEX_HOME. Every save goes through the worker's validators.
 */
const CODEX_EXEC_ARGS = (executable: string, cwd: string, answerPath: string, schemaPath: string | null, { model, reasoningEffort }: StepModel = {}) => [
  'exec', '--strict-config', '-c', 'default_permissions="claude-mem-refresh"',
  '-c', `permissions.claude-mem-refresh.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"},${runtimeReadRoots(executable).map(path => `${JSON.stringify(path)}="read"`).join(',')}}`,
  '-c', 'permissions.claude-mem-refresh.network.enabled=false', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-C', cwd, '-o', answerPath,
  ...(schemaPath ? ['--output-schema', schemaPath] : []), ...(model ? ['-m', model] : []), ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []), '-',
];

// The folder trust gate remains intact. System settings below also register
// no builtin tools, disable hooks/YOLO, and supply Gemini's evidence inline.
const GEMINI_ARGS = ['-p', 'Follow the instructions above.', '--approval-mode', 'plan', '-e', 'none', '--allowed-mcp-server-names', GEMINI_NO_MCP_SERVERS, '-o', 'json'];

function codexAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  return async (prompt, models, answerSchema) => {
    const env = await dependencies.buildEnv();
    const directory = join(task.cwd, 'agent-runs');
    mkdirSync(directory, { recursive: true });
    const id = randomBytes(6).toString('hex');
    const answerPath = join(directory, `codex-${id}.txt`);
    // Free-form JSON from Codex can be malformed (Oct 23: an 82-conversation grouping answer closed
    // its arrays twice), so a step with a schema asks Codex's structured output for it instead.
    const schemaPath = answerSchema ? join(directory, `codex-${id}.schema.json`) : null;
    if (schemaPath) writeFileSync(schemaPath, JSON.stringify(answerSchema), { mode: 0o600 });
    try {
      const result = await runCli(agent.path!, CODEX_EXEC_ARGS(agent.path!, task.cwd, answerPath, schemaPath, models.codex), prompt, { cwd: task.cwd, env });
      if (result.exitCode !== 0) throw failure('codex exec', result);
      return readFileSync(answerPath, 'utf8');
    } finally {
      rmSync(answerPath, { force: true });
      if (schemaPath) rmSync(schemaPath, { force: true });
    }
  };
}

function geminiAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  return async (prompt, models) => {
    const env = await dependencies.buildEnv();
    const model = models.gemini?.model;
    const policyDir = mkdtempSync(join(tmpdir(), 'claude-mem-gemini-policy-'));
    const policyPath = join(policyDir, 'settings.json');
    // System settings override project/user config. An empty core list registers
    // no builtin tools: all evidence is inline, so no disk reads or plan exit are needed.
    writeFileSync(policyPath, JSON.stringify({
      tools: { core: [] },
      security: { disableYoloMode: true }, hooksConfig: { enabled: false },
    }), { mode: 0o600 });
    let result: CommandResult;
    try {
      result = await runCli(agent.path!, [...GEMINI_ARGS, ...(model ? ['-m', model] : [])], prompt, {
        cwd: task.cwd, env: { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: policyPath },
      });
    } finally { rmSync(policyDir, { recursive: true, force: true }); }
    if (result.exitCode !== 0) throw failure('gemini', result);
    let output: { response?: unknown; error?: { message?: string } };
    try { output = JSON.parse(result.stdout); }
    catch { throw new Error(`gemini printed unreadable JSON: ${result.stdout.slice(0, 200)}`); }
    if (output.error) throw new Error(`gemini failed: ${output.error.message ?? 'unknown error'}`);
    if (typeof output.response !== 'string') throw new Error('gemini answered without a response.');
    return output.response;
  };
}

/**
 * Run the task on the first usable agent, falling through to the next only
 * when a run fails. Never throws. With no logged-in agent it returns
 * `waiting-for-agent` and runs nothing.
 */
const agentNames: Record<UsableAgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini' };

export async function runAgentTask(task: AgentTask, overrides: Partial<AgentRunnerDependencies> = {}): Promise<AgentRunResult> {
  const autoApprovedFileTools = task.claudeCode.allowedTools.filter(tool => FILE_TOOLS.includes(tool));
  if (autoApprovedFileTools.length) throw new Error(`Agent task ${task.reason} auto-approves ${autoApprovedFileTools.join(', ')}, which would read anywhere on disk; name readableFolders instead.`);
  const dependencies = { ...defaultDependencies, ...overrides };
  const usable = (await dependencies.detect()).filter(agent => agent.authenticated && agent.path);
  if (!usable.length) {
    return { state: 'waiting-for-agent', agent: null, result: null, error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.', attempts: [] };
  }
  const attempts: AgentAttempt[] = [];
  try { await task.prepare?.(); }
  catch (error) {
    const message = describeError(error).slice(0, 500);
    logger.warn('WORKER', `Agent run (${task.reason}) could not prepare its input`, { error: message });
    return { state: 'failed', agent: null, result: null, error: `Preparing the run failed: ${message}`, attempts };
  }
  for (const agent of usable) {
    logger.info('WORKER', `Agent run (${task.reason}) starting on ${agent.id}`);
    try {
      const ask = { 'claude-code': claudeCodeAsk, codex: codexAsk, gemini: geminiAsk }[agent.id](agent, task, dependencies);
      const result = await task.run(ask, agent.id);
      logger.info('WORKER', `Agent run (${task.reason}) finished on ${agent.id}`);
      return { state: 'ok', agent: agent.id, result: result.slice(0, 4000), error: null, attempts };
    } catch (error) {
      const message = describeError(error).slice(0, 500);
      logger.warn('WORKER', `Agent run (${task.reason}) failed on ${agent.id}`, { error: message });
      attempts.push({ agent: agent.id, error: message });
    }
  }
  const last = attempts[attempts.length - 1];
  // Every agent's failure, in the order tried: the last fallback's error alone hides why the first ones failed.
  const error = attempts.map(attempt => `${agentNames[attempt.agent]}: ${attempt.error}`).join(' · ');
  return { state: 'failed', agent: last.agent, result: null, error, attempts };
}
