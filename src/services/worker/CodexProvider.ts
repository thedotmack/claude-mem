import { spawnHidden } from '../../shared/spawn.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry } from './retry.js';
import { chmodSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex-spark';

const DEFAULT_CODEX_PATH = 'codex';
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const DEFAULT_TIMEOUT_MS = 120000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const CODEX_EXEC_WORKDIR_PREFIX = 'claude-mem-codex-';
const WINDOWS_SHELL_META_RE = /[\0\r\n&|<>()^%!"]/;
const CODEX_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const CODEX_REASONING_EFFORTS = new Set<string>(CODEX_REASONING_EFFORT_VALUES);
const CODEX_EXEC_ENV_ALLOWLIST = new Set([
  'APPDATA',
  'CODEX_HOME',
  'COLORTERM',
  'ComSpec',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'PWD',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'USERNAME',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORT_VALUES[number];

interface CodexConfig {
  /** Synthetic value: Codex CLI auth lives in CODEX_HOME / `codex login`. */
  apiKey: string;
  model: string;
  codexPath: string;
  reasoningEffort: CodexReasoningEffort | null;
  maxContextMessages: number;
  maxEstimatedTokens: number;
  timeoutMs: number;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseCodexReasoningEffort(value: string | undefined): CodexReasoningEffort | null {
  const normalized = (value ?? '').trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(normalized)
    ? normalized as CodexReasoningEffort
    : null;
}

export function buildCodexExecArgs(config: {
  model: string;
  reasoningEffort: CodexReasoningEffort | null;
}, workDir: string): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--model',
    config.model,
  ];

  if (config.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${config.reasoningEffort}"`);
  }

  args.push(
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--cd',
    workDir,
    '-',
  );

  return args;
}

export function buildCodexExecEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const codexEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CODEX_EXEC_ENV_ALLOWLIST.has(key) || key.startsWith('LC_')) {
      codexEnv[key] = value;
    }
  }

  return codexEnv;
}

export function normalizeCodexExecutablePath(codexPath: string | undefined, platform = process.platform): string {
  const normalized = (codexPath ?? '').trim() || DEFAULT_CODEX_PATH;
  if (platform === 'win32' && WINDOWS_SHELL_META_RE.test(normalized)) {
    throw new Error('CLAUDE_MEM_CODEX_PATH contains characters that are unsafe for Windows shell execution');
  }
  return normalized;
}

export function createCodexExecWorkDir(): string {
  const workDir = mkdtempSync(join(tmpdir(), CODEX_EXEC_WORKDIR_PREFIX));
  if (process.platform !== 'win32') {
    chmodSync(workDir, 0o700);
  }
  return workDir;
}

function removeCodexExecWorkDir(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true });
}

function truncateForMessage(value: string, max = 500): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const parts = content.flatMap(part => {
    if (typeof part === 'string') return [part];
    if (!part || typeof part !== 'object') return [];

    const candidate = part as { text?: unknown; content?: unknown };
    if (typeof candidate.text === 'string') return [candidate.text];
    if (typeof candidate.content === 'string') return [candidate.content];
    return [];
  });

  return parts.length > 0 ? parts.join('\n') : undefined;
}

function extractAgentMessageText(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;

  const candidate = item as {
    type?: unknown;
    role?: unknown;
    text?: unknown;
    content?: unknown;
    message?: unknown;
  };

  const isAgentMessage =
    candidate.type === 'agent_message' ||
    (candidate.type === 'message' && candidate.role === 'assistant') ||
    candidate.role === 'assistant';

  if (!isAgentMessage) return undefined;
  if (typeof candidate.text === 'string') return candidate.text;

  const contentText = extractTextFromContent(candidate.content);
  if (contentText !== undefined) return contentText;

  if (candidate.message && typeof candidate.message === 'object') {
    const nested = candidate.message as { text?: unknown; content?: unknown };
    if (typeof nested.text === 'string') return nested.text;
    return extractTextFromContent(nested.content);
  }

  return undefined;
}

export function parseCodexExecJsonl(stdout: string): ProviderQueryResult {
  let content = '';
  let latestUsage: CodexUsage | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!event || typeof event !== 'object') continue;
    const typedEvent = event as { type?: unknown; item?: unknown; usage?: unknown };

    if (typedEvent.type === 'item.completed') {
      const text = extractAgentMessageText(typedEvent.item);
      if (text !== undefined) {
        content = text;
      }
    }

    if (typedEvent.type === 'turn.completed' && typedEvent.usage && typeof typedEvent.usage === 'object') {
      latestUsage = typedEvent.usage as CodexUsage;
    }
  }

  const inputTokens =
    latestUsage
      ? (latestUsage.input_tokens ?? 0) + (latestUsage.cached_input_tokens ?? 0)
      : undefined;
  const outputTokens =
    latestUsage
      ? (latestUsage.output_tokens ?? 0) + (latestUsage.reasoning_output_tokens ?? 0)
      : undefined;
  const tokensUsed =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;

  return {
    content: content.trim(),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

export function classifyCodexExecError(input: {
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  stderr?: string;
  cause: unknown;
}): ClassifiedProviderError {
  const causeMessage = input.cause instanceof Error ? input.cause.message : String(input.cause);
  const stderr = input.stderr ?? '';
  const combined = `${causeMessage}\n${stderr}`;
  const lower = combined.toLowerCase();
  const causeCode = (input.cause as { code?: unknown })?.code;
  const summary = truncateForMessage(stderr || causeMessage || 'Codex exec failed');

  if (
    causeCode === 'ENOENT' ||
    lower.includes('enoent') ||
    lower.includes('command not found') ||
    lower.includes('no such file or directory') ||
    lower.includes('codex executable not found')
  ) {
    return new ClassifiedProviderError(
      `Codex CLI executable not found. Install Codex CLI on PATH or set CLAUDE_MEM_CODEX_PATH: ${summary}`,
      {
        kind: 'unrecoverable',
        cause: input.cause,
      },
    );
  }

  if (
    lower.includes('not logged in') ||
    lower.includes('codex login') ||
    lower.includes('unauthorized') ||
    lower.includes('authentication') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    return new ClassifiedProviderError(`Codex authentication failed: ${summary}`, {
      kind: 'auth_invalid',
      cause: input.cause,
    });
  }

  if (
    lower.includes('usage limit') ||
    lower.includes('quota') ||
    lower.includes('insufficient credits') ||
    lower.includes('plan limit') ||
    lower.includes('billing')
  ) {
    return new ClassifiedProviderError(`Codex quota exhausted: ${summary}`, {
      kind: 'quota_exhausted',
      cause: input.cause,
    });
  }

  if (lower.includes('rate limit') || lower.includes('429')) {
    return new ClassifiedProviderError(`Codex rate limited: ${summary}`, {
      kind: 'rate_limit',
      cause: input.cause,
    });
  }

  if (
    lower.includes('context length') ||
    lower.includes('context window') ||
    lower.includes('prompt is too long') ||
    lower.includes('prompt too long')
  ) {
    return new ClassifiedProviderError(`Codex prompt too long: ${summary}`, {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  return new ClassifiedProviderError(`Codex exec failed${input.exitCode !== undefined ? ` (code ${input.exitCode})` : ''}: ${summary}`, {
    kind: 'transient',
    cause: input.cause,
  });
}

export class CodexProvider extends OpenAICompatibleProvider<CodexConfig> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly requireNonEmptyToTruncate = false;
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const model = (settings.CLAUDE_MEM_CODEX_MODEL || DEFAULT_CODEX_MODEL).trim() || DEFAULT_CODEX_MODEL;
    const codexPath = normalizeCodexExecutablePath(settings.CLAUDE_MEM_CODEX_PATH || process.env.CODEX_PATH);

    return {
      apiKey: 'codex-cli-auth',
      model,
      codexPath,
      reasoningEffort: parseCodexReasoningEffort(settings.CLAUDE_MEM_CODEX_REASONING_EFFORT),
      maxContextMessages: parsePositiveInt(settings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES, DEFAULT_MAX_CONTEXT_MESSAGES),
      maxEstimatedTokens: parsePositiveInt(settings.CLAUDE_MEM_CODEX_MAX_TOKENS, DEFAULT_MAX_ESTIMATED_TOKENS),
      timeoutMs: parsePositiveInt(settings.CLAUDE_MEM_CODEX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    };
  }

  protected missingApiKeyError(): Error {
    return new Error('Codex CLI authentication is not available. Run `codex login`, then set CLAUDE_MEM_PROVIDER=codex.');
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') {
      return null;
    }
    return {
      input: result.inputTokens,
      output: result.outputTokens,
    };
  }

  protected async query(history: ConversationMessage[], config: CodexConfig): Promise<ProviderQueryResult> {
    return withRetry(
      attemptSignal => this.queryCodexExec(history, config, attemptSignal),
      {
        label: `Codex ${config.model}`,
        maxRetries: 1,
        perAttemptTimeoutMs: config.timeoutMs,
      },
    );
  }

  private truncateHistoryForCodex(history: ConversationMessage[], config: CodexConfig): ConversationMessage[] {
    return this.truncateHistory(history, config.maxContextMessages, config.maxEstimatedTokens);
  }

  private formatPrompt(history: ConversationMessage[], config: CodexConfig): string {
    const truncatedHistory = this.truncateHistoryForCodex(history, config);
    const conversation = truncatedHistory
      .map((message, index) => `--- ${index + 1}. ${message.role.toUpperCase()} ---\n${message.content}`)
      .join('\n\n');

    return [
      'You are the claude-mem memory compression worker.',
      'Use only the conversation text below. Do not inspect files, run shell commands, call tools, or use web search.',
      'Return only the XML requested by the latest user prompt. Do not add Markdown fences or explanation.',
      '',
      conversation,
    ].join('\n');
  }

  private async queryCodexExec(
    history: ConversationMessage[],
    config: CodexConfig,
    attemptSignal: AbortSignal,
  ): Promise<ProviderQueryResult> {
    const prompt = this.formatPrompt(history, config);
    const workDir = createCodexExecWorkDir();
    const args = buildCodexExecArgs(config, workDir);

    logger.debug('SDK', `Querying Codex exec (${config.model})`, {
      turns: history.length,
      promptChars: prompt.length,
      codexPath: config.codexPath,
      reasoningEffort: config.reasoningEffort ?? 'default',
      workDir,
    });

    return new Promise<ProviderQueryResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const child = spawnHidden(config.codexPath, args, {
        cwd: workDir,
        env: buildCodexExecEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      const cleanupWorkDir = (): void => {
        try {
          removeCodexExecWorkDir(workDir);
        } catch (error: unknown) {
          logger.warn('SDK', 'Failed to remove Codex exec workdir', {
            workDir,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const settleReject = (error: ClassifiedProviderError): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const onAbort = (): void => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Process may already be gone.
        }
      };
      attemptSignal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr?.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));

      child.on('error', cause => {
        attemptSignal.removeEventListener('abort', onAbort);
        cleanupWorkDir();
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        settleReject(classifyCodexExecError({ stderr, cause }));
      });

      child.on('close', (exitCode, signal) => {
        attemptSignal.removeEventListener('abort', onAbort);
        cleanupWorkDir();
        if (settled) return;
        settled = true;

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (attemptSignal.aborted) {
          reject(classifyCodexExecError({
            exitCode,
            signal,
            stderr: stderr || `Codex exec timed out after ${config.timeoutMs}ms`,
            cause: new Error('Codex exec timed out'),
          }));
          return;
        }

        if (exitCode !== 0) {
          reject(classifyCodexExecError({
            exitCode,
            signal,
            stderr,
            cause: new Error(`Codex exec exited with code ${exitCode}${signal ? ` signal ${signal}` : ''}`),
          }));
          return;
        }

        const result = parseCodexExecJsonl(stdout);
        if (result.tokensUsed !== undefined) {
          logger.info('SDK', 'Codex CLI usage', {
            model: config.model,
            inputTokens: result.inputTokens ?? 0,
            outputTokens: result.outputTokens ?? 0,
            totalTokens: result.tokensUsed,
          });
        }
        resolve(result);
      });

      child.stdin?.end(prompt);
    });
  }
}

export function isCodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'codex';
}
