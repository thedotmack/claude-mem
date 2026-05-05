
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
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
import { withRetry } from './retry.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Parse Retry-After header (seconds or HTTP-date). Returns ms or undefined.
 */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Classify an OpenRouter fetch failure into ClassifiedProviderError. Called
 * at the boundary right after `fetch()` returns or throws.
 */
export function classifyOpenRouterError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const headers = input.headers;
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;

  // Quota / insufficient credits — body marker takes precedence over status.
  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota')
  ) {
    return new ClassifiedProviderError(
      `OpenRouter quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'OpenRouter rate limit (429)',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      `OpenRouter auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      `OpenRouter bad request (status ${status})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `OpenRouter upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  // Network errors (no status) — treat as transient.
  if (status === undefined) {
    return new ClassifiedProviderError(
      `OpenRouter network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `OpenRouter API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  
const CHARS_PER_TOKEN_ESTIMATE = 4;  

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export class OpenRouterProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const { apiKey, model, siteUrl, appName } = this.getOpenRouterConfig();

    if (!apiKey) {
      throw new Error('OpenRouter API key not configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `openrouter-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenRouter`);
    }

    const mode = ModeManager.getInstance().getActiveMode();

    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);
      await this.handleInitResponse(initResponse, session, worker, model);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'OpenRouter init failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'OpenRouter init failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        lastCwd = await this.processOneMessage(session, message, lastCwd, apiKey, model, siteUrl, appName, worker, mode);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'OpenRouter message processing failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'OpenRouter message processing failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      await this.handleSessionError(error, session, worker);
      return;
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'OpenRouter agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model
    });
  }

  private prepareMessageMetadata(session: ActiveSession, message: { agentId?: string | null; agentType?: string | null }): void {
    session.pendingAgentId = message.agentId ?? null;
    session.pendingAgentType = message.agentType ?? null;
  }

  private async handleInitResponse(
    initResponse: { content: string; tokensUsed?: number },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    model: string
  ): Promise<void> {
    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

      await processAgentResponse(
        initResponse.content, session, this.dbManager, this.sessionManager,
        worker, tokensUsed, null, 'OpenRouter', undefined, model
      );
    } else {
      logger.error('SDK', 'Empty OpenRouter init response - session may lack context', {
        sessionId: session.sessionDbId, model
      });
    }
  }

  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type: 'observation' | 'summarize'; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    siteUrl: string | undefined,
    appName: string | undefined,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<string | undefined> {
    this.prepareMessageMetadata(session, message);

    if (message.cwd) {
      lastCwd = message.cwd;
    }
    const originalTimestamp = session.earliestPendingTimestamp;

    if (message.type === 'observation') {
      await this.processObservationMessage(
        session, message, originalTimestamp, lastCwd,
        apiKey, model, siteUrl, appName, worker, mode
      );
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(
        session, message, originalTimestamp, lastCwd,
        apiKey, model, siteUrl, appName, worker, mode
      );
    }

    return lastCwd;
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    siteUrl: string | undefined,
    appName: string | undefined,
    worker: WorkerRef | undefined,
    _mode: ModeConfig
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    const obsResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      obsResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'OpenRouter', lastCwd, model
    );
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    siteUrl: string | undefined,
    appName: string | undefined,
    worker: WorkerRef | undefined,
    mode: ModeConfig
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || ''
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    const summaryResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    await processAgentResponse(
      summaryResponse.content || '', session, this.dbManager, this.sessionManager,
      worker, tokensUsed, originalTimestamp, 'OpenRouter', lastCwd, model
    );
  }

  private async handleSessionError(error: unknown, session: ActiveSession, _worker?: WorkerRef): Promise<never> {
    if (isAbortError(error)) {
      logger.warn('SDK', 'OpenRouter agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', 'OpenRouter agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  
      tokenCount += msgTokens;
    }

    return truncated;
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    siteUrl?: string,
    appName?: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OpenRouter multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens
    });

    let priorRequestId: string | null = null;

    const data = await withRetry<OpenRouterResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': siteUrl || 'https://github.com/thedotmack/claude-mem',
            'X-Title': appName || 'claude-mem',
            'Content-Type': 'application/json',
            ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.3,  // Lower temperature for structured extraction
            max_tokens: 4096,
          }),
          signal: attemptSignal,
        });
      } catch (networkError: unknown) {
        throw classifyOpenRouterError({ cause: networkError });
      }

      const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-openrouter-request-id');
      if (requestId) {
        priorRequestId = requestId;
      } else {
        logger.debug('SDK', 'OpenRouter response missing request-id header; retry dedup is best-effort');
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw classifyOpenRouterError({
          status: response.status,
          bodyText: errorText,
          headers: response.headers,
          cause: new Error(`OpenRouter API error: ${response.status} - ${errorText}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      const responseData = await response.json() as OpenRouterResponse;

      if (responseData.error) {
        // Per OpenRouter spec, errors can come in 200 responses too.
        throw classifyOpenRouterError({
          status: response.status,
          bodyText: `${responseData.error.code} ${responseData.error.message ?? ''}`,
          headers: response.headers,
          cause: new Error(`OpenRouter API error: ${responseData.error.code} - ${responseData.error.message}`),
        });
      }

      return responseData;
    }, { label: `OpenRouter ${model}` });

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from OpenRouter');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;

    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      const estimatedCost = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', 'OpenRouter API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        estimatedCostUSD: estimatedCost.toFixed(4),
        messagesInContext: truncatedHistory.length
      });

      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          estimatedCost: estimatedCost.toFixed(4)
        });
      }
    }

    return { content, tokensUsed };
  }

  private getOpenRouterConfig(): { apiKey: string; model: string; siteUrl?: string; appName?: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '';

    const model = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';

    const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem';

    return { apiKey, model, siteUrl, appName };
  }
}

export function isOpenRouterAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY'));
}

export function isOpenRouterSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openrouter';
}
