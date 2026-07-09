
import { getCredential } from '../../shared/EnvManager.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import {
  buildOpenRouterRequestBody,
  parseOpenRouterExtraBody,
  parseOpenRouterReasoningEffort,
  type OpenRouterReasoningEffort,
} from '../../shared/openrouter-request-settings.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry } from './retry.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import { truncateConversationHistory } from './truncate-history.js';

/**
 * OpenAI-compatible client configuration.
 *
 * The endpoint is resolved from CLAUDE_MEM_OPENROUTER_BASE_URL (settings or env;
 * env var OPENROUTER_BASE_URL also honored). When unset, requests go to the
 * default OpenRouter URL — behavior unchanged. When set to an OpenAI-compatible
 * base (DeepSeek, LM Studio, a custom gateway, etc.), the provider POSTs to
 * `<base>/chat/completions`. The model is taken verbatim from
 * CLAUDE_MEM_OPENROUTER_MODEL. See src/shared/openrouter-base-url.ts for the
 * resolution rules and per-provider config examples (#2382/#2590/#2622/#2393).
 */

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


// ✅ ADDED: OpenRouter reasoning control
const VALID_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
] as const;

type ReasoningEffort = typeof VALID_REASONING_EFFORTS[number];


// ✅ ADDED: Reads CLAUDE_MEM_OPENROUTER_REASONING_EFFORT setting
function getReasoningEffort(): ReasoningEffort | undefined {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  const value = settings.CLAUDE_MEM_OPENROUTER_REASONING_EFFORT;

  if (
    typeof value === 'string' &&
    VALID_REASONING_EFFORTS.includes(value as ReasoningEffort)
  ) {
    return value as ReasoningEffort;
  }

  return undefined;
}
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenRouterResponse {
  /** The model that actually served the request — not the configured string. */
  model?: string;
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
    /** Credits charged by openrouter.ai (~USD). With BYOK this is only the fee. */
    cost?: number;
    cost_details?: {
      /** What the upstream provider charged when using BYOK. */
      upstream_inference_cost?: number;
    };
  };
  error?: {
    message?: string;
    code?: string;
  };
}

interface OpenRouterConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
  siteUrl?: string;
  appName?: string;
  extraBody?: Record<string, unknown>;
}

export class OpenRouterProvider extends OpenAICompatibleProvider<OpenRouterConfig> {
  protected readonly providerName = 'OpenRouter';
  protected readonly syntheticIdPrefix = 'openrouter';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OpenRouterConfig {
    return this.getOpenRouterConfig();
  }

  protected missingApiKeyError(): Error {
    return new Error('OpenRouter API key not configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
  }

  protected prepareSessionExtras(session: ActiveSession, config: OpenRouterConfig): void {
    // openrouter.ai responses carry real usage/cost; custom OpenAI-compatible
    // gateways often fabricate or omit usage — let telemetry segment the two.
    session.endpointClass = config.apiUrl.includes('openrouter.ai') ? 'openrouter' : 'custom';
  }

  private async processOneMessage(
    session: ActiveSession,
    message: { _persistentId: number; agentId?: string | null; agentType?: string | null; type: 'observation' | 'summarize'; cwd?: string; prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; last_assistant_message?: string },
    lastCwd: string | undefined,
    apiKey: string,
    model: string,
    apiUrl: string,
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
        apiKey, model, apiUrl, siteUrl, appName, worker, mode
      );
    } else if (message.type === 'summarize') {
      await this.processSummaryMessage(
        session, message, originalTimestamp, lastCwd,
        apiKey, model, apiUrl, siteUrl, appName, worker, mode
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
    apiUrl: string,
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
    const obsResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, apiUrl, siteUrl, appName);

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
    apiUrl: string,
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
    const summaryResponse = await this.queryOpenRouterMultiTurn(session.conversationHistory, apiKey, model, apiUrl, siteUrl, appName);

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

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;
    return truncateConversationHistory(history, {
      maxContextMessages: MAX_CONTEXT_MESSAGES,
      maxEstimatedTokens: MAX_ESTIMATED_TOKENS,
    });
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  protected async query(history: ConversationMessage[], config: OpenRouterConfig): Promise<ProviderQueryResult> {
    return this.queryOpenRouterMultiTurn(history, config.apiKey, config.model, config.apiUrl, config.siteUrl, config.appName, config.extraBody);
  }

  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    apiUrl: string,
    siteUrl?: string,
    appName?: string,
    extraBody?: Record<string, unknown>,
  ): Promise<ProviderQueryResult> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxContextMessages = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxEstimatedTokens = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS;
    const truncatedHistory = truncateConversationHistory(history, {
      maxContextMessages,
      maxEstimatedTokens,
      estimateTokens: (text) => this.estimateTokens(text ?? ''),
    });
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OpenRouter multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens
    });

    let priorRequestId: string | null = null;

    const data = await withRetry<OpenRouterResponse>(async (attemptSignal) => {
      let response: Response;

      try {
        response = await fetch(apiUrl, {
          method: 'POST',

          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': siteUrl || 'https://github.com/thedotmack/claude-mem',
            'X-Title': appName || 'claude-mem',
            'Content-Type': 'application/json',

            ...(priorRequestId
              ? { 'x-claude-mem-prior-request-id': priorRequestId }
              : {}),
          },

          body: JSON.stringify({
            model,
            messages,

            temperature: 0.3,

            max_tokens: 4096,
            // Ask openrouter.ai for usage accounting (token counts + cost).
            // Only sent to openrouter.ai — strict custom gateways may reject
            // unknown body fields.
            ...(apiUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
            // User-defined extra body parameters merged last so they can
            // override any of the above. Used for provider-specific params
            // like thinking control (e.g. {"thinking":{"type":"disabled"}}).
            ...(extraBody ?? {}),
          }),

          signal: attemptSignal,
        });
      } catch (networkError: unknown) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyOpenRouterError({ cause: err });
      }

      const requestId =
        response.headers.get('x-request-id') ??
        response.headers.get('x-openrouter-request-id');

      if (requestId) {
        priorRequestId = requestId;
      } else {
        logger.debug(
          'SDK',
          'OpenRouter response missing request-id header; retry dedup is best-effort'
        );
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
          cause: new Error(
            `OpenRouter API error: ${responseData.error.code} - ${responseData.error.message}`
          ),
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
    const realInputTokens = data.usage?.prompt_tokens;
    const realOutputTokens = data.usage?.completion_tokens;

    // usage.cost is what openrouter.ai charged in credits (~USD);
    // with BYOK the model spend is reported separately as upstream_inference_cost.
    // Custom gateways usually omit both — costUsd stays undefined.
    const orCost =
      typeof data.usage?.cost === 'number'
        ? data.usage.cost
        : undefined;

    const upstreamCost =
      typeof data.usage?.cost_details?.upstream_inference_cost === 'number'
        ? data.usage.cost_details.upstream_inference_cost
        : undefined;

    const costUsd =
      orCost !== undefined || upstreamCost !== undefined
        ? (orCost ?? 0) + (upstreamCost ?? 0)
        : undefined;

    const servedModel =
      typeof data.model === 'string' && data.model
        ? data.model
        : undefined;

    if (tokensUsed) {
      logger.info('SDK', 'OpenRouter API usage', {
        model: servedModel ?? model,
        inputTokens: realInputTokens || 0,
        outputTokens: realOutputTokens || 0,
        totalTokens: tokensUsed,
        ...(costUsd !== undefined ? { costUSD: costUsd.toFixed(6) } : {}),
        messagesInContext: history.length
      });

      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          ...(costUsd !== undefined ? { costUSD: costUsd.toFixed(6) } : {}),
        });
      }
    }

    return {
      content,
      tokensUsed,
      inputTokens: realInputTokens,
      outputTokens: realOutputTokens,
      costUsd,
      servedModel
    };
  }
  private getOpenRouterConfig(): { apiKey: string; model: string; apiUrl: string; siteUrl?: string; appName?: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '';

    // Model is passed verbatim — any OpenAI-compatible model id is accepted
    // (e.g. deepseek-chat, an LM Studio local model). #2393. Settings are raw
    // JSON passthrough, so coerce non-string spellings (e.g. a JSON-array
    // fallback list) to a string instead of leaking them downstream, where
    // the telemetry scrubber drops non-string model values silently.
    const rawModel: unknown = settings.CLAUDE_MEM_OPENROUTER_MODEL;
    const model = typeof rawModel === 'string' && rawModel.trim()
      ? rawModel
      : Array.isArray(rawModel) && rawModel.length > 0
        ? rawModel.map(String).join(',')
        : 'xiaomi/mimo-v2-flash:free';

    // Base URL: settings value wins, then OPENROUTER_BASE_URL env var, else
    // the default OpenRouter endpoint (unchanged behavior). #2382/#2590/#2622/#2393.
    const baseUrl = settings.CLAUDE_MEM_OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || '';
    const apiUrl = resolveOpenRouterChatCompletionsUrl(baseUrl);

    const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem';
    const reasoningEffort = parseOpenRouterReasoningEffort(settings.CLAUDE_MEM_OPENROUTER_REASONING_EFFORT);
    let extraBody: Record<string, unknown> | null = null;
    try {
      extraBody = parseOpenRouterExtraBody(settings.CLAUDE_MEM_OPENROUTER_EXTRA_BODY);
    } catch (error) {
      logger.warn('SETTINGS', 'Ignoring invalid OpenRouter extra body setting', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Parse optional extra body parameters (JSON string). Merged into the
    // request body last so users can override defaults or add provider-specific
    // fields like thinking control: {"thinking":{"type":"disabled"}}.
    let extraBody: Record<string, unknown> | undefined;
    const extraBodyRaw = settings.CLAUDE_MEM_OPENROUTER_EXTRA_BODY;
    if (extraBodyRaw) {
      try {
        const parsed = JSON.parse(extraBodyRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          extraBody = parsed as Record<string, unknown>;
        } else {
          logger.warn('SDK', 'CLAUDE_MEM_OPENROUTER_EXTRA_BODY must be a JSON object, ignoring');
        }
      } catch {
        logger.warn('SDK', 'CLAUDE_MEM_OPENROUTER_EXTRA_BODY is not valid JSON, ignoring');
      }
    }

    return { apiKey, model, apiUrl, siteUrl, appName, extraBody };
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
