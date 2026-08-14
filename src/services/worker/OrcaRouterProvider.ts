import { getCredential } from '../../shared/EnvManager.js';
import { resolveOrcaRouterChatCompletionsUrl } from '../../shared/orcarouter-base-url.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';

/**
 * OpenAI-compatible client configuration.
 *
 * The endpoint is resolved from CLAUDE_MEM_ORCAROUTER_BASE_URL (settings or env;
 * env var ORCAROUTER_BASE_URL also honored). When unset, requests go to the
 * default OrcaRouter chat-completions URL. When set to an OpenAI-compatible
 * base (a custom gateway, etc.), the provider POSTs to `<base>/chat/completions`.
 * The model is taken verbatim from CLAUDE_MEM_ORCAROUTER_MODEL. See
 * src/shared/orcarouter-base-url.ts for the resolution rules.
 */

/**
 * Classify an OrcaRouter fetch failure into ClassifiedProviderError. Called
 * at the boundary right after `fetch()` returns or throws.
 */
export function classifyOrcaRouterError(input: {
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
      `OrcaRouter quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'OrcaRouter rate limit (429)',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      `OrcaRouter auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      `OrcaRouter bad request (status ${status})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `OrcaRouter upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  // Network errors (no status) — treat as transient.
  if (status === undefined) {
    return new ClassifiedProviderError(
      `OrcaRouter network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `OrcaRouter API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OrcaRouterResponse {
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
  };
  error?: {
    message?: string;
    code?: string;
  };
}

interface OrcaRouterConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
}

export class OrcaRouterProvider extends OpenAICompatibleProvider<OrcaRouterConfig> {
  protected readonly providerName = 'OrcaRouter';
  protected readonly syntheticIdPrefix = 'orcarouter';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OrcaRouterConfig {
    return this.getOrcaRouterConfig();
  }

  protected missingApiKeyError(): Error {
    return new Error('OrcaRouter API key not configured. Set CLAUDE_MEM_ORCAROUTER_API_KEY in settings or ORCAROUTER_API_KEY environment variable.');
  }

  protected prepareSessionExtras(session: ActiveSession, config: OrcaRouterConfig): void {
    // OrcaRouter responses carry real usage; custom OpenAI-compatible
    // gateways often fabricate or omit usage — let telemetry segment the two.
    session.endpointClass = config.apiUrl.includes('api.orcarouter.ai') ? 'orcarouter' : 'custom';
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Real usage only, both sides or nothing: a gateway that reports just one of
   * prompt/completion tokens must not produce a half-real event (a lone
   * completion count used to surface as tokens_input=0 → compression_ratio 0.0).
   */
  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') {
      return null;
    }
    return {
      input: result.inputTokens,
      output: result.outputTokens,
      ...(typeof result.costUsd === 'number' ? { costUsd: result.costUsd } : {}),
    };
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  protected async query(history: ConversationMessage[], config: OrcaRouterConfig): Promise<ProviderQueryResult> {
    return this.queryOrcaRouterMultiTurn(history, config.apiKey, config.model, config.apiUrl);
  }

  /** POST the chat-completions request. Extracted so the retry try block stays narrow. */
  private fetchChatCompletion(
    apiUrl: string,
    apiKey: string,
    model: string,
    messages: OpenAIMessage[],
    priorRequestId: string | null,
    attemptSignal: AbortSignal
  ): Promise<Response> {
    return fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
  }

  private async queryOrcaRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    apiUrl: string
  ): Promise<ProviderQueryResult> {
    const messages = this.conversationToOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(history.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OrcaRouter multi-turn (${model})`, {
      turns: history.length,
      totalChars,
      estimatedTokens
    });

    let priorRequestId: string | null = null;

    const data = await withRetry<OrcaRouterResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchChatCompletion(apiUrl, apiKey, model, messages, priorRequestId, attemptSignal);
      } catch (networkError: unknown) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyOrcaRouterError({ cause: err });
      }

      const requestId = response.headers.get('x-request-id');
      if (requestId) {
        priorRequestId = requestId;
      } else {
        logger.debug('SDK', 'OrcaRouter response missing request-id header; retry dedup is best-effort');
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw classifyOrcaRouterError({
          status: response.status,
          bodyText: errorText,
          headers: response.headers,
          cause: new Error(`OrcaRouter API error: ${response.status} - ${errorText}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      const responseData = await response.json() as OrcaRouterResponse;

      if (responseData.error) {
        // Errors can come in 200 responses too.
        throw classifyOrcaRouterError({
          status: response.status,
          bodyText: `${responseData.error.code} ${responseData.error.message ?? ''}`,
          headers: response.headers,
          cause: new Error(`OrcaRouter API error: ${responseData.error.code} - ${responseData.error.message}`),
        });
      }

      return responseData;
    }, { label: `OrcaRouter ${model}` });

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from OrcaRouter');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;
    const realInputTokens = data.usage?.prompt_tokens;
    const realOutputTokens = data.usage?.completion_tokens;
    const servedModel = typeof data.model === 'string' && data.model ? data.model : undefined;

    if (tokensUsed) {
      logger.info('SDK', 'OrcaRouter API usage', {
        model: servedModel ?? model,
        inputTokens: realInputTokens || 0,
        outputTokens: realOutputTokens || 0,
        totalTokens: tokensUsed,
        messagesInContext: history.length
      });

      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
        });
      }
    }

    return { content, tokensUsed, inputTokens: realInputTokens, outputTokens: realOutputTokens, servedModel };
  }

  private getOrcaRouterConfig(): OrcaRouterConfig {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_ORCAROUTER_API_KEY || getCredential('ORCAROUTER_API_KEY') || '';

    // Model is passed verbatim — any OpenAI-compatible model id is accepted.
    // Settings are raw JSON passthrough, so coerce non-string spellings (e.g. a
    // JSON-array fallback list) to a string instead of leaking them downstream.
    const rawModel: unknown = settings.CLAUDE_MEM_ORCAROUTER_MODEL;
    const model = typeof rawModel === 'string' && rawModel.trim()
      ? rawModel
      : Array.isArray(rawModel) && rawModel.length > 0
        ? rawModel.map(String).join(',')
        : 'openai/gpt-4o-mini';

    // Base URL: settings value wins, then ORCAROUTER_BASE_URL env var, else the
    // default OrcaRouter endpoint (behavior unchanged).
    const baseUrl = settings.CLAUDE_MEM_ORCAROUTER_BASE_URL || process.env.ORCAROUTER_BASE_URL || '';
    const apiUrl = resolveOrcaRouterChatCompletionsUrl(baseUrl);

    return { apiKey, model, apiUrl };
  }
}

export function isOrcaRouterAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_ORCAROUTER_API_KEY || getCredential('ORCAROUTER_API_KEY'));
}

export function isOrcaRouterSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'orcarouter';
}
