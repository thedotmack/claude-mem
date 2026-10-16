
import { randomUUID } from 'crypto';
import { getCredential } from '../../shared/EnvManager.js';
import { AIMLAPI_DEFAULT_MODEL, resolveAimlapiChatCompletionsUrl } from '../../shared/aimlapi-base-url.js';
import { aimlapiAttributionHeaders, AIMLAPI_APP_TITLE } from '../../shared/aimlapi-attribution.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError, type ProviderErrorClass } from './provider-errors.js';
import type { PaidSendBudget } from './paid-send-budget.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { resolveObserverMaxOutputTokens } from './context-window.js';
import {
  OpenAICompatibleProvider,
  type ObserverRequestLabel,
  type OpenAIChatMessage,
  type ProviderQueryResult,
} from './OpenAICompatibleProvider.js';

/**
 * OpenAI-compatible client configuration.
 *
 * The endpoint is resolved from CLAUDE_MEM_AIMLAPI_BASE_URL (settings or env;
 * env var AIMLAPI_BASE_URL also honored). When unset, requests go to the
 * default aimlapi.com URL. When set to another OpenAI-compatible base (e.g.
 * aimlapi.com's staging backend), the provider POSTs to
 * `<base>/chat/completions`. The model is taken verbatim from
 * CLAUDE_MEM_AIMLAPI_MODEL. See src/shared/aimlapi-base-url.ts for the
 * resolution rules.
 */

/**
 * Structured gateway error taxonomy → worker error kind (same envelope shape
 * the OpenRouter provider understands: `{ error: { code, message, action,
 * url, request_id } }`). The worker carries that envelope verbatim and only
 * maps `code` to a retry class; aimlapi.com's plain OpenAI-style error bodies
 * fall through to the status-based classification below.
 */
const GATEWAY_CODE_TO_KIND: Record<string, ProviderErrorClass> = {
  allowance_exhausted: 'quota_exhausted',
  key_invalid: 'auth_invalid',
  subscription_inactive: 'auth_invalid',
  rate_limited: 'rate_limit',
  upstream_unavailable: 'transient',
  bad_request: 'unrecoverable',
};

interface UpstreamErrorEnvelope {
  code?: unknown;
  message?: unknown;
  action?: unknown;
  url?: unknown;
  request_id?: unknown;
}

/** Best-effort parse of `{ error: {...} }` from an upstream body. */
function parseUpstreamErrorEnvelope(bodyText: string): UpstreamErrorEnvelope | null {
  if (!bodyText) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (error && typeof error === 'object') {
        return error as UpstreamErrorEnvelope;
      }
    }
  } catch {
    // Not JSON — legacy/plain-text body.
  }
  return null;
}

/**
 * Classify an aimlapi.com fetch failure into ClassifiedProviderError. Called
 * at the boundary right after `fetch()` returns or throws.
 */
export function classifyAimlapiError(input: {
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
  const envelope = parseUpstreamErrorEnvelope(body);

  // Structured taxonomy envelope: carry it verbatim.
  if (envelope && typeof envelope.code === 'string' && Object.prototype.hasOwnProperty.call(GATEWAY_CODE_TO_KIND, envelope.code)) {
    const code = envelope.code;
    const kind = GATEWAY_CODE_TO_KIND[code];
    const message = typeof envelope.message === 'string' && envelope.message
      ? envelope.message
      : `aimlapi.com error ${code}${status !== undefined ? ` (status ${status})` : ''}`;
    const requestId = typeof envelope.request_id === 'string' && envelope.request_id
      ? envelope.request_id
      : input.requestId;
    return new ClassifiedProviderError(message, {
      kind,
      cause: input.cause,
      code,
      ...(typeof envelope.action === 'string' && envelope.action ? { action: envelope.action } : {}),
      ...(typeof envelope.url === 'string' && envelope.url ? { url: envelope.url } : {}),
      ...(requestId ? { requestId } : {}),
      ...(kind === 'rate_limit' ? { retryAfterMs: retryAfterMs ?? 60_000 } : {}),
    });
  }

  // Legacy classification: keep the upstream body in the message (it usually
  // contains the remedy, e.g. aimlapi.com's balance message pointing at
  // https://aimlapi.com/app/billing/) and carry the request id.
  const upstreamMessage = envelope && typeof envelope.message === 'string' && envelope.message
    ? envelope.message
    : body.substring(0, 300);
  const detail = { ...(input.requestId ? { requestId: input.requestId } : {}) };
  const describe = (cls: string): string =>
    `aimlapi.com ${cls}${status !== undefined ? ` (status ${status})` : ''}${upstreamMessage ? `: ${upstreamMessage}` : ''}`;

  // Quota / insufficient credits — body marker takes precedence over status.
  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota') ||
    lower.includes('key limit exceeded') ||
    // "Rate limit exceeded" on a 429 is a rate limit, not quota — the generic
    // marker only applies off the 429 path (the key-limit marker always wins).
    (lower.includes('limit exceeded') && status !== 429) ||
    lower.includes('negative credit') ||
    status === 402
  ) {
    return new ClassifiedProviderError(
      describe('quota exhausted'),
      { kind: 'quota_exhausted', cause: input.cause, ...detail },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      describe('rate limit'),
      { kind: 'rate_limit', cause: input.cause, ...detail, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      describe('auth error'),
      { kind: 'auth_invalid', cause: input.cause, ...detail },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      describe('bad request'),
      { kind: 'unrecoverable', cause: input.cause, ...detail },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      describe('upstream error'),
      { kind: 'transient', cause: input.cause, ...detail },
    );
  }

  // Network errors (no status) — treat as transient.
  if (status === undefined) {
    return new ClassifiedProviderError(
      `aimlapi.com network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause, ...detail },
    );
  }

  return new ClassifiedProviderError(
    describe('API error'),
    { kind: 'unrecoverable', cause: input.cause, ...detail },
  );
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

interface AimlapiResponse {
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
    /** Spend reported by aimlapi.com in USD, when the response carries it. */
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

interface AimlapiConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
  siteUrl?: string;
  appName?: string;
}

export class AimlapiProvider extends OpenAICompatibleProvider<AimlapiConfig> {
  protected readonly providerName = 'aimlapi.com';
  protected readonly syntheticIdPrefix = 'aimlapi';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): AimlapiConfig {
    return this.getAimlapiConfig();
  }

  protected missingApiKeyError(): Error {
    return new Error('aimlapi.com API key not configured. Set CLAUDE_MEM_AIMLAPI_API_KEY in settings or AIMLAPI_API_KEY environment variable.');
  }

  protected prepareSessionExtras(session: ActiveSession, config: AimlapiConfig): void {
    // aimlapi.com reports token usage on every response; a custom OpenAI-compatible
    // gateways often fabricate or omit usage — let telemetry segment the two.
    session.endpointClass = config.apiUrl.includes('api.aimlapi.com') ? 'aimlapi' : 'custom';
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

  /**
   * The base class owns message building now: the framing prompt goes out as
   * the system message with its user request as the first user turn (#3868),
   * empty turns are dropped and consecutive same-role turns merged (#3491).
   * This provider kept a private copy of the old straight `history.map`, which
   * both shadowed the inherited member (TS2415) and sent every observer
   * generation's schema as a user turn a small model forgets.
   */

  protected async query(
    history: ConversationMessage[],
    config: AimlapiConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
    paidSendBudget?: PaidSendBudget,
    _label?: ObserverRequestLabel,
  ): Promise<ProviderQueryResult> {
    return this.queryAimlapiMultiTurn(history, config, signal, perAttemptTimeoutMs, paidSendBudget);
  }

  /** POST the chat-completions request. Extracted so the retry try block stays narrow. */
  private fetchChatCompletion(
    apiUrl: string,
    apiKey: string,
    model: string,
    messages: OpenAIChatMessage[],
    siteUrl: string | undefined,
    appName: string | undefined,
    priorRequestId: string | null,
    /** Tracing only; never treated as server-side idempotency. */
    clientAttemptId: string,
    attemptSignal: AbortSignal,
    /** CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS, resolved by the caller. */
    maxOutputTokens: number,
  ): Promise<Response> {
    return fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...aimlapiAttributionHeaders(siteUrl, appName),
        'Content-Type': 'application/json',
        'x-client-request-id': clientAttemptId,
        ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,  // Lower temperature for structured extraction
        max_tokens: maxOutputTokens,
      }),
      signal: attemptSignal,
    });
  }

  private async queryAimlapiMultiTurn(
    history: ConversationMessage[],
    config: AimlapiConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
    paidSendBudget?: PaidSendBudget,
  ): Promise<ProviderQueryResult> {
    const { apiKey, model, apiUrl, siteUrl, appName } = config;
    const messages = this.conversationToOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(history.map(m => m.content).join(''));
    // The claimed batch's attempt id when this request belongs to one, so the
    // budget's accounting and the header on the wire name the same send.
    const clientAttemptId = paidSendBudget?.clientAttemptId ?? randomUUID();
    // The user's own cap, as every sibling HTTP provider reads it. Its default
    // IS 4096 (DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS), so this changes nothing
    // until someone raises the setting — and a hardcoded 4096 was not a
    // conservative choice but a lossy one: a reply cut off inside the
    // observation XML is rejected, and two of them in a row made the worker
    // acknowledge the queued batch and drop it with nothing stored.
    const maxOutputTokens = resolveObserverMaxOutputTokens();

    logger.debug('SDK', `Querying aimlapi.com multi-turn (${model})`, {
      turns: history.length,
      totalChars,
      estimatedTokens
    });

    let priorRequestId: string | null = null;

    const data = await withRetry<AimlapiResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchChatCompletion(apiUrl, apiKey, model, messages, siteUrl, appName, priorRequestId, clientAttemptId, attemptSignal, maxOutputTokens);
      } catch (networkError: unknown) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyAimlapiError({ cause: err });
      }

      const requestId = response.headers.get('x-request-id');
      if (requestId) {
        priorRequestId = requestId;
      } else {
        logger.debug('SDK', 'aimlapi.com response missing request-id header; retry dedup is best-effort');
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw classifyAimlapiError({
          status: response.status,
          bodyText: errorText,
          headers: response.headers,
          cause: new Error(`aimlapi.com API error: ${response.status} - ${errorText}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      const responseData = await response.json() as AimlapiResponse;

      if (responseData.error) {
        // Like other OpenAI-compatible gateways, aimlapi.com can report an error inside a 200 response.
        throw classifyAimlapiError({
          status: response.status,
          bodyText: JSON.stringify(responseData),
          headers: response.headers,
          cause: new Error(`aimlapi.com API error: ${responseData.error.code} - ${responseData.error.message}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      return responseData;
    }, {
      label: `aimlapi.com ${model}`,
      // The base class races its own deadline on the field-compression pass and
      // aborts a cancelled session; a request that ignored these outlived both.
      abortSignal: signal,
      perAttemptTimeoutMs,
      // Every send that may have been billed spends one of the claimed batch's
      // allowance, and a spent budget refuses to send at all — the same cap
      // every other OpenAI-compatible provider is under.
      paidSendBudget,
      clientAttemptId,
      ...(signal ? { maxRetries: 0 } : {}),
    });

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from aimlapi.com');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;
    const realInputTokens = data.usage?.prompt_tokens;
    const realOutputTokens = data.usage?.completion_tokens;
    // usage.cost is reported by some gateways only; when aimlapi.com omits it,
    // costUsd stays undefined (never estimated).
    const orCost = typeof data.usage?.cost === 'number' ? data.usage.cost : undefined;
    const upstreamCost = typeof data.usage?.cost_details?.upstream_inference_cost === 'number'
      ? data.usage.cost_details.upstream_inference_cost
      : undefined;
    const costUsd = orCost !== undefined || upstreamCost !== undefined
      ? (orCost ?? 0) + (upstreamCost ?? 0)
      : undefined;
    const servedModel = typeof data.model === 'string' && data.model ? data.model : undefined;
    // 'length' is what tells the base class a reply was cut off at the
    // output-token cap: it marks a condensed field truncated (compressField)
    // and reaches the response path as session.lastFinishReason.
    const finishReason = typeof data.choices[0].finish_reason === 'string'
      ? data.choices[0].finish_reason
      : undefined;

    if (tokensUsed) {
      logger.info('SDK', 'aimlapi.com API usage', {
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

    return { content, tokensUsed, inputTokens: realInputTokens, outputTokens: realOutputTokens, costUsd, servedModel, finishReason };
  }

  private getAimlapiConfig(): AimlapiConfig {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // `getCredential` reads the Claude Mem credential file only, so a deployment that
    // exports the documented AIMLAPI_API_KEY (and nothing else) was configuring no
    // provider at all: selection fell through to Claude with a valid key present.
    const apiKey = settings.CLAUDE_MEM_AIMLAPI_API_KEY
      || process.env.AIMLAPI_API_KEY?.trim()
      || process.env.CLAUDE_MEM_AIMLAPI_API_KEY?.trim()
      || getCredential('AIMLAPI_API_KEY')
      || '';

    // Model is passed verbatim — any aimlapi.com model id is accepted.
    // Settings are raw JSON passthrough, so coerce non-string spellings (e.g. a
    // JSON-array fallback list) to a string instead of leaking them
    // downstream, where the telemetry scrubber drops non-string model values
    // silently.
    const rawModel: unknown = settings.CLAUDE_MEM_AIMLAPI_MODEL;
    const model = typeof rawModel === 'string' && rawModel.trim()
      ? rawModel
      : Array.isArray(rawModel) && rawModel.length > 0
        ? rawModel.map(String).join(',')
        : AIMLAPI_DEFAULT_MODEL;

    // Base URL: settings value wins, then AIMLAPI_BASE_URL env var, else
    // the default aimlapi.com endpoint.
    const baseUrl = settings.CLAUDE_MEM_AIMLAPI_BASE_URL || process.env.AIMLAPI_BASE_URL || '';
    const apiUrl = resolveAimlapiChatCompletionsUrl(baseUrl);

    const siteUrl = settings.CLAUDE_MEM_AIMLAPI_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_AIMLAPI_APP_NAME || AIMLAPI_APP_TITLE;

    return { apiKey, model, apiUrl, siteUrl, appName };
  }
}

export function isAimlapiAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_AIMLAPI_API_KEY
    || process.env.AIMLAPI_API_KEY?.trim()
    || process.env.CLAUDE_MEM_AIMLAPI_API_KEY?.trim()
    || getCredential('AIMLAPI_API_KEY'));
}

export function isAimlapiSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'aimlapi';
}
