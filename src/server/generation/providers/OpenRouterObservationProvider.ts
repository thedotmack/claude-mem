// SPDX-License-Identifier: Apache-2.0

import { resolveOpenRouterChatCompletionsUrl } from '../../../shared/openrouter-base-url.js';
import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import { generateWithEmptyResponseRetry, type RawGenerationResult } from './shared/empty-response.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';

export interface OpenRouterObservationProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * Optional OpenAI-compatible base URL (#2382/#2590/#2622/#2393). When set,
   * requests POST to `<baseUrl>/chat/completions` (or verbatim if it already
   * ends in `/chat/completions`). When unset, the default OpenRouter endpoint
   * is used — behavior unchanged. Examples: https://api.deepseek.com (DeepSeek),
   * http://localhost:1234/v1 (LM Studio), a custom gateway base.
   */
  baseUrl?: string;
  maxOutputTokens?: number;
  /**
   * Optional request-body passthrough (#3630). Merged into the chat-completions
   * request so a gateway that runs reasoning by default can be told to stop,
   * e.g. `{ reasoning: { effort: 'none' } }`. Unset means the body is unchanged.
   */
  providerParams?: Record<string, unknown>;
  siteUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string };
}

export class OpenRouterObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'openrouter' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiUrl: string;
  private readonly maxOutputTokens: number;
  private readonly providerParams?: Record<string, unknown>;
  private readonly siteUrl: string;
  private readonly appName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenRouterObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('OpenRouter API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    // Model is passed verbatim so arbitrary OpenAI-compatible ids work. #2393.
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiUrl = resolveOpenRouterChatCompletionsUrl(options.baseUrl);
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.providerParams = options.providerParams;
    this.siteUrl = options.siteUrl ?? 'https://github.com/thedotmack/claude-mem';
    this.appName = options.appName ?? 'claude-mem';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    // #3630 — an empty HTTP 200 with a `length` finish reason means the budget
    // was spent before any text (e.g. hidden reasoning on a gateway model). The
    // shared shell retries once with a larger budget before giving up.
    return generateWithEmptyResponseRetry(
      { providerLabel: this.providerLabel, modelId: this.model, maxOutputTokens: this.maxOutputTokens },
      budget => this.requestGeneration(prompt, budget, signal),
    );
  }

  private async requestGeneration(
    prompt: string,
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<RawGenerationResult> {
    let response: Response;
    try {
      response = await this.postChatCompletion(prompt, maxOutputTokens, signal);
    } catch (networkError) {
      const err = networkError instanceof Error ? networkError : new Error(String(networkError));
      throw classifyHttpProviderError({
        cause: err,
        providerLabel: 'OpenRouter',
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`OpenRouter API error: ${response.status} - ${bodyText}`),
        providerLabel: 'OpenRouter',
      });
    }

    let data: OpenRouterResponse;
    try {
      data = (await response.json()) as OpenRouterResponse;
    } catch (parseError) {
      const err = parseError instanceof Error ? parseError : new Error(String(parseError));
      throw new ServerClassifiedProviderError('OpenRouter returned invalid JSON', {
        kind: 'parse_error',
        cause: err,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.code ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`OpenRouter API error: ${data.error.code} - ${data.error.message}`),
        providerLabel: 'OpenRouter',
      });
    }

    const choice = data.choices?.[0];
    const rawText = choice?.message?.content?.trim() ?? '';
    const tokensUsed = typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(typeof choice?.finish_reason === 'string' ? { stopReason: choice.finish_reason } : {}),
    };
  }

  private postChatCompletion(prompt: string, maxOutputTokens: number, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': this.siteUrl,
        'X-Title': this.appName,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        ...(this.providerParams ?? {}),
        // Budget last so a passthrough value can't clobber the retry budget.
        max_tokens: maxOutputTokens,
      }),
      signal,
    });
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (readError) {
    const err = readError instanceof Error ? readError : new Error(String(readError));
    logger.warn('SDK', 'Failed to read OpenRouter error response body', { provider: 'openrouter' }, err);
    return '';
  }
}
