
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef
} from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry } from './retry.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models';

/**
 * Parse Retry-After header (seconds or HTTP-date).
 * Returns ms or undefined.
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
 * Classify a Gemini fetch failure into ClassifiedProviderError. Called at
 * the boundary right after `fetch()` returns or throws. Provider-specific
 * because Gemini surfaces auth/quota/rate-limit signals via specific status
 * codes and body strings (e.g. "quota exceeded", "API key not valid").
 */
export function classifyGeminiError(input: {
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

  // Quota exceeded — by body marker — even on 500 (Gemini quirk).
  if (lower.includes('quota exceeded') || lower.includes('resource_exhausted')) {
    return new ClassifiedProviderError(
      `Gemini quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'Gemini rate limit (429)',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    // API_KEY_INVALID, PERMISSION_DENIED, etc.
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('api key expired')) {
      return new ClassifiedProviderError(
        `Gemini auth invalid (status ${status})`,
        { kind: 'auth_invalid', cause: input.cause },
      );
    }
    return new ClassifiedProviderError(
      `Gemini auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400) {
    return new ClassifiedProviderError(
      `Gemini bad request (status 400)`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `Gemini upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  // Network errors (no status) — treat as transient.
  if (status === undefined) {
    return new ClassifiedProviderError(
      `Gemini network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `Gemini API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

export type GeminiModel =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-3-flash'
  | 'gemini-3-flash-preview';

const GEMINI_RPM_LIMITS: Record<GeminiModel, number> = {
  'gemini-2.5-flash-lite': 10,
  'gemini-2.5-flash': 10,
  'gemini-2.5-pro': 5,
  'gemini-2.0-flash': 15,
  'gemini-2.0-flash-lite': 30,
  'gemini-3-flash': 10,
  'gemini-3-flash-preview': 5,
};

let lastRequestTime = 0;

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  

async function enforceRateLimitForModel(model: GeminiModel, rateLimitingEnabled: boolean): Promise<void> {
  if (!rateLimitingEnabled) {
    return;
  }

  const rpm = GEMINI_RPM_LIMITS[model] || 5;
  const minimumDelayMs = Math.ceil(60000 / rpm) + 100; 

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < minimumDelayMs) {
    const waitTime = minimumDelayMs - timeSinceLastRequest;
    logger.debug('SDK', `Rate limiting: waiting ${waitTime}ms before Gemini request`, { model, rpm });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export class GeminiProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const { apiKey, model, rateLimitingEnabled } = this.getGeminiConfig();

    if (!apiKey) {
      throw new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `gemini-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Gemini`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });
    let initResponse: { content: string; tokensUsed?: number };
    try {
      initResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Gemini init query failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Gemini init query failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleGeminiError(error, session, worker);
    }

    if (initResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: initResponse.content });
      const tokensUsed = initResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
      await processAgentResponse(initResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, null, 'Gemini', undefined, model);
    } else {
      logger.error('SDK', 'Empty Gemini init response - session may lack context', { sessionId: session.sessionDbId, model });
    }

    try {
      await this.processMessageLoop(session, worker, apiKey, model, rateLimitingEnabled, mode);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.error('SDK', 'Gemini message loop failed', { sessionId: session.sessionDbId, model }, error);
      } else {
        logger.error('SDK', 'Gemini message loop failed with non-Error', { sessionId: session.sessionDbId, model }, new Error(String(error)));
      }
      return this.handleGeminiError(error, session, worker);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Gemini agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length
    });
  }

  private async processMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    mode: ModeConfig
  ): Promise<void> {
    let lastCwd: string | undefined;

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.cwd) {
        lastCwd = message.cwd;
      }
      const originalTimestamp = session.earliestPendingTimestamp;

      if (message.type === 'observation') {
        await this.processObservationMessage(session, message, worker, apiKey, model, rateLimitingEnabled, originalTimestamp, lastCwd);
      } else if (message.type === 'summarize') {
        await this.processSummaryMessage(session, message, worker, apiKey, model, rateLimitingEnabled, mode, originalTimestamp, lastCwd);
      }
    }
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { type: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    worker: WorkerRef | undefined,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    originalTimestamp: number | null,
    lastCwd: string | undefined
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
    const obsResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

    let tokensUsed = 0;
    if (obsResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });
      tokensUsed = obsResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    if (obsResponse.content) {
      await processAgentResponse(obsResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'Gemini', lastCwd, model);
    } else {
      logger.warn('SDK', 'Empty Gemini observation response, leaving queue intact', {
        sessionId: session.sessionDbId
      });
    }
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { type: string; last_assistant_message?: string },
    worker: WorkerRef | undefined,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    mode: ModeConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
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
    const summaryResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

    let tokensUsed = 0;
    if (summaryResponse.content) {
      session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });
      tokensUsed = summaryResponse.tokensUsed || 0;
      session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
      session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    }

    if (summaryResponse.content) {
      await processAgentResponse(summaryResponse.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'Gemini', lastCwd, model);
    } else {
      logger.warn('SDK', 'Empty Gemini summary response, leaving queue intact', {
        sessionId: session.sessionDbId
      });
    }
  }

  private handleGeminiError(error: unknown, session: ActiveSession, _worker?: WorkerRef): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Gemini agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    logger.failure('SDK', 'Gemini agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_GEMINI_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = estimateTokens(msg.content);

      if (truncated.length > 0 && (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS)) {
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

  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean
  ): Promise<{ content: string; tokensUsed?: number }> {
    const truncatedHistory = this.truncateHistory(history);
    const contents = this.conversationToGeminiContents(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Gemini multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalTurns: history.length,
      totalChars
    });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    await enforceRateLimitForModel(model, rateLimitingEnabled);

    // Track request-id (best-effort dedup) across retries.
    let priorRequestId: string | null = null;

    const data = await withRetry<GeminiResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
          },
          body: JSON.stringify({
            contents,
            generationConfig: {
              temperature: 0.3,  // Lower temperature for structured extraction
              maxOutputTokens: 4096,
            },
          }),
          signal: attemptSignal,
        });
      } catch (networkError: unknown) {
        // Network failures, aborts, DNS, etc.
        throw classifyGeminiError({
          cause: networkError,
        });
      }

      const requestId = response.headers.get('x-goog-request-id') ?? response.headers.get('x-request-id');
      if (requestId) {
        priorRequestId = requestId;
      } else {
        logger.debug('SDK', 'Gemini response missing request-id header; retry dedup is best-effort');
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw classifyGeminiError({
          status: response.status,
          bodyText: errorBody,
          headers: response.headers,
          cause: new Error(`Gemini API error: ${response.status} - ${errorBody}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      return await response.json() as GeminiResponse;
    }, { label: `Gemini ${model}` });

    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error('SDK', 'Empty response from Gemini');
      return { content: '' };
    }

    const content = data.candidates[0].content.parts[0].text;
    const tokensUsed = data.usageMetadata?.totalTokenCount;

    return { content, tokensUsed };
  }

  private getGeminiConfig(): { apiKey: string; model: GeminiModel; rateLimitingEnabled: boolean } {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    const defaultModel: GeminiModel = 'gemini-2.5-flash';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;
    const validModels: GeminiModel[] = [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-3-flash',
      'gemini-3-flash-preview',
    ];

    let model: GeminiModel;
    if (validModels.includes(configuredModel as GeminiModel)) {
      model = configuredModel as GeminiModel;
    } else {
      logger.warn('SDK', `Invalid Gemini model "${configuredModel}", falling back to ${defaultModel}`, {
        configured: configuredModel,
        validModels,
      });
      model = defaultModel;
    }

    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';

    return { apiKey, model, rateLimitingEnabled };
  }
}

export function isGeminiAvailable(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY'));
}

export function isGeminiSelected(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}
