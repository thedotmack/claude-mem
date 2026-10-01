
import { getCredential } from '../../shared/EnvManager.js';
import { isOpenRouterApiUrl, resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import { openRouterAttributionHeaders, OPENROUTER_APP_TITLE } from '../../shared/openrouter-attribution.js';
import { fetchWithOpenRouterTokenCompatibility } from '../../shared/openrouter-token-compatibility.js';
import { describeNetworkFailure, networkFailureSuffix } from '../../shared/network-failure.js';
import { parseOpenRouterExtraBody, withOpenRouterExtraBody } from '../../shared/openrouter-extra-body.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { clearProFallbackOnGatewaySuccess, isCmemGatewayUrl, isCmemMemoryKey, isKeyAllowedForEndpoint } from '../../shared/cmem-gateway.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError, type ProviderErrorClass } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { buildKeyPool, resolvePoolKeys, retryPolicyForPool, withKeyPool } from '../../shared/api-key-pool.js';
import { OpenAICompatibleProvider, assistantText, type OpenAIChatMessage as OpenAIMessage, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import {
  resolveContextWindowTokens,
  resolveObserverMaxOutputTokens,
  DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS,
} from './context-window.js';
import { isContextOverflowObserverOutput } from '../../sdk/output-classifier.js';
import { namesPeriodRateLimit } from '../../shared/period-rate-limit.js';

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
  metadata?: unknown;
}

/**
 * Whether a 403 is OpenRouter refusing a moderated model's flagged input
 * rather than the key: its envelope carries the flagged reasons or input in
 * `metadata`, or its message says the input was flagged.
 */
function isModerationRefusal(envelope: UpstreamErrorEnvelope | null, lowerBody: string): boolean {
  const metadata = envelope?.metadata;
  if (
    metadata !== null && typeof metadata === 'object'
    && ('flagged_input' in metadata || Array.isArray((metadata as { reasons?: unknown }).reasons))
  ) {
    return true;
  }
  return lowerBody.includes('requires moderation') || lowerBody.includes('input was flagged');
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
 * OpenRouter's answers when the configured model id itself is gone: a retired
 * model (404 "This model has been deprecated. It is recommended to migrate to
 * …", #3659), an id that is not in the catalog (400 "… is not a valid model
 * ID"), or one with no serving endpoint left (404 "No endpoints found for
 * <id>."). Retrying never helps, and the generic "check the API key, spend
 * limit and base URL" remedy points at the wrong setting, so these get their
 * own code and remedy. Phrases only count on a 400/404 or an error envelope
 * inside a 200; any other 400/404 stays a plain bad request.
 */
const MODEL_UNAVAILABLE_MARKERS = [
  'model has been deprecated',
  'not a valid model id',
  'no endpoints found for',
];

const MODEL_UNAVAILABLE_ACTION =
  'Set CLAUDE_MEM_OPENROUTER_MODEL in ~/.claude-mem/settings.json to a model your endpoint still serves (on OpenRouter, one from the model list).';

const OPENROUTER_MODEL_LIST_URL = 'https://openrouter.ai/models';

/**
 * Machine-readable context-length refusals from OpenAI-compatible servers:
 * OpenAI's error code, and llama.cpp's error type and message. The prose forms
 * ("maximum context length", "prompt is too long", "reduce the length of the
 * messages") are the ones the observer-text classifier already recognizes.
 */
const CONTEXT_OVERFLOW_MARKERS = [
  'context_length_exceeded',
  'exceed_context_size_error',
  'exceeds the available context size',
];

function isContextOverflowBody(body: string): boolean {
  const lower = body.toLowerCase();
  return CONTEXT_OVERFLOW_MARKERS.some(marker => lower.includes(marker)) || isContextOverflowObserverOutput(body);
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
  /** The URL a request with no response was sent to, named in the network-error message. */
  requestUrl?: string;
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

  // The request did not fit the model's context window, or the server refused
  // its size outright (413). Retiring the conversation fixes both, so neither
  // may finalize the session as a bad request (#3625). Checked before the quota
  // markers: "context limit exceeded" is not a spend limit.
  if (status === 413 || (status === 400 && isContextOverflowBody(body))) {
    return new ClassifiedProviderError(
      describe('context overflow'),
      { kind: 'context_overflow', cause: input.cause, ...detail },
    );
  }

  // Quota / insufficient credits — body marker takes precedence over status.
  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota') ||
    lower.includes('key limit exceeded') ||
    // "Rate limit exceeded" on a 429 is a rate limit, not quota — the generic
    // marker only applies off the 429 path (the key-limit marker always wins).
    (lower.includes('limit exceeded') && status !== 429) ||
    // A daily cap is a spent allowance (shared with the server runtime).
    (status === 429 && namesPeriodRateLimit(lower)) ||
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

  // OpenRouter's moderation refusal names the INPUT, not the key: "<model>
  // requires moderation on <provider>. Your input was flagged for …", with the
  // flagged reasons in `metadata`. The next observation is a different input,
  // so this is unrecoverable for this batch only — as auth_invalid it would
  // pause all memory behind a cooldown under "credentials refused".
  if (status === 403 && isModerationRefusal(envelope, lower)) {
    return new ClassifiedProviderError(
      describe('moderation refusal'),
      { kind: 'unrecoverable', cause: input.cause, ...detail },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      describe('auth error'),
      { kind: 'auth_invalid', cause: input.cause, ...detail },
    );
  }

  if (
    (status === 400 || status === 404 || (status === 200 && envelope !== null))
    && MODEL_UNAVAILABLE_MARKERS.some(marker => lower.includes(marker))
  ) {
    return new ClassifiedProviderError(
      describe('model unavailable'),
      {
        kind: 'unrecoverable',
        cause: input.cause,
        code: 'model_unavailable',
        action: MODEL_UNAVAILABLE_ACTION,
        url: OPENROUTER_MODEL_LIST_URL,
        ...detail,
      },
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

  // Network errors (no status) — treat as transient. The runtime's error code
  // and the host say what failed where (#4092).
  if (status === undefined) {
    const network = describeNetworkFailure(input.cause, input.requestUrl);
    return new ClassifiedProviderError(
      `OpenRouter network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}${networkFailureSuffix(network)}`,
      {
        kind: 'transient',
        cause: input.cause,
        ...detail,
        ...(network.localNetworkHint ? { action: network.localNetworkHint } : {}),
      },
    );
  }

  // litellm (behind OpenRouter) can fail to parse the downstream model's
  // response and surface it as a body-level error inside a 200 envelope, e.g.
  // `{ error: { code: 200, message: "Unable to get json response - Expecting
  // value: line 45 column 1" } }`. Because the body-error path forwards the
  // success status verbatim, none of the HTTP-status branches above match and
  // it would otherwise fall through to `unrecoverable` and never retry. These
  // are transient upstream hiccups that usually succeed on a retry, so detect
  // the tell-tale litellm markers and route them to the retry loop.
  // Kept marker-scoped on purpose: OpenRouter also delivers genuine auth/quota
  // errors inside 200 envelopes, which must stay non-transient.
  if (lower.includes('unable to get json') || lower.includes('expecting value')) {
    return new ClassifiedProviderError(
      describe('transient upstream parse failure'),
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
      content?: string | Array<{ type: string; text?: string }> | null;
      reasoning_content?: string;
      reasoning?: string | null;
      tool_calls?: unknown[];
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
  /**
   * The rotation pool: `apiKey` followed by CLAUDE_MEM_OPENROUTER_API_KEYS.
   *
   * Always exactly `[apiKey]` when the endpoint is the cmem.ai gateway. The
   * gateway key is account-delivered, so there is no second one to rotate to,
   * and the list is by definition the user's PERSONAL keys — sending those to
   * the gateway is the exact leak `resolveOpenRouterConfig` already refuses to
   * commit when a key-only override meets a persisted cmem base URL.
   */
  apiKeys: string[];
  /** First entry of the configured list; the one named in logs and sessions. */
  model: string;
  /**
   * The rest of the configured list, in priority order, sent as OpenRouter's
   * native `models` fallback array. Empty for the ordinary single-model
   * configuration, which is every install that has not opted in.
   */
  fallbackModels: string[];
  apiUrl: string;
  siteUrl?: string;
  appName?: string;
  /** Per-call output mode for the wrap-up; never a persisted setting. */
  plainText?: boolean;
  /**
   * CLAUDE_MEM_OPENROUTER_EXTRA_BODY, parsed (src/shared/openrouter-extra-body.ts).
   * Never set for the cmem gateway.
   */
  extraBody?: Record<string, unknown>;
  /** CLAUDE_MEM_OPENROUTER_REASONING_EFFORT; sent to openrouter.ai only. */
  reasoningEffort?: OpenRouterReasoningEffort;
}

/**
 * CLAUDE_MEM_OPENROUTER_REASONING_EFFORT values (OpenRouter's documented
 * effort scale, the token-saving end of it). Unset sends nothing.
 */
export const OPENROUTER_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type OpenRouterReasoningEffort = typeof OPENROUTER_REASONING_EFFORTS[number];

/** The setting as an effort, or undefined when unset or not one of the values. */
export function parseOpenRouterReasoningEffort(raw: unknown): OpenRouterReasoningEffort | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (OPENROUTER_REASONING_EFFORTS as readonly string[]).includes(value)
    ? value as OpenRouterReasoningEffort
    : undefined;
}

/**
 * OpenRouter's `reasoning` field for an effort. `none` is sent as
 * `{ enabled: false }`, the shape the wrap-up already uses.
 */
function reasoningControl(effort: OpenRouterReasoningEffort): Record<string, unknown> {
  return effort === 'none' ? { enabled: false } : { effort };
}

function hasProcessEnvOverride(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, key);
}

/**
 * Split CLAUDE_MEM_OPENROUTER_MODEL into a primary model and its fallbacks.
 *
 * The setting has always accepted an array, and the array has always been
 * comma-joined into a single `model` string that OpenRouter rejects outright —
 * #3829 item 3. No model id contains a comma, so the joined form is never
 * anything a user wanted; a comma- or whitespace-separated STRING is the same
 * mistake typed a different way, and is split here too.
 *
 * The first entry becomes `model`, which keeps every single-model install
 * byte-identical, and the rest become OpenRouter's native `models` fallback
 * array. Blanks and repeats are dropped: a repeat would spend a fallback slot
 * re-trying the model that just failed.
 */
export function normalizeOpenRouterModel(rawModel: unknown): { model: string; fallbackModels: string[] } {
  const parts = (Array.isArray(rawModel) ? rawModel : [rawModel])
    // Strings only: a non-string scalar resolved to the default before this
    // change, and no model id is a bare number.
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap(entry => entry.split(/[\s,]+/))
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

  const unique = [...new Set(parts)];
  if (unique.length === 0) {
    return {
      model: SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL,
      fallbackModels: [],
    };
  }
  return { model: unique[0], fallbackModels: unique.slice(1) };
}

/**
 * Build the chat-completions request body.
 *
 * Exported so the body shape is testable without a network round trip, which
 * matters here: in OpenRouter's documented fallback shape `models` REPLACES
 * `model` rather than accompanying it, and that is not a thing to get wrong
 * silently.
 *
 * `models` is only sent to openrouter.ai. A custom gateway reached through
 * CLAUDE_MEM_OPENROUTER_BASE_URL speaks plain OpenAI, where an unknown body
 * field is a 400 — the same reason `usage` is already gated. Such a gateway
 * gets the first model, still strictly better than today's rejected
 * comma-joined string.
 */
export function buildOpenRouterRequestBody(input: {
  model: string;
  fallbackModels: string[];
  messages: OpenAIMessage[];
  apiUrl: string;
  plainText?: boolean;
  /** CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS; the #4003 retry resends it as max_completion_tokens. */
  maxOutputTokens?: number;
  /** CLAUDE_MEM_OPENROUTER_EXTRA_BODY; merged last, but never to the cmem gateway. */
  extraBody?: Record<string, unknown>;
  /** CLAUDE_MEM_OPENROUTER_REASONING_EFFORT; openrouter.ai only. */
  reasoningEffort?: OpenRouterReasoningEffort;
}): Record<string, unknown> {
  const isOpenRouter = isOpenRouterApiUrl(input.apiUrl);
  const useFallbacks = isOpenRouter && input.fallbackModels.length > 0;
  const typedReasoning = isOpenRouter && !input.plainText && input.reasoningEffort !== undefined;
  return withOpenRouterExtraBody({
    ...(useFallbacks
      ? { models: [input.model, ...input.fallbackModels] }
      : { model: input.model }),
    messages: input.messages,
    temperature: 0.3,  // Lower temperature for structured extraction
    max_tokens: input.maxOutputTokens ?? DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS,
    // Ask for one JSON body. A gateway that streams by default answers with
    // text/event-stream, which response.json() cannot read, so every
    // observation fails (#3664). false is the OpenAI default. The cmem gateway
    // never streams unasked, and its requests stay exactly as they are.
    ...(isCmemGatewayUrl(input.apiUrl) ? {} : { stream: false }),
    // Keep the same model, but ask for an answer instead of spending this
    // short rewrite's budget on reasoning. Only known OpenRouter endpoints
    // accept the vendor-specific reasoning control (cmem forwards it).
    ...(input.plainText && (isOpenRouter || isCmemGatewayUrl(input.apiUrl)) ? {
      response_format: { type: 'text' },
      reasoning: { enabled: false },
    } : {}),
    // The reasoning-effort setting, for openrouter.ai only: a custom gateway's
    // strict schema rejects the field, and the cmem gateway sets its own
    // reasoning policy. A wrap-up keeps its own control above.
    ...(typedReasoning && input.reasoningEffort
      ? { reasoning: reasoningControl(input.reasoningEffort) }
      : {}),
    // Ask openrouter.ai for usage accounting (token counts + cost).
    // Only sent to openrouter.ai — strict custom gateways may reject
    // unknown body fields.
    ...(isOpenRouter ? { usage: { include: true } } : {}),
  }, typedReasoning ? withoutReasoning(input.extraBody) : input.extraBody, input.apiUrl, input.plainText);
}

/**
 * The extra body without its `reasoning` field: the typed
 * CLAUDE_MEM_OPENROUTER_REASONING_EFFORT setting decides reasoning when set.
 */
function withoutReasoning(extraBody: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extraBody || !('reasoning' in extraBody)) return extraBody;
  return Object.fromEntries(Object.entries(extraBody).filter(([key]) => key !== 'reasoning'));
}

/** The CLAUDE_MEM_OPENROUTER_EXTRA_BODY value a warning was last logged for: once per value, not per status poll. */
let lastWarnedExtraBody: string | null = null;

/** The usable extra body for a non-gateway endpoint, warning once about an unusable one. */
function resolveExtraBody(raw: unknown): Record<string, unknown> | undefined {
  const { extraBody, warning } = parseOpenRouterExtraBody(raw);
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  if (warning && lastWarnedExtraBody !== rawText) {
    lastWarnedExtraBody = rawText;
    logger.warn('SDK', warning);
  }
  return extraBody;
}

/** Endpoint a mismatched key was last withheld from, so dispatch logs it once, not per call. */
let lastWithheldCmemKeyUrl: string | null = null;

/**
 * Resolve key/base/model as a source-coherent tuple. In particular, a
 * key-only environment override must never inherit a persisted cmem.ai base
 * URL and send a personal OpenRouter credential to the cmem gateway, and a key
 * is never returned with a URL it does not belong to (a cmem memory key only
 * with the gateway, any other key only elsewhere). To
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
  const { model, fallbackModels } = normalizeOpenRouterModel(rawModel);

  const apiUrl = resolveOpenRouterChatCompletionsUrl(baseUrl);
  const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
  const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || OPENROUTER_APP_TITLE;

  // The cmem gateway and its keys go together, both ways: the account-owned
  // cm_pro_ key authenticates only against the gateway, and the gateway only
  // takes a cm_pro_ key, so a personal key must never be sent there. The tuple
  // lock above covers environment overrides, but a base URL changed in
  // settings.json itself (the settings API / viewer, a hand edit) can pair
  // either key with the wrong host. Every request resolves its key and URL
  // here, together, so the pair is checked here — and fails closed.
  if (apiKey && !isKeyAllowedForEndpoint(apiUrl, apiKey)) {
    if (lastWithheldCmemKeyUrl !== apiUrl) {
      lastWithheldCmemKeyUrl = apiUrl;
      logger.warn('SDK', 'Withholding the OpenRouter key: a cmem.ai memory key only goes to the cmem gateway, and the gateway only takes a cmem.ai memory key. Pair CLAUDE_MEM_OPENROUTER_BASE_URL with a key for that endpoint.');
    }
    return { apiKey: '', apiKeys: [], model, fallbackModels, apiUrl, siteUrl, appName };
  }

  // The gateway never pools: its key is account-delivered, so there is no
  // second one to rotate to, and the rotation list holds the user's PERSONAL
  // keys, which must never reach the gateway.
  if (isCmemGatewayUrl(apiUrl)) {
    return { apiKey, apiKeys: apiKey ? [apiKey] : [], model, fallbackModels, apiUrl, siteUrl, appName };
  }

  // Off the gateway the list joins the primary. The same lock applies per
  // entry: a cm_pro_ key pasted into the list never leaves for this host.
  const apiKeys = buildKeyPool(
    apiKey,
    hasProcessEnvOverride('CLAUDE_MEM_OPENROUTER_API_KEYS')
      ? process.env.CLAUDE_MEM_OPENROUTER_API_KEYS?.trim() ?? ''
      : settings.CLAUDE_MEM_OPENROUTER_API_KEYS || getCredential('OPENROUTER_API_KEYS') || '',
  ).filter(key => !isCmemMemoryKey(key));

  // Off the gateway only: the gateway sets its own request policy on traffic
  // it pays for (the request body itself drops it there too).
  const extraBody = resolveExtraBody(settings.CLAUDE_MEM_OPENROUTER_EXTRA_BODY);
  const reasoningEffort = resolveReasoningEffort(settings.CLAUDE_MEM_OPENROUTER_REASONING_EFFORT);
  if (reasoningEffort && extraBody && 'reasoning' in extraBody && !warnedReasoningOverlap) {
    warnedReasoningOverlap = true;
    logger.warn('SDK', 'CLAUDE_MEM_OPENROUTER_REASONING_EFFORT is set, so the reasoning field in CLAUDE_MEM_OPENROUTER_EXTRA_BODY is ignored');
  }

  return {
    apiKey: apiKey || apiKeys[0] || '',
    apiKeys,
    model,
    fallbackModels,
    apiUrl,
    siteUrl,
    appName,
    ...(extraBody ? { extraBody } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/** The reasoning-effort value a warning was last logged for: once per value, not per status poll. */
let lastWarnedReasoningEffort: string | null = null;

/** Whether the effort-overrides-extra-body warning was logged (once per process). */
let warnedReasoningOverlap = false;

/** The configured effort, warning once about a value that is not one. Never throws. */
function resolveReasoningEffort(raw: unknown): OpenRouterReasoningEffort | undefined {
  const effort = parseOpenRouterReasoningEffort(raw);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!effort && text && lastWarnedReasoningEffort !== text) {
    lastWarnedReasoningEffort = text;
    logger.warn('SDK', `Ignoring CLAUDE_MEM_OPENROUTER_REASONING_EFFORT "${text}": use one of ${OPENROUTER_REASONING_EFFORTS.join(', ')}, or leave it empty`);
  }
  return effort;
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
    session.endpointClass = isOpenRouterApiUrl(config.apiUrl) ? 'openrouter' : 'custom';
  }

  protected resolveContextWindow(config: OpenRouterConfig): Promise<number> {
    return resolveContextWindowTokens('openrouter', config.model, config.apiUrl);
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

  protected async query(
    history: ConversationMessage[],
    config: OpenRouterConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
  ): Promise<ProviderQueryResult> {
    // Rotation wraps withRetry rather than living inside it: the inner retry
    // still owns transient failures against one key, and this outer sweep moves
    // on only for the kinds that mean the key itself is spent. A pool of one —
    // every install that has not opted in, and every cmem-gateway install — is
    // a pass-through.
    return withKeyPool(
      { poolId: 'openrouter', keys: resolvePoolKeys(config), label: 'OpenRouter' },
      ({ key, poolSize }) => this.queryOpenRouterMultiTurn(
        history, key, poolSize, config.model, config.fallbackModels, config.apiUrl, config.siteUrl, config.appName,
        signal, config.plainText, perAttemptTimeoutMs, config.extraBody, config.reasoningEffort,
      ),
    );
  }

  /** POST the chat-completions request. Extracted so the retry try block stays narrow. */
  private fetchChatCompletion(
    apiUrl: string,
    apiKey: string,
    model: string,
    fallbackModels: string[],
    messages: OpenAIMessage[],
    siteUrl: string | undefined,
    appName: string | undefined,
    priorRequestId: string | null,
    attemptSignal: AbortSignal,
    maxOutputTokens: number,
    plainText?: boolean,
    extraBody?: Record<string, unknown>,
    reasoningEffort?: OpenRouterReasoningEffort,
  ): Promise<Response> {
    const body = buildOpenRouterRequestBody({ model, fallbackModels, messages, apiUrl, plainText, maxOutputTokens, extraBody, reasoningEffort });
    // Bound, so a runtime whose fetch needs its receiver still gets it.
    return fetchWithOpenRouterTokenCompatibility(fetch.bind(globalThis), apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...openRouterAttributionHeaders(siteUrl, appName),
        'Content-Type': 'application/json',
        ...(priorRequestId ? { 'x-claude-mem-prior-request-id': priorRequestId } : {}),
      },
      signal: attemptSignal,
    }, body, maxOutputTokens);
  }

  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    /** Size of the rotation pool this attempt belongs to; 1 means no rotation. */
    poolSize: number,
    model: string,
    fallbackModels: string[],
    apiUrl: string,
    siteUrl?: string,
    appName?: string,
    signal?: AbortSignal,
    plainText?: boolean,
    perAttemptTimeoutMs?: number,
    extraBody?: Record<string, unknown>,
    reasoningEffort?: OpenRouterReasoningEffort,
  ): Promise<ProviderQueryResult> {
    const messages = this.conversationToOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(messages.map(m => m.content).join(''));
    const maxOutputTokens = resolveObserverMaxOutputTokens();

    logger.debug('SDK', `Querying OpenRouter multi-turn (${model})`, {
      turns: history.length,
      totalChars,
      estimatedTokens,
      maxOutputTokens,
    });

    let priorRequestId: string | null = null;
    // The id of the response actually returned. priorRequestId keeps an earlier
    // failed attempt's id for the retry-dedup header, so it would name the wrong
    // request when the final response carries no id header.
    let finalRequestId: string | undefined;

    const data = await withRetry<OpenRouterResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchChatCompletion(apiUrl, apiKey, model, fallbackModels, messages, siteUrl, appName, priorRequestId, attemptSignal, maxOutputTokens, plainText, extraBody, reasoningEffort);
      } catch (networkError: unknown) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyOpenRouterError({ cause: err, requestUrl: apiUrl });
      }

      const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-openrouter-request-id');
      finalRequestId = requestId ?? undefined;
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
    }, { label: `OpenRouter ${model}`, abortSignal: signal, perAttemptTimeoutMs, ...(signal ? { maxRetries: 0 } : {}), ...retryPolicyForPool(poolSize) });

    // A successful cmem-gateway response proves the delivered key is funded
    // again (resubscribed) — clear the trial-expiry fallback marker so
    // dispatch returns to the gateway. No-op for every other endpoint.
    clearProFallbackOnGatewaySuccess(apiUrl);

    const choice = data.choices?.[0];
    const message = choice?.message;
    // OpenAI-compatible gateways may represent assistant text as content
    // blocks. Never substitute reasoning or tool arguments for the answer.
    const content = assistantText(message?.content);
    // `length`: generation stopped at the output-token limit. A block cut off
    // mid-tag never closes, so the parser drops it: silently when earlier blocks
    // parsed, taking the whole batch when none did. Logged before the plain-text
    // and empty-reply exits so a reply cut off before any text is named too.
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
    if (finishReason === 'length') {
      logger.warn('SDK', 'OpenRouter reply was cut off at the output-token limit', {
        model: data.model ?? model,
        requestId: finalRequestId,
        maxTokens: maxOutputTokens,
        outputTokens: data.usage?.completion_tokens,
        contentChars: content.length,
        messagesInContext: history.length,
      });
    }
    if (plainText && !content.trim()) {
      const error = new Error('OpenRouter returned no assistant text for the Telegram wrap-up');
      logger.error('TELEGRAM', error.message, {
        model: data.model ?? model,
        requestId: priorRequestId,
        finishReason: choice?.finish_reason,
        contentType: Array.isArray(message?.content) ? 'array' : typeof message?.content,
        hasReasoningContent: Boolean(message?.reasoning_content || message?.reasoning),
        toolCalls: message?.tool_calls?.length ?? 0,
        completionTokens: data.usage?.completion_tokens,
      }, error);
      throw error;
    }
    if (!message || (typeof message.content !== 'string' && !content)) {
      logger.error('SDK', 'Empty response from OpenRouter');
      return { content: '', ...(finishReason ? { finishReason } : {}) };
    }

    if (content.length === 0) {
      logger.debug('SDK', 'OpenRouter returned an empty message', {
        finishReason: choice.finish_reason,
        hasReasoningContent: Boolean(message.reasoning_content),
      });
    }
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
        messagesInContext: history.length
      });
    }

    return {
      content, tokensUsed, inputTokens: realInputTokens, outputTokens: realOutputTokens, costUsd, servedModel,
      ...(finishReason ? { finishReason } : {}),
    };
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
