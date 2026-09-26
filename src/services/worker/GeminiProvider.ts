
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry, parseRetryAfterMs, parseRetryDelayMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';

// v1beta is required: the current Gemini 3.x models and the Google-maintained
// `-latest` aliases are only exposed under v1beta, and the retired v1-only 2.x
// models 404 ("no longer available to new users") for freshly created API keys.
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Classify a Gemini fetch failure into ClassifiedProviderError. Called at
 * the boundary right after `fetch()` returns or throws. Provider-specific
 * because Gemini surfaces auth/quota/rate-limit signals via specific status
 * codes and body strings (e.g. "quota exceeded", "API key not valid").
 */
/**
 * Structured signals parsed from a Gemini error response body.
 */
interface GeminiErrorDetails {
  /** True when a QuotaFailure violation names a per-day quota (daily quota really is exhausted). */
  dailyQuotaExhausted: boolean;
  /** RetryInfo.retryDelay converted to ms, when present. */
  retryAfterMs?: number;
}

/**
 * Extract QuotaFailure / RetryInfo signals from a Gemini error body.
 * Gemini error bodies are JSON like:
 *   { "error": { "code": 429, "message": "...", "status": "RESOURCE_EXHAUSTED",
 *     "details": [
 *       { "@type": ".../QuotaFailure", "violations": [{ "quotaId": "GenerateRequestsPerMinutePerProjectPerModel", ... }] },
 *       { "@type": ".../RetryInfo", "retryDelay": "7s" }
 *     ] } }
 * Returns empty signals for non-JSON bodies.
 */
function parseGeminiErrorDetails(bodyText: string): GeminiErrorDetails {
  const details: GeminiErrorDetails = { dailyQuotaExhausted: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return details;
  }
  const errorDetails = (parsed as { error?: { details?: unknown[] } })?.error?.details;
  if (!Array.isArray(errorDetails)) return details;
  for (const detail of errorDetails) {
    if (typeof detail !== 'object' || detail === null) continue;
    const type = String((detail as { '@type'?: unknown })['@type'] ?? '');
    if (type.includes('QuotaFailure')) {
      const violations = (detail as { violations?: unknown[] }).violations;
      if (Array.isArray(violations)) {
        for (const violation of violations) {
          const quotaId = String(
            (violation as { quotaId?: unknown } | null)?.quotaId ?? '',
          ).toLowerCase();
          if (quotaId.includes('perday')) {
            details.dailyQuotaExhausted = true;
          }
        }
      }
    } else if (type.includes('RetryInfo')) {
      const retryDelay = (detail as { retryDelay?: unknown }).retryDelay;
      const ms = parseRetryDelayMs(typeof retryDelay === 'string' ? retryDelay : undefined);
      if (ms !== undefined) details.retryAfterMs = ms;
    }
  }
  return details;
}

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
  const cause = status === undefined
    ? input.cause
    : new Error(`Gemini HTTP error (status ${status}${input.requestId ? `, request ${input.requestId}` : ''})`);

  // 429s are handled before the body-marker check below: Gemini labels EVERY
  // 429 RESOURCE_EXHAUSTED, so letting the marker check run first swallowed
  // all 429s as quota_exhausted (→ 30-min cooldown) and made the rate_limit
  // branch unreachable. QuotaFailure violations refine the verdict — a PerDay
  // quotaId means the daily quota really is exhausted; anything else on a 429
  // is a transient per-minute rate limit.
  if (status === 429) {
    const details = parseGeminiErrorDetails(body);
    if (details.dailyQuotaExhausted) {
      return new ClassifiedProviderError(
        'Gemini quota exhausted (status 429)',
        { kind: 'quota_exhausted', cause },
      );
    }
    const retryAfterMs = details.retryAfterMs
      ?? (headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined);
    return new ClassifiedProviderError(
      'Gemini rate limit (429)',
      { kind: 'rate_limit', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  // Quota exceeded — by body marker — on non-429 statuses (Gemini quirk: it
  // can surface "quota exceeded" on a 500).
  if (lower.includes('quota exceeded') || lower.includes('resource_exhausted')) {
    return new ClassifiedProviderError(
      `Gemini quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause },
    );
  }

  if (status === 401 || status === 403) {
    // API_KEY_INVALID, PERMISSION_DENIED, etc.
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('api key expired')) {
      return new ClassifiedProviderError(
        `Gemini auth invalid (status ${status})`,
        { kind: 'auth_invalid', cause },
      );
    }
    return new ClassifiedProviderError(
      `Gemini auth error (status ${status})`,
      { kind: 'auth_invalid', cause },
    );
  }

  if (status === 400) {
    const category = categorizeGeminiBadRequest(body);
    return new ClassifiedProviderError(
      `Gemini bad request: ${category}`,
      { kind: 'unrecoverable', cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `Gemini upstream error (status ${status})`,
      { kind: 'transient', cause },
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
    `Gemini API error (status ${status})`,
    { kind: 'unrecoverable', cause },
  );
}

// Only models currently served to new API keys. The 2.x / 2.0 IDs were removed
// because Google 404s them for freshly created keys, and bare `gemini-3-flash`
// (no `-preview`) is not a real ID. `*-latest` are Google-maintained aliases
// that track the current GA release, so they never go stale on new keys.
export type GeminiModel =
  | 'gemini-flash-latest'
  | 'gemini-flash-lite-latest'
  | 'gemini-3.5-flash'
  | 'gemini-3.1-flash-lite'
  | 'gemini-3-flash-preview';

const GEMINI_RPM_LIMITS: Record<GeminiModel, number> = {
  'gemini-flash-latest': 10,
  'gemini-flash-lite-latest': 15,
  'gemini-3.5-flash': 10,
  'gemini-3.1-flash-lite': 15,
  'gemini-3-flash-preview': 5,
};

let lastRequestTime = 0;

const GEMINI_EMPTY_HISTORY_FALLBACK = 'Continue the memory observation request.';

export type GeminiBadRequestCategory =
  | 'role_sequence'
  | 'context_limit'
  | 'model_unsupported'
  | 'api_key'
  | 'unknown_bad_request';

export function categorizeGeminiBadRequest(bodyText: string): GeminiBadRequestCategory {
  const lower = bodyText.toLowerCase();

  if (
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key expired') ||
    lower.includes('invalid api key')
  ) {
    return 'api_key';
  }

  if (
    lower.includes('please ensure that multiturn requests alternate') ||
    lower.includes('alternate between user and model') ||
    lower.includes('first content should be with role') ||
    (lower.includes('contents') && lower.includes('role') && (lower.includes('user') || lower.includes('model')))
  ) {
    return 'role_sequence';
  }

  if (
    lower.includes('context limit') ||
    lower.includes('context length') ||
    lower.includes('too many tokens') ||
    lower.includes('input is too long') ||
    lower.includes('prompt is too long') ||
    lower.includes('request payload size exceeds') ||
    (lower.includes('token') && (lower.includes('exceed') || lower.includes('maximum') || lower.includes('limit')))
  ) {
    return 'context_limit';
  }

  if (
    lower.includes('model not found') ||
    lower.includes('model_unsupported') ||
    lower.includes('unsupported model') ||
    lower.includes('not supported for generatecontent') ||
    lower.includes('not supported by this model') ||
    (lower.includes('model') && lower.includes('not supported')) ||
    (lower.includes('models/') && lower.includes('not found'))
  ) {
    return 'model_unsupported';
  }

  return 'unknown_bad_request';
}

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

interface GeminiConfig {
  apiKey: string;
  model: GeminiModel;
  rateLimitingEnabled: boolean;
}

export class GeminiProvider extends OpenAICompatibleProvider<GeminiConfig> {
  protected readonly providerName = 'Gemini';
  protected readonly syntheticIdPrefix = 'gemini';
  protected readonly forwardEmptyMessageResponse = false;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): GeminiConfig {
    return this.getGeminiConfig();
  }

  protected missingApiKeyError(): Error {
    return new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
  }

  protected estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    // Both sides or nothing: a backend reporting only one of the two counts
    // must not produce a half-real event (input=0 → compression_ratio 0.0).
    return typeof result.inputTokens === 'number' && typeof result.outputTokens === 'number'
      ? { input: result.inputTokens, output: result.outputTokens }
      : null;
  }

  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    const contents: GeminiContent[] = [];
    let newestNonEmptyContent: string | null = null;

    for (const msg of history) {
      const trimmed = msg.content.trim();
      if (trimmed.length > 0) {
        newestNonEmptyContent = trimmed;
      }
    }

    for (const msg of history) {
      if (!msg.content.trim()) {
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (contents.length === 0 && role === 'model') {
        continue;
      }

      const previous = contents[contents.length - 1];
      if (previous?.role === role) {
        previous.parts[0].text = `${previous.parts[0].text}\n\n${msg.content}`;
      } else {
        contents.push({
          role,
          parts: [{ text: msg.content }]
        });
      }
    }

    if (contents.length === 0) {
      return [{
        role: 'user',
        parts: [{ text: newestNonEmptyContent ?? GEMINI_EMPTY_HISTORY_FALLBACK }]
      }];
    }

    return contents;
  }

  protected async query(history: ConversationMessage[], config: GeminiConfig, signal?: AbortSignal): Promise<ProviderQueryResult> {
    return this.queryGeminiMultiTurn(history, config.apiKey, config.model, config.rateLimitingEnabled, signal);
  }

  private fetchGenerateContent(
    url: string,
    contents: GeminiContent[],
    priorRequestId: string | null,
    attemptSignal: AbortSignal
  ): Promise<Response> {
    return fetch(url, {
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
  }

  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    signal?: AbortSignal
  ): Promise<ProviderQueryResult> {
    const contents = this.conversationToGeminiContents(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Gemini multi-turn (${model})`, {
      turns: history.length,
      totalChars
    });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    await enforceRateLimitForModel(model, rateLimitingEnabled);

    // Track request-id (best-effort dedup) across retries.
    let priorRequestId: string | null = null;

    const data = await withRetry<GeminiResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchGenerateContent(url, contents, priorRequestId, attemptSignal);
      } catch (networkError: unknown) {
        // Network failures, aborts, DNS, etc.
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyGeminiError({
          cause: err,
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
          cause: new Error(`Gemini API error (status ${response.status})`),
          ...(requestId ? { requestId } : {}),
        });
      }

      return await response.json() as GeminiResponse;
    }, { label: `Gemini ${model}`, abortSignal: signal, ...(signal ? { maxRetries: 0 } : {}) });

    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error('SDK', 'Empty response from Gemini');
      return { content: '' };
    }

    const content = data.candidates[0].content.parts[0].text;
    const tokensUsed = data.usageMetadata?.totalTokenCount;

    return {
      content,
      tokensUsed,
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
    };
  }

  private getGeminiConfig(): GeminiConfig {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    const defaultModel: GeminiModel = 'gemini-flash-latest';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;
    const validModels: GeminiModel[] = [
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
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
