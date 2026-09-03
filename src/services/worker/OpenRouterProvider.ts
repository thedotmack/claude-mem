
import { getCredential } from '../../shared/EnvManager.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import { openRouterAttributionHeaders, OPENROUTER_APP_TITLE } from '../../shared/openrouter-attribution.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { clearProFallbackOnGatewaySuccess, isCmemGatewayUrl } from '../../shared/cmem-gateway.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError, type ProviderErrorClass } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { buildBoundedMessages, type BoundedMessage } from './context-window.js';

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
 * Gateway error taxonomy (cmem.ai inference gateway) → worker error kind.
 * The gateway classifies once at the source and sends
 * `{ error: { code, message, action, url, request_id } }`; the worker carries
 * that envelope verbatim and only maps `code` to a retry class.
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
  const envelope = parseUpstreamErrorEnvelope(body);

  // Structured taxonomy envelope from the cmem.ai gateway: carry it verbatim.
  if (envelope && typeof envelope.code === 'string' && Object.prototype.hasOwnProperty.call(GATEWAY_CODE_TO_KIND, envelope.code)) {
    const code = envelope.code;
    const kind = GATEWAY_CODE_TO_KIND[code];
    const message = typeof envelope.message === 'string' && envelope.message
      ? envelope.message
      : `OpenRouter error ${code}${status !== undefined ? ` (status ${status})` : ''}`;
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
  // contains the remedy, e.g. OpenRouter's "Key limit exceeded … Manage it
  // using https://openrouter.ai/…") and carry the request id.
  const upstreamMessage = envelope && typeof envelope.message === 'string' && envelope.message
    ? envelope.message
    : body.substring(0, 300);
  const detail = { ...(input.requestId ? { requestId: input.requestId } : {}) };
  const describe = (cls: string): string =>
    `OpenRouter ${cls}${status !== undefined ? ` (status ${status})` : ''}${upstreamMessage ? `: ${upstreamMessage}` : ''}`;

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
      `OpenRouter network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause, ...detail },
    );
  }

  return new ClassifiedProviderError(
    describe('API error'),
    { kind: 'unrecoverable', cause: input.cause, ...detail },
  );
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

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

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
  siteUrl?: string;
  appName?: string;
  /** max_tokens in the request body (#3606/#3490). */
  maxTokens: number;
  /** Max history turns sent after the system anchor; 0 = unbounded (#3606). */
  maxContextMessages: number;
  /** Max total chars of that windowed history; 0 = unbounded (#3606). */
  maxContextChars: number;
  /** withRetry per-attempt timeout for this provider (#3606). */
  attemptTimeoutMs: number;
}

function hasProcessEnvOverride(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, key);
}

/**
 * NaN or below `min` (corrupt settings.json / bad env override) falls back to
 * `fallback` rather than producing an unbounded-by-accident or invalid
 * request value. `min` is 1 for keys where 0 would be a broken request value
 * (maxTokens, attemptTimeoutMs) and 0 for keys where 0 is the documented
 * "unbounded" sentinel (maxContextMessages, maxContextChars).
 */
function parseOpenRouterInt(raw: unknown, fallback: number, min: number): number {
  const parsed = parseInt(String(raw), 10);
  return Number.isNaN(parsed) || parsed < min ? fallback : parsed;
}

function normalizeOpenRouterModel(rawModel: unknown): string {
  return typeof rawModel === 'string' && rawModel.trim()
    ? rawModel
    : Array.isArray(rawModel) && rawModel.length > 0
      ? rawModel.map(String).join(',')
      : SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL;
}

/**
 * Resolve key/base/model as a source-coherent tuple. In particular, a
 * key-only environment override must never inherit a persisted cmem.ai base
 * URL and send a personal OpenRouter credential to the cmem gateway. To
 * replace a stored cmem tuple at runtime, explicitly override the base URL too
 * (an empty CLAUDE_MEM_OPENROUTER_BASE_URL selects normal OpenRouter).
 */
export function resolveOpenRouterConfig(
  settingsPath: string = USER_SETTINGS_PATH,
): OpenRouterConfig {
  const persisted = SettingsDefaultsManager.loadFromFile(settingsPath, false);
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const persistedBaseUrl = typeof persisted.CLAUDE_MEM_OPENROUTER_BASE_URL === 'string'
    ? persisted.CLAUDE_MEM_OPENROUTER_BASE_URL.trim()
    : '';
  const hasBaseOverride = hasProcessEnvOverride('CLAUDE_MEM_OPENROUTER_BASE_URL');
  const lockPersistedCmemTuple = isCmemGatewayUrl(persistedBaseUrl) && !hasBaseOverride;

  const configuredBaseUrl = typeof settings.CLAUDE_MEM_OPENROUTER_BASE_URL === 'string'
    ? settings.CLAUDE_MEM_OPENROUTER_BASE_URL.trim()
    : '';
  const baseUrl = lockPersistedCmemTuple
    ? persistedBaseUrl
    : configuredBaseUrl || process.env.OPENROUTER_BASE_URL?.trim() || '';

  const detachPersistedCmemTuple = isCmemGatewayUrl(persistedBaseUrl)
    && hasBaseOverride
    && !isCmemGatewayUrl(baseUrl);

  const persistedKey = typeof persisted.CLAUDE_MEM_OPENROUTER_API_KEY === 'string'
    ? persisted.CLAUDE_MEM_OPENROUTER_API_KEY.trim()
    : '';
  const configuredKey = typeof settings.CLAUDE_MEM_OPENROUTER_API_KEY === 'string'
    ? settings.CLAUDE_MEM_OPENROUTER_API_KEY.trim()
    : '';
  const explicitKey = hasProcessEnvOverride('CLAUDE_MEM_OPENROUTER_API_KEY')
    ? process.env.CLAUDE_MEM_OPENROUTER_API_KEY?.trim() ?? ''
    : '';
  const apiKey = lockPersistedCmemTuple
    ? persistedKey
    : detachPersistedCmemTuple
      // A base-only override must not carry the account-owned cmem key to a
      // different host. Accept only a key supplied as part of this runtime
      // tuple or the user's personal key from ~/.claude-mem/.env.
      ? explicitKey || getCredential('OPENROUTER_API_KEY') || ''
      : configuredKey || getCredential('OPENROUTER_API_KEY') || '';

  let rawModel: unknown = lockPersistedCmemTuple
    ? persisted.CLAUDE_MEM_OPENROUTER_MODEL
    : settings.CLAUDE_MEM_OPENROUTER_MODEL;
  if (
    isCmemGatewayUrl(persistedBaseUrl)
    && hasBaseOverride
    && !isCmemGatewayUrl(baseUrl)
    && !hasProcessEnvOverride('CLAUDE_MEM_OPENROUTER_MODEL')
  ) {
    // A base override that moves away from cmem must not retain the gateway's
    // cmem-observer model. Restore the ordinary OpenRouter default unless the
    // operator supplied a model override as part of the new tuple.
    rawModel = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL;
  }
  const model = normalizeOpenRouterModel(rawModel);

  const apiUrl = resolveOpenRouterChatCompletionsUrl(baseUrl);
  const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
  const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || OPENROUTER_APP_TITLE;

  // #3606 — a corrupt/non-numeric settings value falls back to the shipped
  // default rather than propagating NaN/negative limits. Fallbacks are the
  // literal SettingsDefaultsManager DEFAULTS values (parseInt(defaults.X) was
  // redundant — SettingsDefaultsManager already backfills missing keys before
  // this code ever runs). maxTokens and attemptTimeoutMs are request-shape/
  // timing values a 0 would break (an OpenAI-compatible max_tokens: 0 or a
  // zero-length retry timeout is not a meaningful "unbounded"), so they
  // require >= 1; maxContextMessages and maxContextChars keep 0 as the
  // documented "unbounded" sentinel — only a negative value (never a
  // legitimate setting) falls back there.
  const maxTokens = parseOpenRouterInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS, 4096, 1);
  const maxContextMessages = parseOpenRouterInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES, 40, 0);
  const maxContextChars = parseOpenRouterInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_CHARS, 200000, 0);
  const attemptTimeoutMs = parseOpenRouterInt(settings.CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS, 30000, 1);

  return { apiKey, model, apiUrl, siteUrl, appName, maxTokens, maxContextMessages, maxContextChars, attemptTimeoutMs };
}

export class OpenRouterProvider extends OpenAICompatibleProvider<OpenRouterConfig> {
  protected readonly providerName = 'OpenRouter';
  protected readonly syntheticIdPrefix = 'openrouter';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OpenRouterConfig {
    return resolveOpenRouterConfig();
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

  protected async query(history: ConversationMessage[], config: OpenRouterConfig): Promise<ProviderQueryResult> {
    return this.queryOpenRouterMultiTurn(history, config);
  }

  /** POST the chat-completions request. Extracted so the retry try block stays narrow. */
  private fetchChatCompletion(
    apiUrl: string,
    apiKey: string,
    model: string,
    messages: BoundedMessage[],
    maxTokens: number,
    siteUrl: string | undefined,
    appName: string | undefined,
    priorRequestId: string | null,
    attemptSignal: AbortSignal
  ): Promise<Response> {
    // `timeout` isn't in the DOM fetch/RequestInit types — Bun's fetch has a
    // built-in ~300s cap that overrides any AbortSignal-based per-attempt
    // timeout, so it must be disabled explicitly for withRetry's
    // perAttemptTimeoutMs to be authoritative (#3606).
    const requestInit = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...openRouterAttributionHeaders(siteUrl, appName),
        'Content-Type': 'application/json',
        ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,  // Lower temperature for structured extraction
        max_tokens: maxTokens,
        // Ask openrouter.ai for usage accounting (token counts + cost).
        // Only sent to openrouter.ai — strict custom gateways may reject
        // unknown body fields.
        ...(apiUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
      }),
      signal: attemptSignal,
      timeout: false,
    } as unknown as Record<string, unknown>;

    return fetch(apiUrl, requestInit as RequestInit);
  }

  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    config: OpenRouterConfig
  ): Promise<ProviderQueryResult> {
    const { apiKey, model, apiUrl, siteUrl, appName, maxTokens, maxContextMessages, maxContextChars, attemptTimeoutMs } = config;

    const messages = buildBoundedMessages(history, { maxMessages: maxContextMessages, maxChars: maxContextChars });
    const promptChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(messages.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OpenRouter multi-turn (${model})`, {
      turns: history.length,
      messagesSent: messages.length,
      promptChars,
      estimatedTokens
    });

    let priorRequestId: string | null = null;

    const data = await withRetry<OpenRouterResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchChatCompletion(apiUrl, apiKey, model, messages, maxTokens, siteUrl, appName, priorRequestId, attemptSignal);
      } catch (networkError: unknown) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyOpenRouterError({ cause: err });
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
          bodyText: JSON.stringify(responseData),
          headers: response.headers,
          cause: new Error(`OpenRouter API error: ${responseData.error.code} - ${responseData.error.message}`),
          ...(requestId ? { requestId } : {}),
        });
      }

      return responseData;
    }, { label: `OpenRouter ${model}`, perAttemptTimeoutMs: attemptTimeoutMs });

    // A successful cmem-gateway response proves the delivered key is funded
    // again (resubscribed) — clear the trial-expiry fallback marker so
    // dispatch returns to the gateway. No-op for every other endpoint.
    clearProFallbackOnGatewaySuccess(apiUrl);

    const firstChoice = data.choices?.[0];
    const finishReason = firstChoice?.finish_reason;
    const realInputTokens = data.usage?.prompt_tokens;
    const realOutputTokens = data.usage?.completion_tokens;

    if (!firstChoice?.message?.content) {
      // Malformed (no choices at all, or a choice with no message) is a
      // different failure than a designed empty completion (message.content
      // === '' or undefined with choices present) — the latter is the
      // prompt's documented way to say "nothing to report"; the former means
      // the response body doesn't even have the shape the parser expects
      // (#3606).
      const malformed = !data.choices || data.choices.length === 0 || !firstChoice?.message;
      if (malformed) {
        logger.error('SDK', 'Malformed response from OpenRouter — no choices/message in body', {
          keys: Object.keys(data),
          finishReason,
        });
        return { content: '', finishReason: 'malformed' };
      }

      const logFields = {
        finishReason,
        promptTokens: realInputTokens,
        completionTokens: realOutputTokens,
        messagesSent: messages.length,
        promptChars,
      };
      // A DESIGNED empty completion is exactly: message present, content
      // empty, finish_reason === 'stop' — the prompt's documented way to say
      // "nothing to report". 'length' is a real truncation (context/output
      // budget exhausted) and stays an error. Any OTHER finish_reason
      // (content_filter, tool_calls, function_call, or absent) is neither —
      // the model did not reach the designed no-op path, so it must not be
      // logged (or, downstream in ResponseProcessor, counted) as a benign
      // skip: warn and hand the real reason to the parser layer (#3606).
      if (finishReason === 'length') {
        logger.error('SDK', 'Empty response from OpenRouter — context or output budget exhausted', logFields);
        return { content: '', finishReason };
      }
      if (finishReason === 'stop') {
        logger.info('SDK', `Empty response from OpenRouter (finish_reason=${finishReason}) — observer skipped the batch`, logFields);
        return { content: '', finishReason };
      }
      logger.warn('SDK', `Empty response from OpenRouter with finish_reason=${finishReason ?? 'missing'} — not a designed skip`, logFields);
      return { content: '', finishReason: finishReason ?? 'missing' };
    }

    const content = firstChoice.message.content;
    const tokensUsed = data.usage?.total_tokens;
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
        finishReason,
        messagesSent: messages.length,
        promptChars,
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

}

export function isOpenRouterAvailable(settingsPath: string = USER_SETTINGS_PATH): boolean {
  return Boolean(resolveOpenRouterConfig(settingsPath).apiKey);
}

export function isOpenRouterSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openrouter';
}
