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
 *   - Claude Code: one Agent SDK `query` with the claude-mem plugin's skills
 *     loaded, an explicit allowed-tools list plus a `canUseTool` check for
 *     everything else, `cwd` = the data dir and no session persistence.
 *   - Codex: `codex exec -s read-only --ephemeral --skip-git-repo-check -C <cwd> -o <file> -`
 *     (codex-cli 0.163.0 `exec --help`), prompt on stdin.
 *   - Gemini: `gemini -p <line> --approval-mode plan --skip-trust -o json`
 *     (gemini 0.49.0 `--help`: plan = read-only mode), prompt on stdin. In a
 *     folder Gemini has never trusted, headless runs exit 55 and plan mode is
 *     overridden; --skip-trust trusts the claude-mem data dir for this one
 *     session only, so plan (read-only) mode holds. It grants no tool approvals.
 *
 * Codex and Gemini run read-only, so they cannot save anything themselves.
 * The task's `inline` function drives them one step at a time and saves each
 * answer through claude-mem's own validators.
 */

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { query, type CanUseTool, type Options, type SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import { detectUsableAgents, type UsableAgent, type UsableAgentId } from './detect.js';

/** Ask a read-only agent one prompt and get its final answer text. */
export type AskAgent = (prompt: string) => Promise<string>;

export interface ClaudeCodeTaskOptions {
  prompt: string;
  /** Plugins whose skills (and MCP servers) the run needs. */
  plugins: SdkPluginConfig[];
  /** Skills the run may call, `plugin:skill`. */
  skills: string[];
  /** The built-in tools the model can see at all. */
  tools: string[];
  /** Auto-approved tool rules (read-only tools and restricted Bash prefixes). */
  allowedTools: string[];
  /**
   * Final check for any tool the allowed list did not approve: true allows it,
   * a string denies it with that message.
   */
  checkTool: (toolName: string, input: Record<string, unknown>) => true | string;
}

export interface AgentTask {
  /** Why this run happened, for logs and the run record (e.g. 'scheduled', 'setup-scan'). */
  reason: string;
  /** Working directory for every backend: the claude-mem data dir. */
  cwd: string;
  claudeCode: ClaudeCodeTaskOptions;
  /** Drives a read-only Codex or Gemini step by step; returns a short result line. */
  inline: (ask: AskAgent, agent: UsableAgentId) => Promise<string>;
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
  spawn: typeof spawn;
  /** Environment for the agent process: the worker's isolated credentials, never tracked by claude-mem's own hooks. */
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
  spawn,
  buildEnv: defaultEnv,
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim() || 'unknown error';

/** One Agent SDK run. Resolves with the final result text; rejects when the run fails. */
async function runClaudeCode(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies): Promise<string> {
  const { claudeCode } = task;
  const canUseTool: CanUseTool = async (toolName, input) => {
    const verdict = claudeCode.checkTool(toolName, input);
    if (verdict === true) return { behavior: 'allow', updatedInput: input };
    logger.warn('WORKER', `Agent run (${task.reason}) was refused ${toolName}`, { reason: verdict });
    return { behavior: 'deny', message: verdict };
  };
  let stderr = '';
  const options: Options = {
    pathToClaudeCodeExecutable: agent.path!,
    cwd: task.cwd,
    env: await dependencies.buildEnv(),
    persistSession: false,
    settingSources: [],
    plugins: claudeCode.plugins,
    skills: claudeCode.skills,
    tools: claudeCode.tools,
    allowedTools: claudeCode.allowedTools,
    permissionMode: 'default',
    canUseTool,
    stderr: data => { stderr = (stderr + data).slice(-4000); },
  };
  type FinalResult = { is_error?: boolean; subtype?: string; result?: string };
  let final = null as FinalResult | null;
  try {
    for await (const message of dependencies.query({ prompt: claudeCode.prompt, options })) {
      if (message.type === 'result') final = message as FinalResult;
    }
  } catch (error) {
    throw new Error(`Claude Code stopped: ${describeError(error)}${stderr.trim() ? ` (${stderr.trim().split('\n').pop()})` : ''}`);
  }
  if (!final) throw new Error('Claude Code ended without a result.');
  if (final.is_error || final.subtype !== 'success') throw new Error(`Claude Code run failed (${final.subtype ?? 'error'}): ${String(final.result ?? '').slice(0, 500)}`);
  return String(final.result ?? '');
}

/** Spawn an agent CLI with the prompt on stdin and wait for it, however long it takes. */
function runCli(
  dependencies: AgentRunnerDependencies,
  command: string,
  args: string[],
  prompt: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = dependencies.spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('close', exitCode => resolve({ exitCode, stdout, stderr }));
    child.stdin?.on('error', () => { /* The exit code reports a CLI that stopped reading. */ });
    child.stdin?.end(prompt);
  });
}

function failure(name: string, result: { exitCode: number | null; stdout: string; stderr: string }): Error {
  const detail = `${result.stderr}\n${result.stdout}`.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 500);
  return new Error(`${name} exited ${result.exitCode}${detail ? `: ${detail}` : ''}`);
}

function codexAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies, env: NodeJS.ProcessEnv): AskAgent {
  return async prompt => {
    const directory = join(task.cwd, 'agent-runs');
    mkdirSync(directory, { recursive: true });
    const answerPath = join(directory, `codex-${randomBytes(6).toString('hex')}.txt`);
    try {
      const result = await runCli(dependencies, agent.path!, ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', task.cwd, '-o', answerPath, '-'], prompt, { cwd: task.cwd, env });
      if (result.exitCode !== 0) throw failure('codex exec', result);
      return readFileSync(answerPath, 'utf8');
    } finally {
      rmSync(answerPath, { force: true });
    }
  };
}

function geminiAsk(agent: UsableAgent, task: AgentTask, dependencies: AgentRunnerDependencies, env: NodeJS.ProcessEnv): AskAgent {
  return async prompt => {
    const result = await runCli(dependencies, agent.path!, ['-p', 'Follow the instructions above.', '--approval-mode', 'plan', '--skip-trust', '-o', 'json'], prompt, { cwd: task.cwd, env });
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
  try { await task.prepare?.(); }
  catch (error) {
    const message = describeError(error).slice(0, 500);
    logger.warn('WORKER', `Agent run (${task.reason}) could not prepare its input`, { error: message });
    return { state: 'failed', agent: null, result: null, error: `Preparing the run failed: ${message}`, attempts };
  }
  for (const agent of usable) {
    logger.info('WORKER', `Agent run (${task.reason}) starting on ${agent.id}`);
    try {
      let result: string;
      if (agent.id === 'claude-code') result = await runClaudeCode(agent, task, dependencies);
      else {
        const env = await dependencies.buildEnv();
        result = await task.inline(agent.id === 'codex' ? codexAsk(agent, task, dependencies, env) : geminiAsk(agent, task, dependencies, env), agent.id);
      }
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
