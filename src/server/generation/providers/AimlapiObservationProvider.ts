// SPDX-License-Identifier: Apache-2.0

import { AIMLAPI_DEFAULT_MODEL, resolveAimlapiChatCompletionsUrl } from '../../../shared/aimlapi-base-url.js';
import { aimlapiAttributionHeaders, AIMLAPI_APP_URL, AIMLAPI_APP_TITLE } from '../../../shared/aimlapi-attribution.js';
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

export interface AimlapiObservationProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * Optional OpenAI-compatible base URL. When set, requests POST to
   * `<baseUrl>/chat/completions` (or verbatim if it already ends in
   * `/chat/completions`). When unset, the default aimlapi.com endpoint is used.
   */
  baseUrl?: string;
  maxOutputTokens?: number;
  siteUrl?: string;
  appName?: string;
  fetchImpl?: typeof fetch;
}

interface AimlapiResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string };
}

export class AimlapiObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'aimlapi' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiUrl: string;
  private readonly maxOutputTokens: number;
  private readonly siteUrl: string;
  private readonly appName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AimlapiObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('aimlapi.com API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    // Model is passed verbatim so any aimlapi.com model id works.
    this.model = options.model ?? AIMLAPI_DEFAULT_MODEL;
    this.apiUrl = resolveAimlapiChatCompletionsUrl(options.baseUrl);
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.siteUrl = options.siteUrl ?? AIMLAPI_APP_URL;
    this.appName = options.appName ?? AIMLAPI_APP_TITLE;
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
        providerLabel: 'aimlapi.com',
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`aimlapi.com API error: ${response.status} - ${bodyText}`),
        providerLabel: 'aimlapi.com',
      });
    }

    let data: AimlapiResponse;
    try {
      data = (await response.json()) as AimlapiResponse;
    } catch (parseError) {
      const err = parseError instanceof Error ? parseError : new Error(String(parseError));
      throw new ServerClassifiedProviderError('aimlapi.com returned invalid JSON', {
        kind: 'parse_error',
        cause: err,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.code ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`aimlapi.com API error: ${data.error.code} - ${data.error.message}`),
        providerLabel: 'aimlapi.com',
      });
    }

    const rawText = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!rawText) {
      logger.warn('SDK', 'aimlapi.com returned empty content', {
        provider: 'aimlapi',
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
        ...aimlapiAttributionHeaders(this.siteUrl, this.appName),
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
    logger.warn('SDK', 'Failed to read aimlapi.com error response body', { provider: 'aimlapi' }, err);
    return '';
  }
}
