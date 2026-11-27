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
 * The body is model, messages, temperature, the output-token cap, the standard
 * OpenAI streaming fields, and `reasoning: { enabled: false }` by default
 * (CLAUDE_MEM_OPENAI_COMPAT_REASONING). A reasoning-by-default model otherwise
 * spends max_tokens thinking and returns empty content (#2995). A strict
 * endpoint that rejects the field (vLLM in particular) is sent the request
 * once more without it. One that refuses the streaming fields is sent the
 * plain body instead (streamed-chat-completion.ts). Token counts are used when
 * the endpoint reports them and are never estimated into the usage event,
 * matching the rule OpenRouter's `buildLastUsage` already enforces: real
 * numbers on both sides or none.
 */

import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import {
  diagnoseHostModel,
  HOST_MODEL_STATUS_WORDS,
  type HostModelDiagnostic,
} from '../../shared/openai-compat-host-diagnosis.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import { keysForEndpoint } from '../../shared/cmem-gateway.js';
import { describeNetworkFailure, isConnectionRefused, networkFailureSuffix } from '../../shared/network-failure.js';
import { resolveOpenAICompatPreset, type OpenAICompatPreset } from '../../shared/openai-compat-presets.js';
import { buildKeyPool, resolvePoolKeys, retryPolicyForPool, withKeyPool } from '../../shared/api-key-pool.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage, PendingMessageWithId } from '../worker-types.js';
import { buildObservationPrompt, renderObservationPrompt, type ObservationPromptParts } from '../../sdk/prompts.js';
import { observationFieldMaxChars } from './context-window.js';
import { boundedInteger } from './CodexAppServerPool.js';
import { sameObservationContext } from './codex-observation-batch.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { randomUUID } from 'crypto';
import { ClassifiedProviderError, HOST_MODEL_NOT_SERVED_CODE, isClassified, rateLimitUntilNextKey } from './provider-errors.js';
// Kept as a re-export: existing callers import the code from this module.
export { HOST_MODEL_NOT_SERVED_CODE } from './provider-errors.js';
import {
  claimReasoningBudgetRetry,
  combineBilledChatUsage,
  endpointRejectsReasoningField,
  isLengthTruncatedEmptyReply,
  isUnknownReasoningParameter,
  openAICompatReasoningBody,
  type CompatReasoningBody,
  requestDisablesReasoning,
  resolveOpenAICompatReasoningEffort,
  reasoningBudgetGiveUpMessage,
  reasoningBudgetRetryMessage,
  reasoningBudgetSkippedMessage,
  rememberEndpointRejectsReasoningField,
  resolveOpenAICompatReasoning,
  startReasoningRetryDeadline,
} from './reasoning-budget.js';
import type { PaidSendBudget } from './paid-send-budget.js';
import { isContextOverflowBody } from './OpenRouterProvider.js';
import { namesPeriodRateLimit } from '../../shared/period-rate-limit.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { resolveObserverMaxOutputTokens } from './context-window.js';
import {
  STREAMED_REQUEST_FIELDS,
  resolveStreamIdleTimeoutMs,
  resolveStreamLiveness,
  sendChatCompletion,
  streamsChatCompletion,
  type ChatCompletionExchange,
  type StreamLiveness,
} from './streamed-chat-completion.js';
import {
  OpenAICompatibleProvider,
  assistantText,
  type ObserverRequestLabel,
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

/** Last prompt for context size; both requests' completion tokens were billed. */
function withCombinedCompatUsage(
  first: ChatCompletionResponse['usage'],
  retry: ChatCompletionResponse,
): ChatCompletionResponse {
  const combined = combineBilledChatUsage(
    {
      promptTokens: first?.prompt_tokens,
      completionTokens: first?.completion_tokens,
      totalTokens: first?.total_tokens,
    },
    {
      promptTokens: retry.usage?.prompt_tokens,
      completionTokens: retry.usage?.completion_tokens,
      totalTokens: retry.usage?.total_tokens,
    },
  );
  const usage: NonNullable<ChatCompletionResponse['usage']> = { ...retry.usage };
  if (combined.promptTokens !== undefined) usage.prompt_tokens = combined.promptTokens;
  if (combined.completionTokens !== undefined) usage.completion_tokens = combined.completionTokens;
  if (combined.totalTokens !== undefined) usage.total_tokens = combined.totalTokens;
  return { ...retry, usage };
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
  /**
   * Endpoint-ready small model taken from the host's OpenCode config (#6485).
   * Present only when the host gate is on and the host declares a small model;
   * the summary tier uses it after CLAUDE_MEM_TIER_SUMMARY_MODEL and before the
   * observer model.
   */
  summaryModel?: string;
  /**
   * Model ids in this config that the host chose, by the opt-in that took each:
   * the host session's model, and the model and small model of the host's
   * OpenCode config. A request whose `model` is one of them was sent on the
   * host's choice, so a 404 for it is the endpoint refusing that choice, not a
   * wrong configured model.
   */
  hostChosenModels?: Record<string, HostModelSetting>;
  /**
   * Internal: this endpoint was usable, but every model candidate it had was
   * an id it had already refused, so `model` is empty. Not set when nothing was
   * configured, nor when an explicit setting removed the preset default: those
   * are half-configured endpoints that legitimately fall through to Claude.
   * Dispatch keeps the provider selected on this flag alone, and `query()` stops
   * with the classified refusal instead of sending another doomed request.
   */
  allModelsRefused?: boolean;
  /** Set for a Telegram wrap-up request (OpenAICompatibleProvider.formatTelegramWrapup). */
  plainText?: boolean;
}

/** The opt-ins that take a model id from the host instead of from claude-mem's own settings. */
export type HostModelSetting = 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION' | 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST';

/** Where each opt-in's model id comes from, as the refusal's remedy says it. */
const HOST_MODEL_ORIGIN: Record<HostModelSetting, string> = {
  CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION: 'the model selected in the host session, which CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION sends as-is',
  CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST: "the model the host's OpenCode config names, which CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST reads",
};

/**
 * Host-chosen model ids the observer endpoint answered 404 for, by endpoint
 * URL and id: the host session's model (CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION)
 * and the models of the host's OpenCode config (CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST).
 *
 * Either id belongs to the host's provider, so it is only right when that
 * provider is the same service as the observer endpoint. When it is not, every
 * request for it gets the same 404, and the id comes back with each prompt (the
 * plugin sends it) or each turn (the config is read again): without this, the
 * first batch of every prompt would be refused and the failure would name the
 * wrong setting. A refused id is ignored from then on and the configured model
 * serves.
 *
 * Kept for the worker's life, not on the session: an unrecoverable failure ends
 * the session's live state (handleGeneratorExit), and the next prompt builds a
 * new one. It holds no inference input and sends nothing by itself. A restart
 * forgets it, so an endpoint that starts serving the model is used again then.
 *
 * Not capped. An entry takes a 404 from the user's own endpoint for an id their
 * host selected or their OpenCode config names, a session id is at most 200
 * characters (the session-init schema), and each one is logged at WARN when it
 * is added.
 */
const hostModelsRefusedByEndpoint = new Set<string>();

function isHostModelRefused(apiUrl: string, model: string): boolean {
  return hostModelsRefusedByEndpoint.has(`${apiUrl}\n${model}`);
}

/** The model of this request and the opt-in that took it, when the host chose it; else undefined. */
function hostChosenModelOfRequest(config: OpenAICompatConfig): { id: string; setting: HostModelSetting } | undefined {
  const chosen = config.hostChosenModels;
  return chosen && Object.hasOwn(chosen, config.model) ? { id: config.model, setting: chosen[config.model] } : undefined;
}

/** Stop using a host-chosen model this endpoint answered 404 for. Says so once per endpoint and id. */
function rememberHostModelRefused(config: OpenAICompatConfig, setting: HostModelSetting): void {
  if (isHostModelRefused(config.apiUrl, config.model)) return;
  hostModelsRefusedByEndpoint.add(`${config.apiUrl}\n${config.model}`);
  logger.warn('SDK', `${config.preset.label} does not serve a model the host chose; the observer goes back to the configured model for it`, {
    model: config.model,
    url: config.apiUrl,
    setting,
  });
}

/** Test seam: forget the refused host-chosen models. */
export function resetRefusedHostModelsForTesting(): void {
  hostModelsRefusedByEndpoint.clear();
}

/**
 * The last model each endpoint actually answered, by URL. Ids only: no
 * inference input, no disk, no retry store, no startup sweep. One entry per
 * endpoint and at most 64, so a worker that sees many URLs stays bounded.
 */
const MAX_SERVED_MODELS_BY_ENDPOINT = 64;
const servedModelsByEndpoint = new Map<string, string>();

function rememberServedModel(apiUrl: string, model: string): void {
  if (!apiUrl || !model) return;
  // A Map keeps insertion order, so the first key is the least recently added
  // endpoint. Updating an existing endpoint does not move it.
  if (!servedModelsByEndpoint.has(apiUrl) && servedModelsByEndpoint.size >= MAX_SERVED_MODELS_BY_ENDPOINT) {
    const oldest = servedModelsByEndpoint.keys().next().value;
    if (oldest) servedModelsByEndpoint.delete(oldest);
  }
  servedModelsByEndpoint.set(apiUrl, model);
}

function lastServedModel(apiUrl: string): string | undefined {
  const model = servedModelsByEndpoint.get(apiUrl);
  // An id the endpoint began refusing cannot stay a fallback, even when it
  // answered successfully earlier.
  return model && !isHostModelRefused(apiUrl, model) ? model : undefined;
}

/** Test seam: forget the last served model per endpoint. */
export function resetServedModelsForTesting(): void {
  servedModelsByEndpoint.clear();
}

/**
 * Where the observer's host-configured model may be read from (#6485). The cwd
 * is the observed project: when present, its own OpenCode configs (and its
 * parents') are read as well as the global ones.
 */
export interface OpenAICompatHostOptions {
  cwd?: string;
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
 * Some gateways use a textual code ("bad_gateway") and name the status only in
 * the message, as "(HTTP 503)" (#5185). When the code is not numeric, that is
 * read from the message or from the textual code itself.
 */
function effectiveStatus(status: number | undefined, envelope: ErrorEnvelope | null): number | undefined {
  const code = envelope?.code;
  const numeric = typeof code === 'number' ? code
    : typeof code === 'string' && /^\d{3}$/.test(code) ? Number(code)
    : textualEnvelopeStatus(envelope);
  if (status !== undefined && status >= 200 && status < 300 && numeric >= 400 && numeric < 600) {
    return numeric;
  }
  return status;
}

/** Textual codes and types that name a server-side failure, as the HTTP status they stand for. */
const SERVER_FAILURE_ERROR_CODES: ReadonlyMap<string, number> = new Map([
  ['bad_gateway', 502],
  ['service_unavailable', 503],
  ['gateway_timeout', 504],
  ['server_error', 500],
  ['internal_server_error', 500],
]);

/**
 * The status an envelope with a non-numeric code reports, or NaN.
 *
 * Only a 429 or a 5xx counts, because those are the ones worth retrying. A
 * combo gateway's message lists every upstream's failure
 * ("a: auth (HTTP 401); b: ... (HTTP 503)"), and an upstream's 401 or 413 is not
 * this request's failure, so every marker is scanned for the first retryable one.
 * Only when the message names no status at all does a textual code or type that names a server failure
 * ("bad_gateway", type "server_error") stand for its status.
 *
 * A litellm output failure keeps its own classification: the model ran and was
 * billed, so promoting it to a 5xx would resend it and pay twice.
 */
function textualEnvelopeStatus(envelope: ErrorEnvelope | null): number {
  const message = typeof envelope?.message === 'string' ? envelope.message : '';
  const lowerMessage = message.toLowerCase();
  if (UPSTREAM_OUTPUT_FAILURE_MARKERS.some(marker => lowerMessage.includes(marker))) return NaN;
  const markers = [...message.matchAll(/\(HTTP (\d{3})\)/g)].map(match => Number(match[1]));
  const retryable = markers.find(fromMessage => fromMessage === 429 || (fromMessage >= 500 && fromMessage < 600));
  if (retryable !== undefined) return retryable;
  // The message named statuses and none is retryable (every upstream refused
  // the key, say): that is the answer, whatever the gateway's own code says.
  if (markers.length > 0) return NaN;
  for (const marker of structuredErrorMarkers(envelope)) {
    const mapped = SERVER_FAILURE_ERROR_CODES.get(marker);
    if (mapped !== undefined) return mapped;
  }
  return NaN;
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
  /** The request's model when the host chose it, with the opt-in that took it; unset for a configured model. */
  hostChosenModel?: { id: string; setting: HostModelSetting };
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

  /** The endpoint does not serve an id the host chose: name that opt-in, never the API key. */
  const hostModelNotServedError = (
    input: { cause: unknown },
    status: number,
    id: string,
    setting: HostModelSetting,
  ): ClassifiedProviderError => new ClassifiedProviderError(describe('not found'), {
    kind: 'unrecoverable',
    cause: input.cause,
    code: HOST_MODEL_NOT_SERVED_CODE,
    action: `The endpoint answered ${status} for "${id}", ${HOST_MODEL_ORIGIN[setting]}. The observer stops using that id and goes back to the configured model. To use it, serve it on CLAUDE_MEM_OPENAI_COMPAT_BASE_URL and restart the worker; otherwise set ${setting} to false.`,
  });

  // A request on a host-chosen id that the endpoint refuses is a refusal of
  // that choice, not a bad credential. Check before the 401/403 branch: a 401
  // here would otherwise arm a long auth cooldown and tell the user to rotate a
  // key that works for the configured model. 404 keeps its existing answer.
  if (input.hostChosenModel && (status === 401 || status === 403 || status === 404)) {
    const { id, setting } = input.hostChosenModel;
    return hostModelNotServedError(input, status, id, setting);
  }

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
    // A host-chosen id was handled above; this one came from our own settings,
    // so it is the base URL or _MODEL that is wrong.
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
      // A refused connection never sent the request, so it is pre-send: it
      // must not spend the batch's paid-send budget (#4604). Resets and
      // timeouts stay ambiguous — they can land after the server took it.
      ...(isConnectionRefused(network) ? { paidSendOutcome: 'refused_before_work' as const } : {}),
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
 * Unmapped host ids already warned about, so alternating ids still warn once
 * each. The ids come from OpenCode config files, a checked-out repository's own
 * among them, so the set is capped against a repository that names many: past
 * the cap the oldest id is forgotten, which costs one more warning line if it
 * is read again and nothing else. The number itself has no measurement behind it.
 */
const MAX_WARNED_UNMAPPED_HOST_MODEL_IDS = 64;
const warnedUnmappedHostModelIds = new Set<string>();

/**
 * The other statuses that are worth one notice — masked, none and identity —
 * deduplicated by the id they concern (or by endpoint when there is no id).
 * Separate from `warnedUnmappedHostModelIds`: an id that is sent, or a model
 * deliberately hidden by an explicit setting, must not inherit the
 * untranslatable model's message. Same bounded eviction, for the same reason.
 */
const MAX_WARNED_IDENTITY_HOST_MODEL_IDS = 64;
const warnedIdentityHostModelIds = new Set<string>();

/**
 * Unmapped small-model ids, kept apart from the main model's set: a main id
 * that was sent, or a small id that was sent, must not silence the other's
 * notice. Same cap and insertion-order eviction, for the same reason.
 */
const MAX_WARNED_UNMAPPED_SMALL_MODEL_IDS = 64;
const warnedUnmappedSmallModelIds = new Set<string>();

/** One notice per key, bounded by evicting the oldest entry. */
function warnOnce(warned: Set<string>, cap: number, key: string, line: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // A Set keeps insertion order, so evicting the first entry drops the oldest
  // warning and bounds memory even if a config lists many unknown ids.
  if (warned.size > cap) {
    const oldest = warned.values().next().value;
    if (oldest !== undefined) warned.delete(oldest);
  }
  logger.warn('SDK', line);
}

/** Print the shared diagnosis once per id; translation itself lives in the helper. */
function warnHostModelDiagnostic(diagnostic: HostModelDiagnostic, apiUrl: string): void {
  const status = diagnostic.status;
  if (status !== 'resolved' && status !== 'off') {
    const key = `${HOST_MODEL_STATUS_WORDS[status].label}\n${diagnostic.hostId ?? apiUrl}`;
    warnOnce(
      status === 'unmapped' ? warnedUnmappedHostModelIds : warnedIdentityHostModelIds,
      status === 'unmapped' ? MAX_WARNED_UNMAPPED_HOST_MODEL_IDS : MAX_WARNED_IDENTITY_HOST_MODEL_IDS,
      key,
      diagnostic.line,
    );
  }
  // A resolved main model still hides an untranslatable small model: the old
  // translateHostModel() warned for either id, so keep that notice here. It is
  // a separate line, not another HostModelStatus value.
  const small = diagnostic.smallModelNotice;
  if (small) {
    warnOnce(
      warnedUnmappedSmallModelIds,
      MAX_WARNED_UNMAPPED_SMALL_MODEL_IDS,
      `${HOST_MODEL_STATUS_WORDS.unmapped.label}\nsmall\n${small.hostId}`,
      small.line,
    );
  }
}

/**
 * The host's observer and summary models, endpoint-ready (#6485).
 *
 * Read only when the operator opted in and the caller supplied host options.
 * Status, availability and wrap-up callers pass none and keep the pinned
 * config. The shared diagnosis reads only model, smallModel and provider; no
 * tool, plugin, MCP or permission setting crosses into the worker. The fourth
 * parameter only words the diagnosis line; it never changes which id wins.
 */
function hostObserverModels(
  settings: SettingsDefaults,
  hostOptions: OpenAICompatHostOptions | undefined,
  apiUrl: string,
  fallbackModel: string,
): { model?: string; summaryModel?: string } {
  if (!hostOptions) return {};
  const diagnostic = diagnoseHostModel({
    settings,
    fallbackModel,
    hostOptions,
    apiUrl,
    isRefused: id => isHostModelRefused(apiUrl, id),
  });
  warnHostModelDiagnostic(diagnostic, apiUrl);
  // A translated id this endpoint refused is left out, so the explicit
  // setting, last served id or preset serves instead.
  const servedHere = (id: string | undefined) => (id && !isHostModelRefused(apiUrl, id) ? id : undefined);
  const model = servedHere(diagnostic.endpointId);
  const summaryModel = servedHere(diagnostic.summaryId);
  return {
    ...(model ? { model } : {}),
    ...(summaryModel ? { summaryModel } : {}),
  };
}

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
  hostOptions?: OpenAICompatHostOptions,
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
  // Precedence: explicit setting, then the host's translated model (opt-in),
  // then the last id this endpoint answered, then the preset. A host id never
  // replaces an explicit observer model. A preset default this endpoint
  // refused for a host-chosen id is never reintroduced; '' is a real model
  // value here, and query() stops before the network when it is all we have.
  const hostModelOptedIn = settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST === 'true'
    || settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION === 'true';
  // Only a host-model path may reuse a remembered id: with every opt-in off,
  // the remembered id would let a summary turn change the observer model.
  const lastServed = hostModelOptedIn ? lastServedModel(apiUrl) : undefined;
  const presetFallback = isHostModelRefused(apiUrl, preset.defaultModel) ? '' : preset.defaultModel;
  const fallbackModel = configuredModel || lastServed || presetFallback;
  const hostModels = hostObserverModels(settings, hostOptions, apiUrl, fallbackModel);
  // Only an explicit setting is ours: a translated host id equal to the preset
  // default is still the host's choice, so it carries the host opt-in and a
  // refusal of it is classified as such.
  const ownModel = configuredModel;
  const model = configuredModel || hostModels.model || lastServed || presetFallback;
  // Only an id that claude-mem's own settings do not also name is the host's choice.
  const hostChosenModels: Record<string, HostModelSetting> = {};
  for (const id of [configuredModel ? undefined : hostModels.model, hostModels.summaryModel]) {
    if (id && id !== ownModel) hostChosenModels[id] = 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST';
  }

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

  // A preset default is a model this provider actually configured, unlike a
  // bare endpoint's absent default or a host session id. When that default was
  // refused for a host-chosen id and nothing else is left, the endpoint is not
  // unconfigured: it answered, and there is simply no model left to send. Keep
  // that state distinct so dispatch cannot mistake it for "fall through to
  // Claude" and switch paid accounts. An explicit override that empties the
  // default (or a withheld key) leaves the flag off — that is unconfigured.
  const allModelsRefused = !model && !!preset.defaultModel && !presetFallback
    && !!apiUrl && (!requiresApiKey || apiKeys.length > 0);

  return {
    apiKey: apiKeys[0] ?? '',
    apiKeys,
    requiresApiKey,
    model,
    apiUrl,
    preset,
    ...(allModelsRefused ? { allModelsRefused: true } : {}),
    ...(hostModels.summaryModel ? { summaryModel: hostModels.summaryModel } : {}),
    ...(Object.keys(hostChosenModels).length > 0 ? { hostChosenModels } : {}),
  };
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return `${error.message}\n${cause}`;
}

export class OpenAICompatProvider extends OpenAICompatibleProvider<OpenAICompatConfig> {
  protected readonly providerName = 'OpenAI-compatible';
  protected readonly syntheticIdPrefix = 'openai-compat';
  // Match OpenRouter: forward the empty batch so the parser/recovery path sees
  // it, rather than dropping it the way Gemini does.
  protected readonly forwardEmptyMessageResponse = true;
  protected override readonly rejectAbortedObservation = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OpenAICompatConfig {
    return resolveOpenAICompatConfig(paths.settings());
  }

  /**
   * The observer config for one live session, composing two independent
   * opt-ins (#6485 + #6486).
   *
   * First resolve the base config with `host`: when
   * CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST='true' this reads the host's own
   * OpenCode config and may replace the preset model with its translated
   * endpoint id. Then, only when
   * CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION='true', the endpoint-ready id
   * parked on the session is applied last, so it wins over both the host model
   * and the explicit setting. Turning the session opt-in off must not disable
   * host mode.
   *
   * Only model fields are touched. Init, availability, wrap-up, WorkView and
   * api-agent resolve without host options and keep the pinned config.
   */
  protected override configForSession(session: ActiveSession, host?: OpenAICompatHostOptions): OpenAICompatConfig {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    // Keep getConfig() as the pinned path so provider subclasses and the init
    // turn retain their existing config. Host mode opts into the full resolver.
    const config = host && settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_HOST === 'true'
      ? resolveOpenAICompatConfig(paths.settings(), host)
      : this.getConfig();
    if (settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION !== 'true') return config;
    // Defense in depth: the init schema already rejects a blank id, but any
    // other writer must not replace a valid configured model with whitespace.
    const sessionModel = session.observerModel?.trim();
    if (!sessionModel) return config;
    // An id this endpoint answered 404 for is not sent again; a different
    // selection later in the session applies as usual.
    if (isHostModelRefused(config.apiUrl, sessionModel)) return config;
    // An explicit setting naming the same id stays ours: its 404 is a bad
    // base URL or model, not a refusal of the host's choice.
    if (settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL?.trim() === sessionModel) return config;
    // At equality the id is already the one being sent, but it may have been
    // supplied by lastServed, which records no origin. Restore the session
    // marker so a later refusal is classified as a host choice rather than
    // arming the credential cooldown. An existing marker (the host opt-in)
    // keeps its own setting; only a missing one is added.
    const hostChosenModels = config.hostChosenModels && Object.hasOwn(config.hostChosenModels, sessionModel)
      ? config.hostChosenModels
      : { ...config.hostChosenModels, [sessionModel]: 'CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION' as const };
    return {
      ...config,
      model: sessionModel,
      hostChosenModels,
      // A live id this endpoint has not refused is a model to send, so the
      // "nothing left" stop no longer applies to this session.
      ...(config.allModelsRefused ? { allModelsRefused: false } : {}),
    };
  }

  /** Extend this turn with already-queued events; normal confirm/reset covers every claim. */
  protected override observationTurnPrompt(session: ActiveSession, first: PendingMessageWithId, prompt: ObservationPromptParts): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const count = boundedInteger(settings.CLAUDE_MEM_OPENAI_COMPAT_OBSERVATION_BATCH_SIZE, 1, 32);
    const fieldMaxChars = observationFieldMaxChars(session.observerContextWindowTokens);
    // Like the Claude observer, add events only within two window-aware field
    // caps. The first event keeps its normal condensation/rendering path.
    const maxChars = 2 * fieldMaxChars;
    let combined = renderObservationPrompt(prompt);
    for (let size = 1; size < count; size++) {
      let addition = '';
      const next = this.sessionManager.claimNextObservation(session.sessionDbId, candidate => {
        if (!sameObservationContext(first, candidate)) return false;
        // Oversized fields need their own asynchronous condensation pass.
        if ([candidate.tool_input, candidate.tool_response].some(field =>
          (JSON.stringify(field, null, 2) ?? '').length > fieldMaxChars)) return false;
        addition = buildObservationPrompt({
          id: candidate._persistentId,
          tool_name: candidate.tool_name!,
          tool_input: JSON.stringify(candidate.tool_input),
          tool_output: JSON.stringify(candidate.tool_response),
          created_at_epoch: candidate._originalTimestamp,
          cwd: candidate.cwd,
        }, fieldMaxChars);
        return combined.length + 2 + addition.length <= maxChars;
      });
      if (!next) break;
      combined += '\n\n' + addition;
    }
    return combined;
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
    label?: ObserverRequestLabel,
  ): Promise<ProviderQueryResult> {
    // Every model this endpoint had was a host choice it refused. Stop before
    // opening a socket or reserving a paid send: with the provider still
    // selected, a setup_required error here would just fail the observation.
    // The classified code also lets GeneratorRunner discard the pending inputs
    // without a credential cooldown or a rotation to another key/provider.
    if (config.allModelsRefused && !config.model) {
      throw new ClassifiedProviderError(
        `${config.preset.label} does not serve any model left for the observer; no request was sent.`,
        {
          kind: 'unrecoverable',
          cause: new Error('all model candidates were refused by the endpoint'),
          code: HOST_MODEL_NOT_SERVED_CODE,
          action: 'The endpoint refused every model the host chose for it. Set CLAUDE_MEM_OPENAI_COMPAT_MODEL to an id this endpoint serves on CLAUDE_MEM_OPENAI_COMPAT_BASE_URL, or turn off the host model opt-in; the observer will not switch providers on its own.',
        },
      );
    }
    if (!config.apiUrl || !config.model) {
      throw this.missingApiKeyError();
    }
    try {
      const result = await withKeyPool(
        { poolId: 'openai-compatible', keys: resolvePoolKeys(config), label: config.preset.label, rateLimitUntilNextKey },
        ({ key, poolSize }) => this.queryChatCompletions(history, key, poolSize, config, signal, perAttemptTimeoutMs, paidSendBudget, label?.sessionId),
      );
      // Only a completed request proves the endpoint serves this id. Keep the
      // id, never the prompt: a later turn may reuse it when the host and
      // preset choices are both unavailable, without replaying old input.
      // Only the observer's own turns name its model: summaries, field
      // condensation and the Telegram wrap-up run on a different tier's id,
      // which must never replace the observer model's fallback. An unlabelled
      // call is an observer turn (the superclass always supplies a label).
      const kind = label?.kind ?? 'observation';
      if (config.model && (kind === 'init' || kind === 'observation')) {
        rememberServedModel(config.apiUrl, config.model);
      }
      return result;
    } catch (error) {
      // The failed batch is not resent: the error ends this generation as any
      // unrecoverable one does. Only later requests change model.
      const hostChosen = hostChosenModelOfRequest(config);
      if (hostChosen && isClassified(error) && error.code === HOST_MODEL_NOT_SERVED_CODE) rememberHostModelRefused(config, hostChosen.setting);
      throw error;
    }
  }

  /**
   * Overrides the streamed request's idle window when set — a test hook, the
   * only reason this is a field. Unset, every request resolves
   * CLAUDE_MEM_LLM_STREAM_IDLE_TIMEOUT_MS (#4737), so a settings change takes
   * effect without a restart.
   */
  protected streamIdleTimeoutMs: number | undefined;

  /**
   * POST the request and read its (streamed) reply. A model that only takes
   * max_completion_tokens gets the #4003 resend inside sendChatCompletion.
   */
  private async requestChatCompletion(
    config: OpenAICompatConfig,
    apiKey: string,
    messages: OpenAIChatMessage[],
    maxOutputTokens: number,
    clientAttemptId: string,
    attemptSignal: AbortSignal,
    liveness: StreamLiveness | null,
    sessionId: string | undefined,
    reasoning: CompatReasoningBody | undefined,
  ): Promise<ChatCompletionExchange> {
    const label = config.preset.label;
    const sessionHeader = config.preset.sessionHeader;
    const includeReasoning = reasoning !== undefined && !endpointRejectsReasoningField(config.apiUrl, reasoning);
    const send = (withReasoning: boolean) => sendChatCompletion({
      url: config.apiUrl,
      headers: {
        'Content-Type': 'application/json',
        // Tracing only; never treated as server-side idempotency.
        'x-client-request-id': clientAttemptId,
        // Local servers accept any token or none; sending an empty bearer to
        // them is worse than sending no header at all.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        // Per request, from the observed session: one provider instance serves
        // every session, so this can't be a field on it.
        ...(sessionHeader && sessionId ? { [sessionHeader]: sessionId } : {}),
      },
      body: {
        model: config.model,
        messages,
        temperature: 0.3,
        ...(liveness ? STREAMED_REQUEST_FIELDS : {}),
        ...(withReasoning ? reasoning : {}),
      },
      maxOutputTokens,
      signal: attemptSignal,
      liveness,
      label,
      classify: (input) => classifyOpenAICompatError({ ...input, endpointLabel: label, requestUrl: config.apiUrl, hostChosenModel: hostChosenModelOfRequest(config) }),
    });
    try {
      return await send(includeReasoning);
    } catch (error) {
      // Strict schemas (vLLM) 400 on the unknown field. Remember the URL and
      // resend once without it. A model that says reasoning is mandatory is
      // not this: stripping the field would hide that refusal.
      const text = errorText(error);
      if (!includeReasoning || !isClassified(error) || error.kind !== 'unrecoverable' || !isUnknownReasoningParameter(text)) {
        throw error;
      }
      if (rememberEndpointRejectsReasoningField(config.apiUrl, reasoning)) {
        logger.warn('SDK', `${label} rejected the reasoning field; resending without it`, { url: config.apiUrl });
      }
      return send(false);
    }
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
    /** anonymousSessionId() of the observed session, for preset.sessionHeader. */
    sessionId?: string,
  ): Promise<ProviderQueryResult> {
    const messages = this.conversationToOpenAIMessages(history);
    const label = config.preset.label;
    const clientAttemptId = paidSendBudget?.clientAttemptId ?? randomUUID();
    const maxOutputTokens = resolveObserverMaxOutputTokens();
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const effort = resolveOpenAICompatReasoningEffort(settings.CLAUDE_MEM_OPENAI_COMPAT_REASONING_EFFORT);
    const usePreset = resolveOpenAICompatReasoning(settings.CLAUDE_MEM_OPENAI_COMPAT_REASONING) === 'off';
    const reasoning = (effort || usePreset) ? openAICompatReasoningBody(config.preset.reasoningOff, effort) : undefined;
    // The budget retry asks for no thinking in the same wire format as the initial request.
    const reasoningOff = openAICompatReasoningBody(effort ? 'effort-none' : config.preset.reasoningOff);

    logger.debug('SDK', `Querying ${label} multi-turn (${config.model})`, {
      turns: history.length,
      totalChars: history.reduce((sum, m) => sum + m.content.length, 0),
      maxOutputTokens,
    });

    // Decided once, so every attempt is bounded the way withRetry was told.
    const streamed = streamsChatCompletion(config.apiUrl);
    const liveness = streamed
      ? resolveStreamLiveness(perAttemptTimeoutMs, this.streamIdleTimeoutMs ?? resolveStreamIdleTimeoutMs())
      : null;
    let data = await withRetry<ChatCompletionResponse>(async (attemptSignal) => {
      const exchange = await this.requestChatCompletion(config, apiKey, messages, maxOutputTokens, clientAttemptId, attemptSignal, liveness, sessionId, reasoning);
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
          hostChosenModel: hostChosenModelOfRequest(config),
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

    let choice = data.choices?.[0];
    // Text blocks only: reasoning and tool-call arguments are never the answer,
    // and neither is a leading <think> block in the text itself.
    let content = stripLeadingThinkBlock(assistantText(choice?.message?.content));
    let finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
    const warnIfCutOff = () => {
      if (finishReason !== 'length') return;
      logger.warn('SDK', `${label} reply was cut off at the output-token limit`, {
        model: config.model,
        maxTokens: maxOutputTokens,
        outputTokens: data.usage?.completion_tokens,
        contentChars: content.length,
        clientAttemptId,
      });
    };
    warnIfCutOff();

    const canDisableReasoning = !requestDisablesReasoning(reasoning ?? {})
      && !endpointRejectsReasoningField(config.apiUrl, reasoningOff);
    if (isLengthTruncatedEmptyReply(content, finishReason) && canDisableReasoning) {
      if (!claimReasoningBudgetRetry(paidSendBudget)) {
        logger.error('SDK', reasoningBudgetSkippedMessage(label, paidSendBudget?.spentPaidSends ?? 0), {
          model: config.model,
          finishReason,
          maxTokens: maxOutputTokens,
        });
      } else {
        const firstUsage = data.usage;
        logger.error('SDK', reasoningBudgetRetryMessage(label), { model: config.model, finishReason, maxTokens: maxOutputTokens });
        const deadline = liveness ? undefined : startReasoningRetryDeadline(signal, perAttemptTimeoutMs);
        try {
          const retrySignal = deadline?.signal ?? signal ?? new AbortController().signal;
          const exchange = await this.requestChatCompletion(
            config, apiKey, messages, maxOutputTokens, clientAttemptId, retrySignal, liveness, sessionId, reasoningOff,
          );
          const retryData = exchange.body as ChatCompletionResponse;
          if (retryData.error) {
            throw classifyOpenAICompatError({
              status: exchange.status,
              bodyText: JSON.stringify(retryData),
              headers: exchange.headers,
              cause: new Error(`${label} API error: ${retryData.error.code} - ${retryData.error.message}`),
              endpointLabel: label,
              hostChosenModel: hostChosenModelOfRequest(config),
            });
          }
          data = withCombinedCompatUsage(firstUsage, retryData);
          choice = data.choices?.[0];
          content = stripLeadingThinkBlock(assistantText(choice?.message?.content));
          finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
          warnIfCutOff();
          if (isLengthTruncatedEmptyReply(content, finishReason)) {
            logger.error('SDK', reasoningBudgetGiveUpMessage(label, finishReason), { model: config.model });
          }
        } catch (error) {
          signal?.throwIfAborted();
          logger.error('SDK', reasoningBudgetGiveUpMessage(label, finishReason), {
            model: config.model,
          }, error instanceof Error ? error : new Error(String(error)));
        } finally {
          deadline?.finish();
        }
      }
    } else if (isLengthTruncatedEmptyReply(content, finishReason)) {
      logger.error('SDK', reasoningBudgetGiveUpMessage(label, finishReason), {
        model: config.model,
        maxTokens: maxOutputTokens,
      });
    } else if (!content) {
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
 *
 * A session-selected model can supply the missing model only when the operator
 * opted in with CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION='true'. Without the
 * gate or without an id, the strict global-only rule stands. The endpoint and
 * key requirements are never relaxed by a session id.
 */
export function isOpenAICompatAvailable(
  settingsPath: string = paths.settings(),
  sessionModel?: string,
): boolean {
  const config = resolveOpenAICompatConfig(settingsPath);
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const fromSession = settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL_FROM_SESSION === 'true'
    && typeof sessionModel === 'string'
    ? sessionModel.trim()
    : '';
  // An id the endpoint answered 404 for supplies no model: with none configured
  // either, dispatch falls through as it does for any half-configured endpoint.
  const usableFromSession = fromSession && !isHostModelRefused(config.apiUrl, fromSession) ? fromSession : '';
  const model = usableFromSession || config.model;
  if (!config.apiUrl) return false;
  // All models refused is a configured endpoint with nothing left to send, not
  // an unconfigured one: keep dispatch here so query() can stop with the real
  // refusal instead of silently moving the work to Claude.
  if (!model && !config.allModelsRefused) return false;
  if (!config.requiresApiKey) return true;
  return config.apiKeys.length > 0;
}

export function isOpenAICompatSelected(settingsPath: string = paths.settings()): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openai-compatible';
}
