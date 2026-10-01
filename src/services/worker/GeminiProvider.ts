
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { buildKeyPool, resolvePoolKeys, retryPolicyForPool, withKeyPool } from '../../shared/api-key-pool.js';
import { keysForEndpoint } from '../../shared/cmem-gateway.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { parseGeminiErrorDetails } from '../../shared/gemini-error-details.js';
import { readGeminiAnswerText, type GeminiPart } from '../../shared/gemini-answer-text.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { resolveContextWindowTokens, resolveObserverMaxOutputTokens } from './context-window.js';

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

  // A 429 is decided BEFORE the body markers below, because every Gemini 429
  // body carries `RESOURCE_EXHAUSTED` no matter what it is actually refusing.
  // Testing the marker first made this branch unreachable, so this provider
  // never produced `kind: 'rate_limit'` and never populated `retryAfterMs` —
  // the two things `withRetry` and the quota breaker key on.
  if (status === 429) {
    // Read from the body's structured details (gemini-error-details.ts): the
    // QuotaFailure names the window, and RetryInfo carries the retry hint
    // Google sends instead of a Retry-After header. A header still wins.
    const details = parseGeminiErrorDetails(body);
    const retryAfterMs = (headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined)
      ?? details.retryDelayMs;
    if (details.periodQuotaExhausted) {
      // A whole day/week/month is spent: the breaker's long cooldown is the
      // right answer. Carry the hint anyway — it is the reset time.
      return new ClassifiedProviderError(
        `Gemini quota exhausted (status ${status})`,
        { kind: 'quota_exhausted', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
      );
    }
    // A window that clears on its own. Holding this for the quota cooldown
    // turns a six-second throttle into a half-hour outage.
    return new ClassifiedProviderError(
      'Gemini rate limit (429)',
      { kind: 'rate_limit', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  // Quota exceeded — by body marker — even on 500 (Gemini quirk).
  if (lower.includes('quota exceeded') || lower.includes('resource_exhausted')) {
    return new ClassifiedProviderError(
      `Gemini quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause },
    );
  }

  // Google serves the Gemini API in some regions only; elsewhere every request
  // answers "User location is not supported" (a 400 FAILED_PRECONDITION, or a
  // 403). No retry helps and the batch is not at fault, so it pauses the way a
  // refused key does (buffered work kept, one cooldown) and says what to change.
  if ((status === 400 || status === 403) && lower.includes('location is not supported')) {
    return new ClassifiedProviderError(
      `Gemini is not available in this region (status ${status})`,
      {
        kind: 'auth_invalid',
        cause,
        code: 'location_unsupported',
        action: 'The Gemini API does not serve this region. Set CLAUDE_MEM_PROVIDER to another provider.',
      },
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
    // A request too large for the window is fixed by retiring the
    // conversation, not by the user (#3625).
    return new ClassifiedProviderError(
      `Gemini bad request: ${category}`,
      { kind: category === 'context_limit' ? 'context_overflow' : 'unrecoverable', cause },
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
      parts?: GeminiPart[];
    };
    /** 'STOP', 'MAX_TOKENS', 'SAFETY', … */
    finishReason?: string;
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
  /**
   * The pool's first key. Kept as its own field because everything that only
   * needs to know "is Gemini usable" reads it, and because a single-key install
   * must resolve exactly as it did before the pool existed.
   */
  apiKey: string;
  /**
   * The full rotation pool: `apiKey` followed by CLAUDE_MEM_GEMINI_API_KEYS.
   * Length 1 for every install that has not opted in, which `withKeyPool`
   * treats as a pass-through.
   */
  apiKeys: string[];
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

  protected resolveContextWindow(config: GeminiConfig): Promise<number> {
    return resolveContextWindowTokens('gemini', config.model);
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

  protected async query(
    history: ConversationMessage[],
    config: GeminiConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
  ): Promise<ProviderQueryResult> {
    // Rotation wraps withRetry rather than living inside it: the inner retry
    // still owns transient failures against one key, and this outer sweep moves
    // on only for the kinds that mean the key itself is spent.
    return withKeyPool(
      { poolId: 'gemini', keys: resolvePoolKeys(config), label: 'Gemini' },
      ({ key, poolSize }) => this.queryGeminiMultiTurn(
        history, key, poolSize, config.model, config.rateLimitingEnabled, signal, perAttemptTimeoutMs,
      ),
    );
  }

  private fetchGenerateContent(
    url: string,
    contents: GeminiContent[],
    systemInstruction: string | null,
    maxOutputTokens: number,
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
        // The observer's instructions and schema, anchored (#3868).
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        contents,
        generationConfig: {
          temperature: 0.3,  // Lower temperature for structured extraction
          maxOutputTokens,
        },
      }),
      signal: attemptSignal,
    });
  }

  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    /** Size of the rotation pool this attempt belongs to; 1 means no rotation. */
    poolSize: number,
    model: GeminiModel,
    rateLimitingEnabled: boolean,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
  ): Promise<ProviderQueryResult> {
    // An observer generation's framing prompt goes out as systemInstruction,
    // its user request as the first user turn (anchorFraming, #3868).
    const { system, turns } = this.anchorFraming(history);
    const contents = this.conversationToGeminiContents(turns);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const maxOutputTokens = resolveObserverMaxOutputTokens();

    logger.debug('SDK', `Querying Gemini multi-turn (${model})`, {
      turns: history.length,
      totalChars,
      maxOutputTokens,
    });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    await enforceRateLimitForModel(model, rateLimitingEnabled);

    // Track request-id (best-effort dedup) across retries.
    let priorRequestId: string | null = null;
    // The id of the response actually returned, for the cut-off warning.
    let finalRequestId: string | undefined;

    const data = await withRetry<GeminiResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchGenerateContent(url, contents, system, maxOutputTokens, priorRequestId, attemptSignal);
      } catch (networkError: unknown) {
        // Network failures, aborts, DNS, etc.
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyGeminiError({
          cause: err,
        });
      }

      const requestId = response.headers.get('x-goog-request-id') ?? response.headers.get('x-request-id');
      finalRequestId = requestId ?? undefined;
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
    }, { label: `Gemini ${model}`, abortSignal: signal, perAttemptTimeoutMs, ...(signal ? { maxRetries: 0 } : {}), ...retryPolicyForPool(poolSize) });

    const candidate = data.candidates?.[0];
    const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : undefined;
    // The answer parts, joined — never a leading reasoning part (gemini-answer-text.ts).
    const text = readGeminiAnswerText(candidate?.content?.parts);
    // MAX_TOKENS: the output-token cap cut the reply off. A block cut mid-tag
    // never closes, so the parser drops it. Named before the empty-reply exit
    // so a reply cut off before any text is named too (parity with OpenRouter).
    if (finishReason === 'MAX_TOKENS') {
      logger.warn('SDK', 'Gemini reply was cut off at the output-token limit', {
        model,
        requestId: finalRequestId,
        maxTokens: maxOutputTokens,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
        contentChars: text?.length ?? 0,
        messagesInContext: history.length,
      });
    }

    if (!text) {
      logger.error('SDK', 'Empty response from Gemini');
      return { content: '', ...(finishReason ? { finishReason } : {}) };
    }

    const tokensUsed = data.usageMetadata?.totalTokenCount;

    return {
      content: text,
      tokensUsed,
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
      ...(finishReason ? { finishReason } : {}),
    };
  }

  private getGeminiConfig(): GeminiConfig {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKeys = resolveGeminiKeys(settings);
    // With only the list configured, its first entry becomes the primary so
    // availability checks and error messages keep working unchanged.
    const apiKey = apiKeys[0] ?? '';

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

    return { apiKey, apiKeys, model, rateLimitingEnabled };
  }
}

/**
 * The Gemini keys that may be sent: the primary first, then the rotation list,
 * through the shared cmem key lock. Google is never the cmem gateway, so a
 * cm_pro_ key pasted into either setting is dropped rather than sent as ?key=.
 */
function resolveGeminiKeys(settings: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): string[] {
  const primaryKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';
  return keysForEndpoint(GEMINI_API_URL, buildKeyPool(
    primaryKey,
    settings.CLAUDE_MEM_GEMINI_API_KEYS || getCredential('GEMINI_API_KEYS') || '',
  ));
}

export function isGeminiAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  // A pool-only install (no CLAUDE_MEM_GEMINI_API_KEY, keys supplied as a list)
  // is still available — dispatch must not silently fall through to Claude.
  return resolveGeminiKeys(settings).length > 0;
}

export function isGeminiSelected(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}
