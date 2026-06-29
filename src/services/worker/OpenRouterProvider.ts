
import { getCredential } from '../../shared/EnvManager.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
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
const CHARS_PER_TOKEN_ESTIMATE = 4;

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
}

export class OpenRouterProvider extends OpenAICompatibleProvider<OpenRouterConfig> {
  protected readonly providerName = 'OpenRouter';
  protected readonly syntheticIdPrefix = 'openrouter';
  protected readonly requireNonEmptyToTruncate = false;
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

  protected truncateHistoryForOpenRouter(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;
    return this.truncateHistory(history, MAX_CONTEXT_MESSAGES, MAX_ESTIMATED_TOKENS);
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  protected async query(history: ConversationMessage[], config: OpenRouterConfig): Promise<ProviderQueryResult> {
    return this.queryOpenRouterMultiTurn(history, config.apiKey, config.model, config.apiUrl, config.siteUrl, config.appName);
  }

  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    apiUrl: string,
    siteUrl?: string,
    appName?: string
  ): Promise<ProviderQueryResult> {
    const truncatedHistory = this.truncateHistoryForOpenRouter(history);
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
        response = await fetch(apiUrl, {
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
            // Ask openrouter.ai for usage accounting (token counts + cost).
            // Only sent to openrouter.ai — strict custom gateways may reject
            // unknown body fields.
            ...(apiUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
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
    const realInputTokens = data.usage?.prompt_tokens;
    const realOutputTokens = data.usage?.completion_tokens;
    // usage.cost is what openrouter.ai charged in credits (~USD); with BYOK the
    // model spend is reported separately as upstream_inference_cost. Custom
    // gateways usually omit both — costUsd stays undefined (never estimated).
    const orCost = typeof data.usage?.cost === 'number' ? data.usage.cost : undefined;
    const upstreamCost = typeof data.usage?.cost_details?.upstream_inference_cost === 'number'
      ? data.usage.cost_details.upstream_inference_cost
      : undefined;
    const costUsd = orCost !== undefined || upstreamCost !== undefined
      ? (orCost ?? 0) + (upstreamCost ?? 0)
      : undefined;
    const servedModel = typeof data.model === 'string' && data.model ? data.model : undefined;

    if (tokensUsed) {
      logger.info('SDK', 'OpenRouter API usage', {
        model: servedModel ?? model,
        inputTokens: realInputTokens || 0,
        outputTokens: realOutputTokens || 0,
        totalTokens: tokensUsed,
        ...(costUsd !== undefined ? { costUSD: costUsd.toFixed(6) } : {}),
        messagesInContext: truncatedHistory.length
      });

      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          ...(costUsd !== undefined ? { costUSD: costUsd.toFixed(6) } : {}),
        });
      }
    }

    return { content, tokensUsed, inputTokens: realInputTokens, outputTokens: realOutputTokens, costUsd, servedModel };
  }

  private getOpenRouterConfig(): OpenRouterConfig {
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

    return { apiKey, model, apiUrl, siteUrl, appName };
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
