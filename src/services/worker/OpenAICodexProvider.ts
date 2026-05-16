import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { completeSimple, getModels, type AssistantMessage, type Context, type Message, type Model, type OAuthCredentials } from '@earendil-works/pi-ai';
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  type WorkerRef
} from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

type CodexModel = Model<'openai-codex-responses'>;
type HeadersLike = Headers | { get(name: string): string | null };

interface CodexCompletionResult {
  content: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface CodexCliAuthStore {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    id_token?: string;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

interface CachedToken {
  access: string;
  expires: number;
}

const tokenCache = new Map<string, CachedToken>();
const tokenRefreshes = new Map<string, Promise<CachedToken>>();

export function getOpenAICodexSessionId(rawSessionId: string | number): string {
  const hash = createHash('sha256').update(String(rawSessionId)).digest('hex').slice(0, 48);
  return `claude-mem-${hash}`;
}

export function expandOpenAICodexPath(inputPath: string, homeDir = homedir()): string {
  if (inputPath === '~') return homeDir;
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

function parseJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function getCodexCliAuthPath(): string {
  const codexHome = process.env.CODEX_HOME
    ? expandOpenAICodexPath(process.env.CODEX_HOME)
    : join(homedir(), '.codex');
  return join(codexHome, 'auth.json');
}

function decodeJwtExpiryMs(token: string | undefined): number | undefined {
  if (!token) return undefined;

  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf-8');
    const json = JSON.parse(decoded) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function loadCodexCliAuthStore(authPath: string): { store: CodexCliAuthStore; credential: OAuthCredentials } | null {
  const store = parseJsonFile<CodexCliAuthStore>(authPath);
  const tokens = store?.tokens;
  if (!store || !tokens?.refresh_token) return null;

  const credential: OAuthCredentials = {
    access: tokens.access_token ?? '',
    refresh: tokens.refresh_token,
    expires: decodeJwtExpiryMs(tokens.access_token) ?? 0,
    accountId: tokens.account_id,
  };

  return { store, credential };
}

function saveCodexCliAuthStore(authPath: string, store: CodexCliAuthStore, updated: OAuthCredentials): void {
  const tokens = store.tokens;
  if (!tokens) return;

  store.tokens = {
    ...tokens,
    access_token: updated.access,
    refresh_token: updated.refresh,
    account_id: typeof updated.accountId === 'string' ? updated.accountId : tokens.account_id,
  };
  store.last_refresh = new Date().toISOString();
  writeFileSync(authPath, JSON.stringify(store, null, 2), 'utf-8');
}

function missingAuthMessage(): string {
  return 'OpenAI Codex OAuth profile not found. Run `codex login` to create a Codex CLI OAuth session.';
}

async function getAccessToken(): Promise<string> {
  const authPath = getCodexCliAuthPath();
  const cached = tokenCache.get(authPath);

  if (cached && Date.now() < cached.expires - TOKEN_REFRESH_BUFFER_MS) {
    return cached.access;
  }

  const auth = loadCodexCliAuthStore(authPath);
  if (!auth) {
    throw new ClassifiedProviderError(missingAuthMessage(), { kind: 'auth_invalid', cause: new Error('missing OpenAI Codex OAuth profile') });
  }

  const profile = auth.credential;
  if (profile.access && profile.expires && Date.now() < profile.expires - TOKEN_REFRESH_BUFFER_MS) {
    tokenCache.set(authPath, { access: profile.access, expires: profile.expires });
    return profile.access;
  }

  const pendingRefresh = tokenRefreshes.get(authPath);
  if (pendingRefresh) {
    return (await pendingRefresh).access;
  }

  const refreshPromise = (async (): Promise<CachedToken> => {
    logger.info('SDK', 'Refreshing OpenAI Codex OAuth token');
    let refreshed: OAuthCredentials;
    try {
      refreshed = await refreshCodexToken(profile.refresh);
    } catch (error) {
      throw new ClassifiedProviderError(
        'OpenAI Codex OAuth token refresh failed. Re-run `codex login` to refresh the Codex CLI OAuth session.',
        { kind: 'auth_invalid', cause: error },
      );
    }
    saveCodexCliAuthStore(authPath, auth.store, refreshed);
    const cachedToken = { access: refreshed.access, expires: refreshed.expires };
    tokenCache.set(authPath, cachedToken);
    return cachedToken;
  })();

  tokenRefreshes.set(authPath, refreshPromise);

  try {
    return (await refreshPromise).access;
  } finally {
    tokenRefreshes.delete(authPath);
  }
}

async function refreshCodexToken(refreshToken: string): Promise<OAuthCredentials> {
  const oauthPackage: string = '@earendil-works/pi-ai/oauth';
  const oauth = await import(oauthPackage) as {
    refreshOpenAICodexToken(token: string): Promise<OAuthCredentials>;
  };
  return oauth.refreshOpenAICodexToken(refreshToken);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getNumberField(record: Record<string, unknown> | null, ...fields: string[]): number | undefined {
  if (!record) return undefined;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function getStringField(record: Record<string, unknown> | null, ...fields: string[]): string | undefined {
  if (!record) return undefined;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function getHeadersField(record: Record<string, unknown> | null): HeadersLike | undefined {
  const headers = record?.headers;
  return headers && typeof (headers as HeadersLike).get === 'function' ? headers as HeadersLike : undefined;
}

function getErrorResponseRecord(error: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(error)?.response);
}

function classifyOpenAICodexException(error: unknown): ClassifiedProviderError {
  const errorRecord = asRecord(error);
  const responseRecord = getErrorResponseRecord(error);

  return classifyOpenAICodexError({
    status: getNumberField(errorRecord, 'status', 'statusCode') ?? getNumberField(responseRecord, 'status', 'statusCode'),
    bodyText: getStringField(errorRecord, 'bodyText', 'responseText', 'body') ?? getStringField(responseRecord, 'bodyText', 'responseText', 'body'),
    headers: getHeadersField(errorRecord) ?? getHeadersField(responseRecord),
    cause: error,
  });
}

export function classifyOpenAICodexError(input: {
  status?: number;
  bodyText?: string;
  headers?: HeadersLike;
  cause: unknown;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? (input.cause instanceof Error ? input.cause.message : String(input.cause));
  const lower = body.toLowerCase();
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;

  if (lower.includes('usage limit') || lower.includes('quota') || lower.includes('insufficient')) {
    return new ClassifiedProviderError(
      `OpenAI Codex quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429 || lower.includes('rate limit')) {
    return new ClassifiedProviderError(
      'OpenAI Codex rate limit',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (
    status === 401
    || status === 403
    || lower.includes('oauth')
    || lower.includes('access token')
    || lower.includes('refresh token')
    || lower.includes('authorization token')
    || lower.includes('bearer token')
  ) {
    return new ClassifiedProviderError(
      `OpenAI Codex auth error${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      `OpenAI Codex bad request (status ${status})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `OpenAI Codex upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  if (status === undefined) {
    return new ClassifiedProviderError(
      `OpenAI Codex error: ${body}`,
      { kind: lower.includes('aborted') ? 'aborted' : 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `OpenAI Codex API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

export class OpenAICodexProvider {
  constructor(
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
  ) {}

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const modelId = this.getModelId();

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `openai-codex-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenAICodex`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryCodex(session, modelId);
      await this.handleInitResponse(initResponse, session, worker, modelId);
    } catch (error: unknown) {
      logger.error('SDK', 'OpenAI Codex init failed', { sessionId: session.sessionDbId, model: modelId }, error instanceof Error ? error : new Error(String(error)));
      await this.handleSessionError(error, session);
      return;
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        lastCwd = await this.processOneMessage(session, message, lastCwd, worker, mode, modelId);
      }
    } catch (error: unknown) {
      logger.error('SDK', 'OpenAI Codex message processing failed', { sessionId: session.sessionDbId, model: modelId }, error instanceof Error ? error : new Error(String(error)));
      await this.handleSessionError(error, session);
      return;
    }

    logger.success('SDK', 'OpenAI Codex agent completed', {
      sessionId: session.sessionDbId,
      duration: `${((Date.now() - session.startTime) / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model: modelId,
    });
  }

  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type: 'observation' | 'summarize'; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    worker: WorkerRef | undefined,
    mode: ModeConfig,
    modelId: string,
  ): Promise<string | undefined> {
    session.pendingAgentId = message.agentId ?? null;
    session.pendingAgentType = message.agentType ?? null;
    if (message.cwd) lastCwd = message.cwd;
    const originalTimestamp = session.earliestPendingTimestamp;

    if (message.type === 'observation') {
      await this.processObservationMessage(session, message, originalTimestamp, lastCwd, worker, modelId);
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(session, message, originalTimestamp, lastCwd, worker, mode, modelId);
    }

    return lastCwd;
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    worker: WorkerRef | undefined,
    modelId: string,
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const observationPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd,
    });

    session.conversationHistory.push({ role: 'user', content: observationPrompt });
    const response = await this.queryCodex(session, modelId);
    const tokensUsed = this.recordAssistantResponse(response, session);

    await processAgentResponse(
      response.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'OpenAICodex', lastCwd, modelId
    );
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    worker: WorkerRef | undefined,
    mode: ModeConfig,
    modelId: string,
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || '',
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const response = await this.queryCodex(session, modelId);
    const tokensUsed = this.recordAssistantResponse(response, session);

    await processAgentResponse(
      response.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'OpenAICodex', lastCwd, modelId
    );
  }

  private async handleInitResponse(
    response: CodexCompletionResult,
    session: ActiveSession,
    worker: WorkerRef | undefined,
    modelId: string,
  ): Promise<void> {
    if (!response.content) {
      logger.error('SDK', 'Empty OpenAI Codex init response - session may lack context', {
        sessionId: session.sessionDbId,
        model: modelId,
      });
      return;
    }

    const tokensUsed = this.recordAssistantResponse(response, session);
    await processAgentResponse(
      response.content, session, this.dbManager, this.sessionManager,
      worker, tokensUsed, null, 'OpenAICodex', undefined, modelId
    );
  }

  private async handleSessionError(error: unknown, session: ActiveSession): Promise<never> {
    if (isAbortError(error)) {
      logger.warn('SDK', 'OpenAI Codex agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', 'OpenAI Codex agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private recordAssistantResponse(
    response: CodexCompletionResult,
    session: ActiveSession,
  ): number {
    if (!response.content) return 0;

    session.conversationHistory.push({ role: 'assistant', content: response.content });
    const tokensUsed = response.tokensUsed || 0;
    if (response.inputTokens !== undefined) {
      session.cumulativeInputTokens += response.inputTokens;
    }
    if (response.outputTokens !== undefined) {
      session.cumulativeOutputTokens += response.outputTokens;
    }
    return tokensUsed;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxMessages = parseInt(settings.CLAUDE_MEM_OPENAI_CODEX_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxTokens = parseInt(settings.CLAUDE_MEM_OPENAI_CODEX_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= maxMessages) {
      const totalTokens = history.reduce((sum, message) => sum + this.estimateTokens(message.content), 0);
      if (totalTokens <= maxTokens) return history;
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      const messageTokens = this.estimateTokens(message.content);

      if (truncated.length >= maxMessages || tokenCount + messageTokens > maxTokens) {
        logger.warn('SDK', 'OpenAI Codex context window truncated', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: maxTokens,
        });
        break;
      }

      truncated.unshift(message);
      tokenCount += messageTokens;
    }

    return truncated;
  }

  private conversationToContext(session: ActiveSession, modelId: string): Context {
    const timestamp = Date.now();
    const messages: Message[] = this.truncateHistory(session.conversationHistory).map(message => {
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: message.content }],
          api: 'openai-codex-responses',
          provider: 'openai-codex',
          model: modelId,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp,
        };
      }

      return {
        role: 'user',
        content: message.content,
        timestamp,
      };
    });

    return {
      messages,
    };
  }

  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return settings.CLAUDE_MEM_OPENAI_CODEX_MODEL || DEFAULT_MODEL;
  }

  private getModel(modelId: string): CodexModel {
    const model = getModels('openai-codex').find(candidate => candidate.id === modelId);
    if (!model) {
      throw new ClassifiedProviderError(
        `Unsupported OpenAI Codex model "${modelId}". Set CLAUDE_MEM_OPENAI_CODEX_MODEL to a model listed by @earendil-works/pi-ai for provider openai-codex.`,
        { kind: 'unrecoverable', cause: new Error(`unsupported OpenAI Codex model: ${modelId}`) },
      );
    }
    return model as CodexModel;
  }

  private async queryCodex(
    session: ActiveSession,
    modelId: string,
  ): Promise<CodexCompletionResult> {
    const model = this.getModel(modelId);
    const apiKey = await getAccessToken();
    const context = this.conversationToContext(session, modelId);

    logger.debug('SDK', `Querying OpenAI Codex (${modelId})`, {
      turns: context.messages.length,
    });

    let message: AssistantMessage;
    try {
      message = await completeSimple(model, context, {
        apiKey,
        reasoning: 'low',
        maxTokens: 4096,
        sessionId: getOpenAICodexSessionId(session.memorySessionId ?? session.sessionDbId),
        signal: session.abortController.signal,
        transport: 'auto',
      });
    } catch (error) {
      throw classifyOpenAICodexException(error);
    }

    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw classifyOpenAICodexError({
        cause: new Error(message.errorMessage || `OpenAI Codex stopped with ${message.stopReason}`),
      });
    }

    const content = this.extractTextContent(message);
    const usage = message.usage;
    const tokensUsed = usage?.totalTokens;

    if (tokensUsed) {
      logger.info('SDK', 'OpenAI Codex usage', {
        model: modelId,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: tokensUsed,
        messagesInContext: context.messages.length,
      });
    }

    return {
      content,
      tokensUsed,
      inputTokens: usage?.input,
      outputTokens: usage?.output,
    };
  }

  private extractTextContent(message: AssistantMessage): string {
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  }
}

export function isOpenAICodexAvailable(): boolean {
  return !!loadCodexCliAuthStore(getCodexCliAuthPath());
}

export function isOpenAICodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'openai-codex';
}
