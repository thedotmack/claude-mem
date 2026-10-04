// SPDX-License-Identifier: Apache-2.0

/**
 * The `openai-compatible` provider: any OpenAI-shaped `/chat/completions`
 * endpoint, configured on its own settings keys, with NVIDIA NIM and a handful
 * of other endpoints available as presets.
 *
 * See src/shared/openai-compat-presets.ts for why this is a provider of its own
 * rather than another special case inside the OpenRouter client. The short
 * version: OpenRouter's client sends openrouter.ai attribution headers and
 * carries the cmem.ai gateway's credential-pinning rules, and neither should
 * follow a user to NVIDIA.
 *
 * What this sends is deliberately plain — model, messages, temperature, the
 * output-token cap, and the standard OpenAI streaming fields (`stream`,
 * `stream_options.include_usage`), nothing else. Strict endpoints (vLLM in
 * particular) reject unknown body fields, so there is no vendor-specific
 * extra; one that refuses the streaming fields is sent the plain body instead
 * (streamed-chat-completion.ts). Token counts are used when the endpoint
 * reports them and are never estimated into the usage event, matching the rule OpenRouter's
 * `buildLastUsage` already enforces: real numbers on both sides or none.
 */

import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import { keysForEndpoint } from '../../shared/cmem-gateway.js';
import { describeNetworkFailure, networkFailureSuffix } from '../../shared/network-failure.js';
import { resolveOpenAICompatPreset, type OpenAICompatPreset } from '../../shared/openai-compat-presets.js';
import { buildKeyPool, resolvePoolKeys, retryPolicyForPool, withKeyPool } from '../../shared/api-key-pool.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { randomUUID } from 'crypto';
import { ClassifiedProviderError, rateLimitUntilNextKey } from './provider-errors.js';
import type { PaidSendBudget } from './paid-send-budget.js';
import { isContextOverflowBody } from './OpenRouterProvider.js';
import { namesPeriodRateLimit } from '../../shared/period-rate-limit.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { resolveObserverMaxOutputTokens } from './context-window.js';
import {
  DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
  STREAMED_REQUEST_FIELDS,
  resolveStreamLiveness,
  sendChatCompletion,
  streamsChatCompletion,
  type ChatCompletionExchange,
  type StreamLiveness,
} from './streamed-chat-completion.js';
import {
  OpenAICompatibleProvider,
  assistantText,
  type OpenAIChatMessage,
  type ProviderQueryResult,
} from './OpenAICompatibleProvider.js';

const CHARS_PER_TOKEN_ESTIMATE = 4;

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: unknown };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string | number; type?: string };
}

export interface OpenAICompatConfig {
  apiKey: string;
  /** Rotation pool: `apiKey` followed by CLAUDE_MEM_OPENAI_COMPAT_API_KEYS. */
  apiKeys: string[];
  model: string;
  apiUrl: string;
  preset: OpenAICompatPreset;
  /**
   * Whether this endpoint needs a key, resolved from the endpoint actually
   * being called rather than from the preset's name.
   *
   * A preset carries two things that come apart the moment
   * CLAUDE_MEM_OPENAI_COMPAT_BASE_URL is set: where to send the request, and
   * whether that place wants a bearer token. Keeping the preset's answer after
   * its URL has been replaced breaks both directions — `nvidia-nim` pointed at
   * a local server refuses to run without a key it does not need, and `ollama`
   * pointed at a hosted gateway reports itself ready and then 401s on every
   * observation.
   */
  requiresApiKey: boolean;
  /** Set for a Telegram wrap-up request (OpenAICompatibleProvider.formatTelegramWrapup). */
  plainText?: boolean;
}

/**
 * True for an endpoint on this machine or this network, where an
 * OpenAI-compatible server (Ollama, LM Studio, a bare vLLM) legitimately
 * accepts any bearer token or none.
 *
 * A remote endpoint is assumed to want a key. That is the safe default: being
 * told to set one is a clear, fixable message, whereas the alternative is a
 * provider that reports itself available and fails every observation with a
 * 401. A remote server that genuinely needs no auth still works — set
 * CLAUDE_MEM_OPENAI_COMPAT_API_KEY to any non-empty value.
 */
export function isLocalEndpointUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL() keeps IPv6 hosts in brackets.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local')) return true;
  if (bare === '::1' || bare === '0.0.0.0' || bare === '::') return true;
  if (/^127\./.test(bare)) return true;
  if (/^10\./.test(bare)) return true;
  if (/^192\.168\./.test(bare)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true;
  return false;
}

/**
 * Rate-limit markers from an OpenAI-shaped `error` envelope.
 *
 * The transport status cannot be trusted to carry this. Several compatible
 * gateways answer 200 OK with the failure in the body — the shape #3263 hit
 * through OpenRouter — so a status-only classifier calls a throttle
 * `unrecoverable`, which neither retries nor rotates the key. Read the
 * structured code/type as well, and let it decide regardless of status.
 */
const RATE_LIMIT_ERROR_CODES = new Set([
  'rate_limited',
  'rate_limit',
  'rate_limit_error',
  'rate_limit_exceeded',
  'too_many_requests',
  'requests_rate_limit_exceeded',
  'tokens_rate_limit_exceeded',
]);

/**
 * litellm (behind many compatible gateways) reports a failure to parse the
 * downstream model's reply as an error envelope, often inside a 200 (#3263).
 * The model ran and was billed; only its output was lost, so resending pays
 * for the same work again. An output failure, never retried.
 */
const UPSTREAM_OUTPUT_FAILURE_MARKERS = ['unable to get json', 'expecting value'];

interface ErrorEnvelope {
  code?: unknown;
  type?: unknown;
  message?: unknown;
}

/** The `error` object of a body that may not even be JSON. */
function parseErrorEnvelope(bodyText: string): ErrorEnvelope | null {
  if (!bodyText.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    return parsed?.error && typeof parsed.error === 'object' ? parsed.error as ErrorEnvelope : null;
  } catch {
    return null;
  }
}

/** `error.code` / `error.type`, lower-cased, for the rate-limit marker check. */
function structuredErrorMarkers(envelope: ErrorEnvelope | null): string[] {
  if (!envelope) return [];
  return [envelope.code, envelope.type]
    .filter((marker): marker is string | number => typeof marker === 'string' || typeof marker === 'number')
    .map(marker => String(marker).toLowerCase());
}

/**
 * The status to classify by. An error envelope inside a 2xx response often
 * carries the real HTTP status as a numeric `error.code` (a 429 or a 503
 * relayed by a gateway), and that is the one that says whether to retry.
 */
function effectiveStatus(status: number | undefined, envelope: ErrorEnvelope | null): number | undefined {
  const code = envelope?.code;
  const numeric = typeof code === 'number' ? code : typeof code === 'string' && /^\d{3}$/.test(code) ? Number(code) : NaN;
  if (status !== undefined && status >= 200 && status < 300 && numeric >= 400 && numeric < 600) {
    return numeric;
  }
  return status;
}

/**
 * Classify a failure from an arbitrary OpenAI-compatible endpoint.
 *
 * Kept separate from `classifyOpenRouterError` because the inputs differ in
 * kind, not just in wording. OpenRouter and the cmem gateway send a known
 * taxonomy envelope; a self-hosted vLLM or a vendor gateway sends whatever it
 * sends. So this leans on status codes first — which are the one thing the
 * OpenAI shape actually standardizes — and consults the body only for the
 * quota-vs-rate-limit distinction that status alone cannot make.
 *
 * The distinction matters more here than elsewhere: `quota_exhausted` retires a
 * key for 30 minutes and arms the provider breaker, while `rate_limit` retires
 * it for a minute. Calling a per-minute throttle "exhausted" would idle a
 * perfectly good key for half an hour.
 */
export function classifyOpenAICompatError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  endpointLabel?: string;
  /** The URL a request with no response was sent to, named in the network-error message. */
  requestUrl?: string;
}): ClassifiedProviderError {
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const envelope = parseErrorEnvelope(body);
  const status = effectiveStatus(input.status, envelope);
  const retryAfterMs = input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined;
  const label = input.endpointLabel ?? 'OpenAI-compatible endpoint';
  const excerpt = typeof envelope?.message === 'string' && envelope.message
    ? envelope.message.substring(0, 300)
    : body.substring(0, 300);
  const describe = (cls: string): string =>
    `${label} ${cls}${status !== undefined ? ` (status ${status})` : ''}${excerpt ? `: ${excerpt}` : ''}`;

  // Authentication first. The quota scan below matches loose body words like
  // "billing", and a 401/403 very often explains itself in billing terms ("key
  // revoked, update your billing details"). Reading that as a spent allowance
  // retires the key for 30 minutes and can arm the provider breaker, when the
  // actual fix is a new key — so status wins here, before any body markers.
  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(describe('auth error'), {
      kind: 'auth_invalid',
      cause: input.cause,
      action: 'Check the API key for this endpoint (CLAUDE_MEM_OPENAI_COMPAT_API_KEY).',
    });
  }

  // The request did not fit the model's context window (vLLM, llama.cpp, the
  // OpenAI shape), or the server refused its size outright (413). Retiring the
  // conversation fixes both, so neither may finalize the session as a bad
  // request (#3625). Local models have small windows, so this is common here.
  if (status === 413 || (status === 400 && isContextOverflowBody(body))) {
    return new ClassifiedProviderError(describe('context overflow'), {
      kind: 'context_overflow',
      cause: input.cause,
    });
  }

  // A structured rate-limit marker outranks the transport status: an endpoint
  // that reports the throttle in a 200 body must still retry and rotate.
  const rateLimitCoded = structuredErrorMarkers(envelope).some(marker => RATE_LIMIT_ERROR_CODES.has(marker));

  // Quota / credit exhaustion. Body markers win over status, because a 429 is
  // used for both a per-minute throttle and a spent allowance, and 402 is not
  // universal. The markers below are the ones actually emitted by NVIDIA NIM,
  // DeepSeek, Groq, Together and the OpenAI shape itself. "billing" alone is
  // weaker: Groq and OpenAI end a per-minute throttle with a link to their
  // billing page, so it never outranks a 429 or a rate-limit code.
  if (
    lower.includes('insufficient_quota')
    || lower.includes('insufficient quota')
    || lower.includes('quota exceeded')
    || lower.includes('exceeded your current quota')
    || lower.includes('insufficient credit')
    || lower.includes('insufficient balance')
    || lower.includes('out of credits')
    || lower.includes('credit limit')
    || (lower.includes('billing') && status !== 429 && !rateLimitCoded)
    // A 429 naming a daily cap is spent until the day turns over; as a rate
    // limit it would be re-probed every 90 seconds (shared with the worker's
    // OpenRouter classifier and the server runtime).
    || (status === 429 && namesPeriodRateLimit(lower))
    || status === 402
  ) {
    return new ClassifiedProviderError(describe('quota exhausted'), {
      kind: 'quota_exhausted',
      cause: input.cause,
    });
  }

  if (status === 429 || rateLimitCoded) {
    return new ClassifiedProviderError(describe('rate limit'), {
      kind: 'rate_limit',
      cause: input.cause,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  // 404 on a self-configured endpoint is very often a wrong base URL or a model
  // id the endpoint does not serve, so say so instead of just "bad request".
  if (status === 404) {
    return new ClassifiedProviderError(describe('not found'), {
      kind: 'unrecoverable',
      cause: input.cause,
      action: 'Verify CLAUDE_MEM_OPENAI_COMPAT_BASE_URL and _MODEL — a 404 here usually means the base URL is wrong or the endpoint does not serve that model.',
    });
  }

  if (status === 400 || status === 422) {
    return new ClassifiedProviderError(describe('bad request'), {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(describe('upstream error'), {
      kind: 'transient',
      cause: input.cause,
    });
  }

  if (status === undefined) {
    // No status means the request never completed. For a localhost preset this
    // is nearly always "the server is not running", which is worth saying.
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    const network = describeNetworkFailure(input.cause, input.requestUrl);
    return new ClassifiedProviderError(`${label} network error: ${message}${networkFailureSuffix(network)}`, {
      kind: 'transient',
      cause: input.cause,
      ...(network.localNetworkHint ? { action: network.localNetworkHint } : {}),
    });
  }

  if (UPSTREAM_OUTPUT_FAILURE_MARKERS.some(marker => lower.includes(marker))) {
    return new ClassifiedProviderError(describe('upstream output failure'), {
      kind: 'unrecoverable',
      paidSendOutcome: 'output_failure',
      cause: input.cause,
    });
  }

  return new ClassifiedProviderError(describe('API error'), {
    kind: 'unrecoverable',
    cause: input.cause,
  });
}

/**
 * The reply without a leading `<think>…</think>` block. Reasoning models on an
 * OpenAI-compatible endpoint (MiniMax's M2 family, DeepSeek R1 or Qwen3 on
 * Ollama and vLLM) can put their thinking inline at the start of `content`.
 * It is not the answer: kept, it lands in the conversation and is re-sent with
 * every later request. Only a closed block at the very start is removed, so an
 * answer that merely mentions the tag is left alone.
 */
export function stripLeadingThinkBlock(content: string): string {
  return content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '');
}

/** Endpoint a key was last withheld from, so a status poll logs it once, not per read. */
let lastWithheldKeyUrl: string | null = null;

/**
 * Resolve the endpoint tuple.
 *
 * Precedence, per field: the explicit setting, then the preset, then nothing.
 * The preset only ever fills a blank — so switching preset never silently
 * moves a user who pinned a base URL or a model, and the two settings remain
 * the source of truth for what is actually sent.
 *
 * Every key goes through the cmem key lock (#4276): an account-owned cm_pro_
 * key is never sent to a third-party endpoint, and no other key is sent to the
 * cmem gateway. A withheld key leaves the endpoint keyless, which a hosted
 * endpoint reports as unconfigured.
 */
export function resolveOpenAICompatConfig(
  settingsPath: string = USER_SETTINGS_PATH,
): OpenAICompatConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const preset = resolveOpenAICompatPreset(settings.CLAUDE_MEM_OPENAI_COMPAT_PRESET);

  const configuredBaseUrl = (settings.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL ?? '').trim();
  const baseUrl = configuredBaseUrl || preset.baseUrl;
  // Reuses the OpenRouter base-URL normalizer: same job (tolerate a trailing
  // slash, tolerate a base that already names /chat/completions), and one copy
  // of that rule is better than two.
  const apiUrl = baseUrl ? resolveOpenRouterChatCompletionsUrl(baseUrl) : '';

  const configuredModel = (settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL ?? '').trim();
  const model = configuredModel || preset.defaultModel;

  // One credential name for every endpoint, on purpose: the .env whitelist in
  // EnvManager is a security boundary (#2375), and a per-vendor name would mean
  // widening it for each preset added.
  const primaryKey = (settings.CLAUDE_MEM_OPENAI_COMPAT_API_KEY ?? '').trim()
    || getCredential('OPENAI_COMPAT_API_KEY')
    || '';
  const configuredKeys = buildKeyPool(
    primaryKey,
    settings.CLAUDE_MEM_OPENAI_COMPAT_API_KEYS || getCredential('OPENAI_COMPAT_API_KEYS') || '',
  );
  const apiKeys = keysForEndpoint(apiUrl, configuredKeys);
  if (apiKeys.length < configuredKeys.length && lastWithheldKeyUrl !== apiUrl) {
    lastWithheldKeyUrl = apiUrl;
    logger.warn('SDK', 'Withholding openai-compatible keys: the cmem gateway takes one cmem.ai memory key (cm_pro_) and never a pool, and a cm_pro_ key never goes to any other host. Set CLAUDE_MEM_OPENAI_COMPAT_API_KEY to the key this endpoint issued.');
  }

  // The preset's answer only stands while the preset's endpoint does. Once the
  // base URL is overridden, ask the endpoint being called.
  const requiresApiKey = configuredBaseUrl
    ? !isLocalEndpointUrl(configuredBaseUrl)
    : preset.requiresApiKey;

  return {
    apiKey: apiKeys[0] ?? '',
    apiKeys,
    requiresApiKey,
    model,
    apiUrl,
    preset,
  };
}

export class OpenAICompatProvider extends OpenAICompatibleProvider<OpenAICompatConfig> {
  protected readonly providerName = 'OpenAI-compatible';
  protected readonly syntheticIdPrefix = 'openai-compat';
  // Match OpenRouter: forward the empty batch so the parser/recovery path sees
  // it, rather than dropping it the way Gemini does.
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OpenAICompatConfig {
    return resolveOpenAICompatConfig(paths.settings());
  }

  protected missingApiKeyError(): Error {
    const config = this.getConfig();
    if (!config.apiUrl) {
      return new ClassifiedProviderError(
        'No OpenAI-compatible endpoint configured. Set CLAUDE_MEM_OPENAI_COMPAT_PRESET (e.g. nvidia-nim) or CLAUDE_MEM_OPENAI_COMPAT_BASE_URL.',
        { kind: 'setup_required', cause: new Error('missing base URL') },
      );
    }
    if (!config.model) {
      return new ClassifiedProviderError(
        `No model configured for ${config.preset.label}. Set CLAUDE_MEM_OPENAI_COMPAT_MODEL to a model id the endpoint serves.`,
        { kind: 'setup_required', cause: new Error('missing model') },
      );
    }
    return new ClassifiedProviderError(
      `API key not configured for ${config.preset.label}. Set CLAUDE_MEM_OPENAI_COMPAT_API_KEY in settings, or OPENAI_COMPAT_API_KEY in ~/.claude-mem/.env.`,
      { kind: 'setup_required', cause: new Error('missing api key') },
    );
  }

  /** Local servers (Ollama, LM Studio, bare vLLM) legitimately have no key. */
  protected requiresApiKey(config: OpenAICompatConfig): boolean {
    return config.requiresApiKey;
  }

  protected prepareSessionExtras(session: ActiveSession, _config: OpenAICompatConfig): void {
    // Telemetry already segments openrouter.ai from 'custom'; every endpoint
    // reached through this provider is by definition the latter.
    session.endpointClass = 'custom';
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /** Real usage only, both sides or nothing — see OpenRouterProvider. */
  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') {
      return null;
    }
    return { input: result.inputTokens, output: result.outputTokens };
  }

  protected async query(
    history: ConversationMessage[],
    config: OpenAICompatConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
    paidSendBudget?: PaidSendBudget,
  ): Promise<ProviderQueryResult> {
    if (!config.apiUrl || !config.model) {
      throw this.missingApiKeyError();
    }
    return withKeyPool(
      { poolId: 'openai-compatible', keys: resolvePoolKeys(config), label: config.preset.label, rateLimitUntilNextKey },
      ({ key, poolSize }) => this.queryChatCompletions(history, key, poolSize, config, signal, perAttemptTimeoutMs, paidSendBudget),
    );
  }

  /**
   * Silence after which a streamed request is given up. An instance field so a
   * test can shorten it; there is no setting for it.
   */
  protected streamIdleTimeoutMs: number = DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS;

  /**
   * POST the request and read its (streamed) reply. A model that only takes
   * max_completion_tokens gets the #4003 resend inside sendChatCompletion.
   */
  private requestChatCompletion(
    config: OpenAICompatConfig,
    apiKey: string,
    messages: OpenAIChatMessage[],
    maxOutputTokens: number,
    clientAttemptId: string,
    attemptSignal: AbortSignal,
    liveness: StreamLiveness | null,
  ): Promise<ChatCompletionExchange> {
    const label = config.preset.label;
    return sendChatCompletion({
      url: config.apiUrl,
      headers: {
        'Content-Type': 'application/json',
        // Tracing only; never treated as server-side idempotency.
        'x-client-request-id': clientAttemptId,
        // Local servers accept any token or none; sending an empty bearer to
        // them is worse than sending no header at all.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: {
        model: config.model,
        messages,
        temperature: 0.3,
        ...(liveness ? STREAMED_REQUEST_FIELDS : {}),
      },
      maxOutputTokens,
      signal: attemptSignal,
      liveness,
      label,
      classify: (input) => classifyOpenAICompatError({ ...input, endpointLabel: label, requestUrl: config.apiUrl }),
    });
  }

  private async queryChatCompletions(
    history: ConversationMessage[],
    apiKey: string,
    /** Size of the rotation pool this attempt belongs to; 1 means no rotation. */
    poolSize: number,
    config: OpenAICompatConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
    paidSendBudget?: PaidSendBudget,
  ): Promise<ProviderQueryResult> {
    const messages = this.conversationToOpenAIMessages(history);
    const label = config.preset.label;
    const clientAttemptId = paidSendBudget?.clientAttemptId ?? randomUUID();
    const maxOutputTokens = resolveObserverMaxOutputTokens();

    logger.debug('SDK', `Querying ${label} multi-turn (${config.model})`, {
      turns: history.length,
      totalChars: history.reduce((sum, m) => sum + m.content.length, 0),
      maxOutputTokens,
    });

    // Decided once, so every attempt is bounded the way withRetry was told.
    const streamed = streamsChatCompletion(config.apiUrl);
    const liveness = streamed ? resolveStreamLiveness(perAttemptTimeoutMs, this.streamIdleTimeoutMs) : null;
    const data = await withRetry<ChatCompletionResponse>(async (attemptSignal) => {
      const exchange = await this.requestChatCompletion(config, apiKey, messages, maxOutputTokens, clientAttemptId, attemptSignal, liveness);
      const responseData = exchange.body as ChatCompletionResponse;

      // Some gateways report failure in a 200 body (the case #3263 hit through
      // OpenRouter). Treat it exactly like the equivalent HTTP status.
      if (responseData.error) {
        throw classifyOpenAICompatError({
          status: exchange.status,
          bodyText: JSON.stringify(responseData),
          headers: exchange.headers,
          cause: new Error(`${label} API error: ${responseData.error.code} - ${responseData.error.message}`),
          endpointLabel: label,
        });
      }

      return responseData;
    }, {
      label: `${label} ${config.model}`,
      abortSignal: signal,
      perAttemptTimeoutMs,
      paidSendBudget,
      clientAttemptId,
      // A streamed request is bounded by its idle timeout and absolute cap, and
      // may be resent once if it fails before any output.
      ...(streamed ? { attemptDeadlineOwnedByCaller: true, retryBeforeOutput: true } : {}),
      ...(signal ? { maxRetries: 0 } : {}),
      ...retryPolicyForPool(poolSize),
    });

    const choice = data.choices?.[0];
    // Text blocks only: reasoning and tool-call arguments are never the answer,
    // and neither is a leading <think> block in the text itself.
    const content = stripLeadingThinkBlock(assistantText(choice?.message?.content));
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
    if (finishReason === 'length') {
      logger.warn('SDK', `${label} reply was cut off at the output-token limit`, {
        model: config.model,
        maxTokens: maxOutputTokens,
        outputTokens: data.usage?.completion_tokens,
        contentChars: content.length,
        clientAttemptId,
      });
    }
    if (!content) {
      logger.error('SDK', `Empty response from ${label}`, { model: config.model, finishReason });
    }

    const inputTokens = data.usage?.prompt_tokens;
    const outputTokens = data.usage?.completion_tokens;
    const tokensUsed = data.usage?.total_tokens;
    const servedModel = typeof data.model === 'string' && data.model ? data.model : undefined;

    if (tokensUsed) {
      logger.info('SDK', `${label} API usage`, {
        model: servedModel ?? config.model,
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        totalTokens: tokensUsed,
        messagesInContext: history.length,
        clientAttemptId,
      });
    }

    return {
      content,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(servedModel ? { servedModel } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  }
}

/**
 * Usable when there is an endpoint and a model, and a key unless the preset is
 * a local server that does not need one. Availability is deliberately strict:
 * dispatch falls through to Claude when it is false, and a half-configured
 * endpoint should fall through rather than fail every observation.
 */
export function isOpenAICompatAvailable(settingsPath: string = paths.settings()): boolean {
  const config = resolveOpenAICompatConfig(settingsPath);
  if (!config.apiUrl || !config.model) return false;
  if (!config.requiresApiKey) return true;
  return config.apiKeys.length > 0;
}

export function isOpenAICompatSelected(settingsPath: string = paths.settings()): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openai-compatible';
}
