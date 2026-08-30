import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { buildObservationPrompt, type Observation, type ObservationPromptOptions } from '../../sdk/prompts.js';
import type { ActiveSession, ConversationMessage, PendingMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry } from './retry.js';
import {
  CodexAppServerClient,
  buildCodexAppServerEnv,
  type CodexAppServerTurnResult,
} from './CodexAppServerClient.js';

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';

const DEFAULT_CODEX_PATH = 'codex';
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_OBSERVATIONS_PER_PROMPT = 6;
const MAX_OBSERVATIONS_PER_PROMPT_LIMIT = 50;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const WINDOWS_SHELL_META_RE = /[\0\r\n&|<>()^%!"]/;
const CODEX_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const CODEX_REASONING_EFFORTS = new Set<string>(CODEX_REASONING_EFFORT_VALUES);
const CODEX_OBSERVATION_PROMPT_OPTIONS: ObservationPromptOptions = {
  maxObservations: 1,
  requireNarrative: true,
  extraOutputRules: [
    'Usually emit zero observations. Emit one only when this tool use changes a durable conclusion future sessions should remember.',
    'Do not create observations for routine probes, clean status checks, queue depth checks, command availability checks, formatting/lint pass confirmations, or repeated verification of a fact already captured in the recent conversation.',
    'Never emit facts-only observations. If there is no substantive narrative sentence explaining why the fact matters, return an empty response.',
    'Emit at most one observation for the whole tool use, even when the output contains multiple files, lines, checks, or findings; merge related facts under that one durable conclusion.',
    'Do not split a single command output, diff, status report, review, or document inspection into one observation per line, file, or finding; merge related facts under one title.',
    'Keep exact commands, file paths, IDs, counts, dates, and source-specific evidence in <facts>, but group related facts into the same observation.',
    'If the tool output only confirms a transient status, queue depth, formatting check, or no-op probe, return an empty response unless it changes the durable conclusion for future work.',
    'Never create near-duplicate observations that differ only by wording or by one overlapping fact.',
  ],
};

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
  maxObservationsPerPrompt: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = parsePositiveInt(value, fallback);
  return Math.min(parsed, max);
}

export function parseCodexReasoningEffort(value: string | undefined): CodexReasoningEffort | null {
  const normalized = (value ?? '').trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(normalized)
    ? normalized as CodexReasoningEffort
    : null;
}

export function buildCodexExecEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildCodexAppServerEnv(env);
}

export function normalizeCodexExecutablePath(codexPath: string | undefined, platform = process.platform): string {
  const normalized = (codexPath ?? '').trim() || DEFAULT_CODEX_PATH;
  if (platform === 'win32' && WINDOWS_SHELL_META_RE.test(normalized)) {
    throw new Error('CLAUDE_MEM_CODEX_PATH contains characters that are unsafe for Windows shell execution');
  }
  return normalized;
}

function truncateForMessage(value: string, max = 500): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

export function buildCodexObservationPrompt(obs: Observation): string {
  return buildObservationPrompt(obs, CODEX_OBSERVATION_PROMPT_OPTIONS);
}

const OBSERVATION_BLOCK_RE = /<observation\b[^>]*>[\s\S]*?<\/observation>/gi;

function extractXmlField(block: string, field: string): string | null {
  const match = new RegExp(`<${field}\\b[^>]*>([\\s\\S]*?)</${field}>`, 'i').exec(block);
  if (!match) return null;
  const value = match[1]
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return value.length > 0 ? value : null;
}

export function sanitizeCodexObservationResponse(content: string): string {
  const blocks = content.match(OBSERVATION_BLOCK_RE);
  if (!blocks) return content;

  const firstSubstantiveBlock = blocks.find(block =>
    extractXmlField(block, 'title') && extractXmlField(block, 'narrative')
  );
  return firstSubstantiveBlock?.trim() ?? '';
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
  const summary = truncateForMessage(stderr || causeMessage || 'Codex app-server failed');

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

  return new ClassifiedProviderError(`Codex app-server failed${input.exitCode !== undefined ? ` (code ${input.exitCode})` : ''}: ${summary}`, {
    kind: 'transient',
    cause: input.cause,
  });
}

export class CodexProvider extends OpenAICompatibleProvider<CodexConfig> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly forwardEmptyMessageResponse = true;
  private readonly appServer = new CodexAppServerClient();

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  async close(): Promise<void> {
    await this.appServer.close();
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
      maxObservationsPerPrompt: parseBoundedPositiveInt(
        settings.CLAUDE_MEM_CODEX_MAX_OBSERVATIONS_PER_PROMPT,
        DEFAULT_MAX_OBSERVATIONS_PER_PROMPT,
        MAX_OBSERVATIONS_PER_PROMPT_LIMIT
      ),
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

  protected buildObservationPrompt(obs: Observation, _config: CodexConfig): string {
    return buildCodexObservationPrompt(obs);
  }

  protected sanitizeObservationResponseContent(content: string, _config: CodexConfig): string {
    return sanitizeCodexObservationResponse(content);
  }

  protected async shouldProcessObservationMessage(
    session: ActiveSession,
    _message: PendingMessage,
    config: CodexConfig
  ): Promise<boolean> {
    if (!session.memorySessionId) return true;

    const existingCount = this.dbManager
      .getSessionStore()
      .countObservationsForPrompt(session.memorySessionId, session.lastPromptNumber);

    if (existingCount < config.maxObservationsPerPrompt) {
      return true;
    }

    logger.info('SDK', 'Codex observation prompt budget exhausted; confirming tool message without compression', {
      sessionId: session.sessionDbId,
      memorySessionId: session.memorySessionId,
      promptNumber: session.lastPromptNumber,
      existingCount,
      maxObservationsPerPrompt: config.maxObservationsPerPrompt,
    });
    return false;
  }

  protected async query(
    history: ConversationMessage[],
    config: CodexConfig,
    abortSignal?: AbortSignal,
  ): Promise<ProviderQueryResult> {
    return withRetry(
      attemptSignal => this.queryCodexAppServer(history, config, attemptSignal),
      {
        label: `Codex ${config.model}`,
        maxRetries: 1,
        perAttemptTimeoutMs: config.timeoutMs,
        abortSignal,
      },
    );
  }

  private truncateHistoryForCodex(history: ConversationMessage[], config: CodexConfig): ConversationMessage[] {
    if (history.length <= config.maxContextMessages) {
      const totalTokens = history.reduce((sum, message) => sum + this.estimateTokens(message.content), 0);
      if (totalTokens <= config.maxEstimatedTokens) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      const messageTokens = this.estimateTokens(message.content);
      const overLimit = truncated.length >= config.maxContextMessages || tokenCount + messageTokens > config.maxEstimatedTokens;

      if (overLimit) {
        const keepOversizedLatestMessage = truncated.length === 0 && i === history.length - 1;
        if (keepOversizedLatestMessage) {
          truncated.unshift(message);
          tokenCount += messageTokens;
        }

        logger.warn('SDK', 'Codex context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: keepOversizedLatestMessage ? i : i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: config.maxEstimatedTokens,
        });
        break;
      }

      truncated.unshift(message);
      tokenCount += messageTokens;
    }

    return truncated;
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

  private async queryCodexAppServer(
    history: ConversationMessage[],
    config: CodexConfig,
    attemptSignal: AbortSignal,
  ): Promise<ProviderQueryResult> {
    const prompt = this.formatPrompt(history, config);

    logger.debug('SDK', `Querying Codex app-server (${config.model})`, {
      turns: history.length,
      promptChars: prompt.length,
      codexPath: config.codexPath,
      reasoningEffort: config.reasoningEffort ?? 'default',
    });

    try {
      const result: CodexAppServerTurnResult = await this.appServer.runTurn({
        codexPath: config.codexPath,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        prompt,
        timeoutMs: config.timeoutMs,
        signal: attemptSignal,
      });
      if (result.tokensUsed !== undefined) {
        logger.info('SDK', 'Codex app-server usage', {
          model: config.model,
          inputTokens: result.inputTokens ?? 0,
          outputTokens: result.outputTokens ?? 0,
          totalTokens: result.tokensUsed,
        });
      }
      return result;
    } catch (cause) {
      throw classifyCodexExecError({ cause });
    }
  }
}

export function isCodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'codex';
}
