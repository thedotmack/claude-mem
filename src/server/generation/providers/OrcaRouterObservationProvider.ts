// SPDX-License-Identifier: Apache-2.0

import { resolveOrcaRouterChatCompletionsUrl } from '../../../shared/orcarouter-base-url.js';
import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const DEFAULT_MODEL = 'openai/gpt-4o-mini';

export interface OrcaRouterObservationProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * Optional OpenAI-compatible base URL. When set, requests POST to
   * `<baseUrl>/chat/completions` (or verbatim if it already ends in
   * `/chat/completions`). When unset, the default OrcaRouter endpoint is used.
   */
  baseUrl?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

interface OrcaRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string };
}

export class OrcaRouterObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'orcarouter' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiUrl: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OrcaRouterObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('OrcaRouter API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    // Model is passed verbatim so arbitrary OpenAI-compatible ids work.
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiUrl = resolveOrcaRouterChatCompletionsUrl(options.baseUrl);
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
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

    let response: Response;
    try {
      response = await this.postChatCompletion(prompt, signal);
    } catch (networkError) {
      const err = networkError instanceof Error ? networkError : new Error(String(networkError));
      throw classifyHttpProviderError({
        cause: err,
        providerLabel: 'OrcaRouter',
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`OrcaRouter API error: ${response.status} - ${bodyText}`),
        providerLabel: 'OrcaRouter',
      });
    }

    let data: OrcaRouterResponse;
    try {
      data = (await response.json()) as OrcaRouterResponse;
    } catch (parseError) {
      const err = parseError instanceof Error ? parseError : new Error(String(parseError));
      throw new ServerClassifiedProviderError('OrcaRouter returned invalid JSON', {
        kind: 'parse_error',
        cause: err,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.code ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`OrcaRouter API error: ${data.error.code} - ${data.error.message}`),
        providerLabel: 'OrcaRouter',
      });
    }

    const rawText = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!rawText) {
      logger.warn('SDK', 'OrcaRouter returned empty content', {
        provider: 'orcarouter',
        model: this.model,
      });
    }

    const tokensUsed = typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }

  private postChatCompletion(prompt: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: this.maxOutputTokens,
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
    logger.warn('SDK', 'Failed to read OrcaRouter error response body', { provider: 'orcarouter' }, err);
    return '';
  }
}
