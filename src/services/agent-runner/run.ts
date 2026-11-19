/**
 * Runs one claude-mem job on the first installed, logged-in agent the user
 * already has (detect.ts order: Claude Code → Codex → Gemini). Shared by My
 * Work's automatic refresh and the install funnel's extraction.
 *
 * Owner rules (Oct 22): no permission-bypass or "dangerous" flags, read-only
 * tools only, and no time limits. A run ends when the agent finishes or exits
 * with an error, never because it is slow. The next agent is tried only when
 * a run actually fails. An agent that ran and answered, but whose answer
 * claude-mem's own checks refused, is not a failed agent: the run ends there
 * and the next scheduled run tries the same agent again (#5189: a too-long
 * Claude review sent ~230 hidden runs to the owner's Codex account).
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
 *   - OpenCode: `opencode run --pure --format json --dir <cwd> --agent claude-mem-refresh [-m provider/model]`
 *     (opencode 1.14 `run --help`), prompt on stdin, no MCP servers and an agent that disables every tool.
 *   - API: one chat-completions call to the selected provider (OpenRouter or an
 *     OpenAI-compatible endpoint), with the answer's schema when the step has one.
 *     No subprocess, so no local CLI is started and no Claude Code OAuth token is
 *     injected: an API install runs on the provider it chose.
 *   Each step names its model per backend (the task's table); Claude Code takes it as the SDK `model` option.
 *
 * No agent can save anything itself. The task's `run` function drives every
 * backend the same way, one step at a time: code runs claude-mem's CLI, the
 * agent answers one JSON question per step, and code saves each answer
 * through claude-mem's own validators.
 */

import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { query, type CanUseTool, type Options, type SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { buildIsolatedEnvWithFreshOAuth } from '../../shared/EnvManager.js';
import { stripJsonComments, stripUtf8Bom } from '../../shared/atomic-json.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';
import { runtimeReadRoots } from './runtime-read-roots.js';
import { detectUsableAgents, GEMINI_NO_MCP_SERVERS, runCommand, type CommandResult, type UsableAgent, type UsableAgentId } from './detect.js';
import { ApiProviderError, askApiTarget, resolveApiTarget } from './api-agent.js';
import { WAITING_FOR_AGENT_REASON } from '../../shared/work-view-refresh-reasons.js';

/** The model one step runs on: a Claude Code alias, a Codex model id (with reasoning effort) or a Gemini alias.
 * A missing entry or field leaves that CLI's own default. */
export { GEMINI_NO_MCP_SERVERS };

/**
 * The agents a task may run on: the local CLIs detect.ts finds, plus 'api' — the
 * selected API provider (api-agent.ts). 'api' is not a CLI: it is a chat
 * completions endpoint, and it exists so a task on an API install never falls
 * back to the local Claude Code, whose runs spend the owner's Anthropic
 * subscription.
 */
export type TaskAgentId = UsableAgentId | 'api';

/** One agent a task can run on. The local CLIs come from detect.ts; 'api' is synthetic. */
export interface TaskAgent {
  id: TaskAgentId;
  path: string | null;
  authenticated: boolean;
  reason: string;
}

export interface StepModel { model?: string; reasoningEffort?: string }
export type StepModels = Partial<Record<TaskAgentId, StepModel>>;

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
  run: (ask: AskAgent, agent: TaskAgentId) => Promise<string>;
  /** Input every backend reads, prepared once a logged-in agent is found (e.g. the owner's prompts file). */
  prepare?: () => Promise<void>;
  /** Tried first when it is logged in; the other usable agents keep detect order behind it. Absent: detect
   * order alone decides. The My Work refresh sets this from CLAUDE_MEM_PROVIDER (#5435). */
  preferredAgent?: TaskAgentId;
  /** The only agents this task may run on; absent means every logged-in agent. An empty list runs nothing
   * and does not even detect agents (#5189: a background refresh must not spend an agent the owner did not pick). */
  allowedAgents?: TaskAgentId[];
  /** Never hand a failed run to a second agent: each fallback spends another agent's quota (#5189). */
  stayOnFirstUsableAgent?: boolean;
}

export interface AgentAttempt { agent: TaskAgentId; error: string }

/** A task throws an error carrying `answerRefused: true` when claude-mem's own checks refused the agent's answer. */
const isAnswerRefusal = (error: unknown) => (error as { answerRefused?: boolean } | null)?.answerRefused === true;

export interface AgentRunResult {
  state: 'ok' | 'failed' | 'waiting-for-agent';
  agent: TaskAgentId | null;
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
  /** Runtime platform, injectable so the Windows confinement gate is regression-testable. */
  platform: () => NodeJS.Platform;
  /** The user's own OpenCode default model and custom providers, kept in an otherwise isolated run. */
  opencodeUserConfig?: () => { model?: string; provider?: Record<string, unknown> };
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
  platform: () => process.platform,
  opencodeUserConfig: readOpenCodeUserConfig,
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
function claudeCodeAsk(agent: TaskAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
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

/** How codex exec reports a model this login may not use (Oct 25, codex-cli 0.146.0: a 400 with model_not_found). */
const CODEX_MODEL_REFUSED = /model_not_found|not supported when using Codex with a ChatGPT account/i;

interface CodexListedModel { slug?: string; visibility?: string; priority?: number; supported_reasoning_levels?: Array<{ effort?: string }> }

/**
 * The step's Codex model, checked against the models Codex itself lists for this login
 * ($CODEX_HOME/models_cache.json, which Codex fetches from its server). Oct 25: a ChatGPT-account
 * login was refused `gpt-6-luna` ("not supported when using Codex with a ChatGPT account",
 * model_not_found) and every grouping step on Codex failed. A model the login does not list is
 * replaced by its listed namesake (`gpt-6-luna` → `gpt-5.6-luna`), else left to Codex's default.
 * Without a readable list the step's model is used as named.
 */
export function codexModelForLogin(step: StepModel | undefined, env: NodeJS.ProcessEnv): StepModel | undefined {
  if (!step?.model) return step;
  const home = env.CODEX_HOME || (env.HOME ? join(env.HOME, '.codex') : null);
  if (!home) return step;
  let listed: CodexListedModel[];
  try { listed = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')).models; }
  catch { return step; }
  if (!Array.isArray(listed) || !listed.length || listed.some(model => model.slug === step.model)) return step;
  const family = step.model.split('-').pop();
  const namesake = listed
    .filter(model => model.visibility !== 'hide' && typeof model.slug === 'string' && model.slug.split('-').pop() === family)
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))[0];
  logger.warn('WORKER', `Codex does not list ${step.model} for this login; using ${namesake?.slug ?? 'its default model'}`);
  if (!namesake) return {};
  const efforts = namesake.supported_reasoning_levels?.map(level => level.effort);
  const keepsEffort = step.reasoningEffort && (!efforts || efforts.includes(step.reasoningEffort));
  return { model: namesake.slug, ...(keepsEffort ? { reasoningEffort: step.reasoningEffort } : {}) };
}

function codexAsk(agent: TaskAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
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
      // macOS sandbox-exec must reopen the actual binary, not its PATH symlink.
      const executable = realPath(agent.path!);
      const model = codexModelForLogin(models.codex, env);
      let result = await runCli(executable, CODEX_EXEC_ARGS(executable, task.cwd, answerPath, schemaPath, model), prompt, { cwd: task.cwd, env });
      // The models list can be missing or stale, so a login can still refuse the step's model. Then the
      // step runs once more on the login's default model instead of failing (Oct 25: gpt-6-luna).
      if (result.exitCode !== 0 && model?.model && CODEX_MODEL_REFUSED.test(`${result.stderr}\n${result.stdout}`)) {
        logger.warn('WORKER', `Codex refused ${model.model} for this login; retrying on its default model`);
        result = await runCli(executable, CODEX_EXEC_ARGS(executable, task.cwd, answerPath, schemaPath, {}), prompt, { cwd: task.cwd, env });
      }
      if (result.exitCode !== 0) {
        // Recognize the actual capability refusal rather than disabling Codex
        // on every Windows machine: elevated/MXC installations may support it.
        if (dependencies.platform() === 'win32'
          && /unelevated restricted-token sandbox cannot enforce split filesystem read restrictions/i.test(`${result.stderr}\n${result.stdout}`)) {
          throw new Error('Codex refused this refresh because its Windows unelevated sandbox cannot enforce the required read restrictions. Use an administrator-provisioned elevated sandbox or a supported MXC sandbox. The existing provider fallback remains available; filesystem restrictions were preserved.');
        }
        throw failure('codex exec', result);
      }
      return readFileSync(answerPath, 'utf8');
    } finally {
      rmSync(answerPath, { force: true });
      if (schemaPath) rmSync(schemaPath, { force: true });
    }
  };
}

function geminiAsk(agent: TaskAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
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
        cwd: task.cwd, env: { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: policyPath,
          // Changing cwd must not select another relative Gemini profile.
          ...(env.GEMINI_CLI_HOME ? { GEMINI_CLI_HOME: resolve(env.GEMINI_CLI_HOME) } : {}),
        },
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
 * The final assistant text of `opencode run --format json`: the CLI streams each
 * text part as it arrives, so the answer is every part's text in order. An error
 * event is reported even when the exit code is 0 (a cancelled session, for one).
 */
export function opencodeAnswer(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: { type?: unknown; part?: { text?: unknown }; error?: { message?: unknown } };
    try { event = JSON.parse(line); }
    catch { continue; }
    if (event.type === 'error') {
      throw new Error(`opencode failed: ${typeof event.error?.message === 'string' ? event.error.message : 'unknown error'}`);
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') texts.push(event.part.text);
  }
  const answer = texts.join('');
  if (!answer.trim()) throw new Error('opencode answered without text.');
  return answer;
}

/**
 * The parts of the user's own OpenCode config an isolated run must keep: the
 * default model (when no step pins one) and custom provider definitions, which
 * may be the only place a provider the owner configured is described. Tools,
 * plugins, MCP servers and agents are deliberately not carried over; the run's
 * own config replaces those. An unreadable or absent config yields nothing, and
 * the CLI then falls back to its own defaults as before.
 */
export function readOpenCodeUserConfig(): { model?: string; provider?: Record<string, unknown> } {
  const configDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
  const candidates = [
    process.env.OPENCODE_CONFIG,
    join(configDirectory, 'opencode.json'),
    join(configDirectory, 'opencode.jsonc'),
  ].filter((path): path is string => typeof path === 'string' && path.length > 0);
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(stripJsonComments(stripUtf8Bom(readFileSync(path, 'utf8')))) as Record<string, unknown>;
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model : undefined;
      const provider = parsed.provider && typeof parsed.provider === 'object' && !Array.isArray(parsed.provider)
        ? parsed.provider as Record<string, unknown>
        : undefined;
      return { ...(model ? { model } : {}), ...(provider ? { provider } : {}) };
    } catch { /* an unreadable user config must not fail the step */ }
  }
  return {};
}

/**
 * One step through the OpenCode CLI, with the same read-only, evidence-inline
 * boundary as Gemini: a temporary config root registers no MCP servers, and a
 * primary agent disables every builtin tool, so the step can neither read the
 * disk, write, run commands nor reach the web. `--pure` also keeps the user's
 * external plugins (claude-mem's own among them) out of the run. The step runs
 * from that config root, not the task folder: OpenCode merges a project's own
 * `opencode.json`, which can add MCP servers, and no config key can remove one
 * later. The prompt goes on stdin: a refresh step's evidence can exceed the
 * Windows argv limit, and `opencode run` reads a piped stdin as its message when
 * no message is given.
 */
function opencodeAsk(agent: TaskAgent, _task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  return async (prompt, models) => {
    const env = await dependencies.buildEnv();
    const model = models.opencode?.model;
    const userConfig = (dependencies.opencodeUserConfig ?? readOpenCodeUserConfig)();
    const configHome = mkdtempSync(join(tmpdir(), 'claude-mem-opencode-'));
    const configDirectory = join(configHome, 'opencode');
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      // The owner's default model and providers survive; everything else below
      // is the run's own boundary and overrides what the user configured.
      ...(userConfig.model ? { model: userConfig.model } : {}),
      ...(userConfig.provider ? { provider: userConfig.provider } : {}),
      mcp: {},
      permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
      agent: {
        'claude-mem-refresh': {
          description: 'Read-only step for claude-mem My Work refresh (evidence is inline)',
          mode: 'primary',
          tools: {
            bash: false, edit: false, write: false, patch: false, read: false, grep: false, glob: false,
            list: false, webfetch: false, websearch: false, task: false, todoread: false, todowrite: false,
            question: false,
          },
        },
      },
    }), { mode: 0o600 });
    try {
      const result = await runCli(agent.path!, [
        'run', '--pure', '--format', 'json', '--dir', configHome, '--agent', 'claude-mem-refresh',
        ...(model ? ['--model', model] : []),
      ], prompt, {
        cwd: configHome,
        // XDG_CONFIG_HOME selects the isolated config root on every platform OpenCode reads it from.
        // The step also runs from that root, so a project opencode.json (which can add MCP servers)
        // is never discovered, and the explicit config paths neutralize the user's own overrides.
        env: {
          ...env,
          XDG_CONFIG_HOME: configHome,
          PWD: configHome,
          OPENCODE_CONFIG: join(configDirectory, 'opencode.json'),
          OPENCODE_CONFIG_DIR: configDirectory,
        },
      });
      if (result.exitCode !== 0) throw failure('opencode', result);
      return opencodeAnswer(result.stdout);
    } finally { rmSync(configHome, { recursive: true, force: true }); }
  };
}

/**
 * One chat-completions call to the selected API provider.
 *
 * The provider is resolved per step, so a key or model changed between two
 * steps applies to the next one. This backend never builds the worker's
 * environment and never starts a subprocess: there is no Claude Code OAuth
 * token to inject and no local CLI to spend.
 */
function apiAsk(agent: TaskAgent, task: AgentTask, dependencies: AgentRunnerDependencies): AskAgent {
  // A credential, credit or quota refusal fails every later step of this run the
  // same way, so once one is seen the run's remaining steps (a refresh sends many
  // review batches) report it without sending. The latch lives and dies with this
  // run: it is not stored, and the next run asks the provider afresh.
  let refused: ApiProviderError | null = null;
  return async (prompt, models, answerSchema) => {
    if (refused) throw refused;
    const resolution = resolveApiTarget();
    if (!resolution.target) {
      throw new Error(`The selected API provider cannot answer this step: ${resolution.reason}`);
    }
    try {
      return await askApiTarget(resolution.target, prompt, { model: models.api?.model, answerSchema });
    } catch (error) {
      if (error instanceof ApiProviderError && [401, 402, 403, 429].includes(error.status)) refused = error;
      throw error;
    }
  };
}

/**
 * Run the task on the first usable agent — the task's preferred agent when it names one and that agent
 * is usable, among the task's allowed agents — falling through to the next only
 * when a run fails, not when the agent's answer was refused, and never when the task stays on its first agent. Never throws. With no logged-in agent it returns
 * `waiting-for-agent` and runs nothing.
 */
const agentNames: Record<TaskAgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode', api: 'the selected API provider' };

export async function runAgentTask(task: AgentTask, overrides: Partial<AgentRunnerDependencies> = {}): Promise<AgentRunResult> {
  const autoApprovedFileTools = task.claudeCode.allowedTools.filter(tool => FILE_TOOLS.includes(tool));
  if (autoApprovedFileTools.length) throw new Error(`Agent task ${task.reason} auto-approves ${autoApprovedFileTools.join(', ')}, which would read anywhere on disk; name readableFolders instead.`);
  const dependencies = { ...defaultDependencies, ...overrides };
  if (task.allowedAgents?.length === 0) {
    return { state: 'waiting-for-agent', agent: null, result: null, error: WAITING_FOR_AGENT_REASON.noAgentAllowed, attempts: [] };
  }
  // The API agent is not a local CLI. Detecting one probes this machine's Claude Code, Codex and
  // Gemini installs, which an API-only task has no use for.
  const wantsApi = task.allowedAgents?.includes('api') ?? false;
  const localAllowed = task.allowedAgents ? task.allowedAgents.filter(agent => agent !== 'api') : undefined;
  const detected = localAllowed?.length === 0 ? [] : (await dependencies.detect())
    .filter(agent => agent.authenticated && agent.path)
    .filter(agent => !localAllowed || localAllowed.includes(agent.id));
  // The API provider is usable only when it is configured. When it is not, the agent is left out
  // entirely: the task waits for it, and it never falls back to a local CLI.
  const api = wantsApi ? resolveApiTarget() : null;
  const apiAgent: TaskAgent | null = api?.target
    ? { id: 'api', path: null, authenticated: true, reason: `${api.target.provider}: ${api.target.url}` }
    : null;
  const usable: TaskAgent[] = [...detected, ...(apiAgent ? [apiAgent] : [])];
  const ordered = task.preferredAgent
    ? [...usable.filter(agent => agent.id === task.preferredAgent), ...usable.filter(agent => agent.id !== task.preferredAgent)]
    : usable;
  if (!ordered.length) {
    const localNames = task.allowedAgents ? task.allowedAgents.filter(agent => agent !== 'api') : [];
    const error = api && !localNames.length
      ? `The selected API provider cannot run this task: ${api.reason}`
      : task.allowedAgents
        ? `None of the allowed agents (${task.allowedAgents.map(agent => agentNames[agent]).join(', ')}) is logged in on this computer.`
        : WAITING_FOR_AGENT_REASON.noLoggedInAgent;
    return { state: 'waiting-for-agent', agent: null, result: null, error, attempts: [] };
  }
  const attempts: AgentAttempt[] = [];
  try { await task.prepare?.(); }
  catch (error) {
    const message = describeError(error).slice(0, 500);
    logger.warn('WORKER', `Agent run (${task.reason}) could not prepare its input`, { error: message });
    return { state: 'failed', agent: null, result: null, error: `Preparing the run failed: ${message}`, attempts };
  }
  for (const agent of ordered) {
    logger.info('WORKER', `Agent run (${task.reason}) starting on ${agent.id}`);
    try {
      const ask = { 'claude-code': claudeCodeAsk, codex: codexAsk, gemini: geminiAsk, opencode: opencodeAsk, api: apiAsk }[agent.id](agent, task, dependencies);
      const result = await task.run(ask, agent.id);
      logger.info('WORKER', `Agent run (${task.reason}) finished on ${agent.id}`);
      return { state: 'ok', agent: agent.id, result: result.slice(0, 4000), error: null, attempts };
    } catch (error) {
      const message = describeError(error).slice(0, 500);
      logger.warn('WORKER', `Agent run (${task.reason}) failed on ${agent.id}`, { error: message });
      attempts.push({ agent: agent.id, error: message });
      if (isAnswerRefusal(error)) {
        logger.info('WORKER', `Agent run (${task.reason}) not handed to another agent: ${agent.id} answered, and its answer was refused`);
        break;
      }
      if (task.stayOnFirstUsableAgent) {
        logger.info('WORKER', `Agent run (${task.reason}) not handed to another agent: this task stays on ${agent.id}`);
        break;
      }
    }
  }
  const last = attempts[attempts.length - 1];
  // Every agent's failure, in the order tried: the last fallback's error alone hides why the first ones failed.
  const error = attempts.map(attempt => `${agentNames[attempt.agent]}: ${attempt.error}`).join(' · ');
  return { state: 'failed', agent: last.agent, result: null, error, attempts };
}
