import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { RateLimitTracker } from './gemini/RateLimitTracker.js';
import { DynamicModelRegistry } from './gemini/DynamicModelRegistry.js';
import { GeminiStatusBroadcaster } from './gemini/GeminiStatusBroadcaster.js';
import { DEFAULT_MODEL_CASCADE } from './gemini/model-cascade.js';

// v1beta is required: the current Gemini 3.x models, Gemma models, and the Google-maintained
// `-latest` aliases are exposed under v1beta.
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
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;
  const cause = status === undefined
    ? input.cause
    : new Error(`Gemini HTTP error (status ${status}${input.requestId ? `, request ${input.requestId}` : ''})`);

  // Distinguish daily/total quota from minute-level rate limits
  if (lower.includes('quota exceeded') || lower.includes('resource_exhausted')) {
    if (lower.includes('per day') || lower.includes('daily') || lower.includes('rpd')) {
      return new ClassifiedProviderError(
        `Gemini daily quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
        { kind: 'quota_exhausted', cause },
      );
    }
    return new ClassifiedProviderError(
      'Gemini rate limit / quota exceeded',
      { kind: 'rate_limit', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'Gemini rate limit (429)',
      { kind: 'rate_limit', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    if (lower.includes('api key not valid') || lower.includes('api_key_invalid') || lower.includes('api key expired')) {
      return new ClassifiedProviderError(
        `Gemini auth invalid (status ${status})`,
        { kind: 'auth_invalid', cause },
      );
    }
    if (
      lower.includes('location is not supported') ||
      lower.includes('permission denied for models') ||
      lower.includes('not enabled for this model') ||
      lower.includes('restricted') ||
      lower.includes('waitlist')
    ) {
      return new ClassifiedProviderError(
        `Gemini model restricted (status ${status}): ${body}`,
        { kind: 'model_restricted', cause },
      );
    }
    return new ClassifiedProviderError(
      `Gemini auth error (status ${status})`,
      { kind: 'auth_invalid', cause },
    );
  }

  if (status === 422 || lower.includes('unprocessable')) {
    return new ClassifiedProviderError(
      `Gemini unprocessable entity (422): ${body}`,
      { kind: 'model_incompatible', cause },
    );
  }

  if (status === 400) {
    const category = categorizeGeminiBadRequest(body);
    const kind = category === 'model_unsupported'
      ? 'model_unsupported'
      : category === 'context_limit'
      ? 'context_limit'
      : 'unrecoverable';
    return new ClassifiedProviderError(
      `Gemini bad request: ${category}`,
      { kind, cause },
    );
  }

  if (status === 503 || lower.includes('model is overloaded') || lower.includes('overloaded')) {
    return new ClassifiedProviderError(
      `Gemini model overloaded (status ${status ?? 503}): ${body}`,
      { kind: 'model_overloaded', cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `Gemini upstream error (status ${status})`,
      { kind: 'transient', cause },
    );
  }

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

export interface GeminiConfig {
  apiKey: string;
  model: string;
  rateLimitingEnabled: boolean;
  autoFallback: boolean;
}

export class GeminiProvider extends OpenAICompatibleProvider<GeminiConfig> {
  protected readonly providerName = 'Gemini';
  protected readonly syntheticIdPrefix = 'gemini';
  protected readonly forwardEmptyMessageResponse = false;
  private tracker: RateLimitTracker;
  private registry: DynamicModelRegistry;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
    this.tracker = RateLimitTracker.getInstance();
    this.registry = DynamicModelRegistry.getInstance();
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
    return this.executeWithDynamicCascade(history, config, signal);
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
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      }),
      signal: attemptSignal,
    });
  }

  /**
   * Execute request with dynamic rate limiting, predictive demotion,
   * reactive fallback on 429, and automatic promotion when capacity frees up.
   */
  private async executeWithDynamicCascade(
    history: ConversationMessage[],
    config: GeminiConfig,
    signal?: AbortSignal
  ): Promise<ProviderQueryResult> {
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.max(100, Math.ceil(totalChars / 4));
    const contents = this.conversationToGeminiContents(history);

    const maxAttempts = config.autoFallback ? 4 : 1;
    let currentModelId = config.model;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Predictive selection: check capacity of preferred model vs cascade
      let targetModelId = currentModelId;
      if (config.rateLimitingEnabled) {
        const selection = this.tracker.selectBestAvailableModel(currentModelId, estimatedTokens);
        targetModelId = selection.selectedModel.id;

        if (selection.waitMs > 0) {
          const waitSec = Math.ceil(selection.waitMs / 1000);
          logger.info('SDK', `All models rate-limited; pausing queue for ${waitSec}s...`, {
            model: targetModelId,
            waitMs: selection.waitMs
          });
          this.tracker.updateQueueState({ isWaitingForQuota: true, quotaWaitRemainingMs: selection.waitMs });
          GeminiStatusBroadcaster.getInstance().broadcastQueuePaused(waitSec, selection.reason ?? 'rate_limit');

          await new Promise(resolve => setTimeout(resolve, Math.min(60_000, selection.waitMs)));

          this.tracker.updateQueueState({ isWaitingForQuota: false, quotaWaitRemainingMs: 0 });
          GeminiStatusBroadcaster.getInstance().broadcastQueueResumed();
        }
      }

      logger.debug('SDK', `Querying Gemini dynamic cascade (model: ${targetModelId}, attempt: ${attempt})`, {
        turns: history.length,
        totalChars,
        estimatedTokens
      });

      const url = `${GEMINI_API_URL}/${targetModelId}:generateContent?key=${config.apiKey}`;
      let priorRequestId: string | null = null;

      try {
        const data = await withRetry<GeminiResponse>(async (attemptSignal) => {
          let response: Response;
          try {
            response = await this.fetchGenerateContent(url, contents, priorRequestId, attemptSignal);
          } catch (networkError: unknown) {
            const err = networkError instanceof Error ? networkError : new Error(String(networkError));
            throw classifyGeminiError({ cause: err });
          }

          const requestId = response.headers.get('x-goog-request-id') ?? response.headers.get('x-request-id');
          if (requestId) {
            priorRequestId = requestId;
          }

          if (!response.ok) {
            const errorBody = await response.text();
            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

            const classified = classifyGeminiError({
              status: response.status,
              bodyText: errorBody,
              headers: response.headers,
              cause: new Error(`Gemini API error (status ${response.status})`),
              ...(requestId ? { requestId } : {}),
            });

            const errorLower = errorBody.toLowerCase();
            const badReqCategory = response.status === 400 ? categorizeGeminiBadRequest(errorBody) : null;
            const isModelSpecific403 = response.status === 403 &&
              (errorLower.includes('location is not supported') ||
                errorLower.includes('permission denied for models') ||
                errorLower.includes('not enabled for this model') ||
                errorLower.includes('restricted') ||
                errorLower.includes('waitlist'));

            const isCascadeTrigger =
              response.status === 429 ||
              response.status === 404 ||
              response.status === 422 ||
              response.status === 503 ||
              errorLower.includes('model is overloaded') ||
              (response.status === 400 && (badReqCategory === 'model_unsupported' || badReqCategory === 'context_limit')) ||
              isModelSpecific403;

            // If a fallback model is available, error is a cascade trigger, and auto-fallback is enabled, signal fallback
            if (config.autoFallback && isCascadeTrigger) {
              const failureAnalysis = this.tracker.recordRequestFailure(
                targetModelId,
                response.status,
                errorBody,
                retryAfterMs
              );

              if (failureAnalysis.fallbackRecommended && failureAnalysis.nextModel) {
                const fallbackErr = new Error(`FALLBACK_TO_${failureAnalysis.nextModel.id}`);
                (fallbackErr as any).isFallback = true;
                (fallbackErr as any).nextModelId = failureAnalysis.nextModel.id;
                (fallbackErr as any).reason = failureAnalysis.reason ?? 'Cascaded to next model';
                (fallbackErr as any).lastError = classified;
                throw fallbackErr;
              }
            }

            throw classified;
          }

          return await response.json() as GeminiResponse;
        }, { label: `Gemini ${targetModelId}` });

        const finishReason = (data as any)?.candidates?.[0]?.finishReason;
        const promptFeedback = (data as any)?.promptFeedback;
        const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const isSafetyBlocked = (finishReason === 'SAFETY' || promptFeedback?.blockReason === 'SAFETY') && !textContent;

        if (config.autoFallback && isSafetyBlocked) {
          const failureAnalysis = this.tracker.recordRequestFailure(
            targetModelId,
            200,
            'Blocked by safety filters'
          );
          if (failureAnalysis.fallbackRecommended && failureAnalysis.nextModel) {
            const fallbackErr = new Error(`FALLBACK_TO_${failureAnalysis.nextModel.id}`);
            (fallbackErr as any).isFallback = true;
            (fallbackErr as any).nextModelId = failureAnalysis.nextModel.id;
            (fallbackErr as any).reason = 'Blocked by safety filters';
            (fallbackErr as any).lastError = new ClassifiedProviderError(
              `Gemini output blocked by safety filters on ${targetModelId}`,
              { kind: 'unrecoverable', cause: new Error('Safety block') }
            );
            throw fallbackErr;
          }
        }

        const content = textContent;
        const tokensUsed = data.usageMetadata?.totalTokenCount ?? estimatedTokens;

        // Record real token usage and successful request in tracker
        this.tracker.recordRequestSuccess(targetModelId, tokensUsed);

        return {
          content,
          tokensUsed,
          inputTokens: data.usageMetadata?.promptTokenCount,
          outputTokens: data.usageMetadata?.candidatesTokenCount,
          servedModel: targetModelId,
        };
      } catch (err: unknown) {
        const lastErr = (err as any)?.lastError ?? err;
        // Reactive fallback trigger
        if ((err as any)?.isFallback && (err as any)?.nextModelId) {
          const nextModel = (err as any).nextModelId;
          const fallbackReason = (err as any)?.reason ?? 'Rate limit exceeded (429)';
          logger.info('SDK', `Reactive cascade switch: ${targetModelId} -> ${nextModel} (${fallbackReason})`);
          GeminiStatusBroadcaster.getInstance().broadcastModelSwitched(
            targetModelId,
            nextModel,
            fallbackReason
          );
          currentModelId = nextModel;
          if (attempt === maxAttempts) {
            throw lastErr;
          }
          continue; // Retry with next model
        }

        throw lastErr;
      }
    }

    throw new Error('Gemini cascade exhausted all available models without success.');
  }

  private getGeminiConfig(): GeminiConfig {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';
    const defaultModel = 'auto';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;

    // Trigger non-blocking dynamic discovery if key is present, model is 'auto', and not in test environment
    if (apiKey && configuredModel === 'auto' && process.env.NODE_ENV !== 'test' && !process.env.BUN_TEST) {
      void this.registry.discoverModels(apiKey).catch(() => {});
    }

    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';
    const autoFallback = (settings as any).CLAUDE_MEM_GEMINI_AUTO_FALLBACK !== 'false';

    this.tracker.setAutoFallback(autoFallback);
    if (configuredModel !== 'auto') {
      this.tracker.setActiveModel(configuredModel);
    }

    return { apiKey, model: configuredModel, rateLimitingEnabled, autoFallback };
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
