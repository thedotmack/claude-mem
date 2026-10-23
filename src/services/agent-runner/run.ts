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
 *     loaded for its memory-search MCP tools, only the task's allowed tools
 *     (everything else is denied), `cwd` = the data dir and no session persistence.
 *   - Codex: `codex exec -s read-only --ephemeral --ignore-user-config --skip-git-repo-check -C <cwd> -o <file> [-m <model>] [-c model_reasoning_effort="<effort>"] -`
 *     (codex-cli 0.163.0 `exec --help`), prompt on stdin, no MCP servers.
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
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { query, type CanUseTool, type Options, type SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import { detectUsableAgents, runCommand, type CommandResult, type UsableAgent, type UsableAgentId } from './detect.js';

/** The model one step runs on: a Claude Code alias, a Codex model id (with reasoning effort) or a Gemini alias.
 * A missing entry or field leaves that CLI's own default. */
export interface StepModel { model?: string; reasoningEffort?: string }
export type StepModels = Partial<Record<UsableAgentId, StepModel>>;

/** Ask a read-only agent one prompt, on the step's model, and get its final answer text. */
export type AskAgent = (prompt: string, models: StepModels) => Promise<string>;

export interface ClaudeCodeTaskOptions {
  /** Plugins whose MCP servers the steps need. */
  plugins: SdkPluginConfig[];
  /** The built-in tools the model can see at all. */
  tools: string[];
  /** The only tools a step may use (read-only); every other tool is denied. */
  allowedTools: string[];
}

export interface AgentTask {
  /** Why this run happened, for logs and the run record (e.g. 'scheduled', 'setup-scan'). */
  reason: string;
  /** Working directory for every backend: the claude-mem data dir. */
  cwd: string;
  claudeCode: ClaudeCodeTaskOptions;
  /** Drives the agent step by step; returns a short result line. */
  run: (ask: AskAgent, agent: UsableAgentId) => Promise<string>;
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

/** One Agent SDK query per step, with read-only tools only. */
function claudeCodeAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  const { claudeCode } = task;
  const canUseTool: CanUseTool = async toolName => {
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
 * `-s read-only` sandboxes only shell and files, not MCP tools, and `--ephemeral`
 * still loads $CODEX_HOME/config.toml, where the user's write-capable MCP
 * servers (claude-mem's save_memory and work_state_write among them) live.
 * `--ignore-user-config` skips that file, so the run has no MCP tools; auth
 * still comes from CODEX_HOME. Every save goes through the worker's validators.
 */
const CODEX_EXEC_ARGS = (cwd: string, answerPath: string, { model, reasoningEffort }: StepModel = {}) => [
  'exec', '-s', 'read-only', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-C', cwd, '-o', answerPath,
  ...(model ? ['-m', model] : []), ...(reasoningEffort ? ['-c', `model_reasoning_effort="${reasoningEffort}"`] : []), '-',
];

/** Gemini with no extensions and no MCP server (none is named this), so plan mode is the only tool surface. */
export const GEMINI_NO_MCP_SERVERS = 'claude-mem-refresh-uses-no-mcp-servers';
const GEMINI_ARGS = ['-p', 'Follow the instructions above.', '--approval-mode', 'plan', '-e', 'none', '--allowed-mcp-server-names', GEMINI_NO_MCP_SERVERS, '-o', 'json'];

function codexAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  return async (prompt, models) => {
    const env = await dependencies.buildEnv();
    const directory = join(task.cwd, 'agent-runs');
    mkdirSync(directory, { recursive: true });
    const answerPath = join(directory, `codex-${randomBytes(6).toString('hex')}.txt`);
    try {
      const result = await runCli(agent.path!, CODEX_EXEC_ARGS(task.cwd, answerPath, models.codex), prompt, { cwd: task.cwd, env });
      if (result.exitCode !== 0) throw failure('codex exec', result);
      return readFileSync(answerPath, 'utf8');
    } finally {
      rmSync(answerPath, { force: true });
    }
  };
}

function geminiAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  return async (prompt, models) => {
    const env = await dependencies.buildEnv();
    const model = models.gemini?.model;
    const result = await runCli(agent.path!, [...GEMINI_ARGS, ...(model ? ['-m', model] : [])], prompt, { cwd: task.cwd, env });
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
export async function runAgentTask(task: AgentTask, overrides: Partial<AgentRunnerDependencies> = {}): Promise<AgentRunResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const usable = (await dependencies.detect()).filter(agent => agent.authenticated && agent.path);
  if (!usable.length) {
    return { state: 'waiting-for-agent', agent: null, result: null, error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.', attempts: [] };
  }
  const attempts: AgentAttempt[] = [];
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
  return { state: 'failed', agent: last.agent, result: null, error: last.error, attempts };
}
