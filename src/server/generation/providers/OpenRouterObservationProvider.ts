// SPDX-License-Identifier: Apache-2.0

import { assistantText } from '../../../shared/assistant-text.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../../shared/openrouter-base-url.js';
import { openRouterAttributionHeaders, OPENROUTER_APP_URL, OPENROUTER_APP_TITLE } from '../../../shared/openrouter-attribution.js';
import { fetchWithOpenRouterTokenCompatibility } from '../../../shared/openrouter-token-compatibility.js';
import { withOpenRouterExtraBody } from '../../../shared/openrouter-extra-body.js';
import { isCmemGatewayUrl } from '../../../shared/cmem-gateway.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
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
import { readCappedErrorBody } from '../../../shared/capped-error-body.js';

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
  siteUrl?: string;
  appName?: string;
  /**
   * CLAUDE_MEM_OPENROUTER_EXTRA_BODY, parsed: provider-specific request fields
   * merged into every request, under the worker's rules (protected fields
   * stay, never sent to the cmem gateway).
   */
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string };
}

export class OpenRouterObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'openrouter' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiUrl: string;
  private readonly maxOutputTokens: number;
  private readonly siteUrl: string;
  private readonly appName: string;
  private readonly extraBody: Record<string, unknown> | undefined;
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
    // Without one, use the worker's OpenRouter default: the old hard-coded
    // 'anthropic/claude-3.5-sonnet' left OpenRouter's catalog, so every
    // unconfigured server-runtime request was rejected.
    this.model = options.model ?? SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL;
    this.apiUrl = resolveOpenRouterChatCompletionsUrl(options.baseUrl);
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.siteUrl = options.siteUrl ?? OPENROUTER_APP_URL;
    this.appName = options.appName ?? OPENROUTER_APP_TITLE;
    this.extraBody = options.extraBody;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll, noEvents } = buildServerGenerationPrompt(context);
    // Nothing was loaded, so there is nothing to summarise and no question to
    // ask a model. Answering it anyway bought `<skip_summary />` and recorded
    // the result as an ordinary completion; the reason below names it instead.
    if (noEvents) {
      return {
        rawText: '<skip_summary reason="no_events_loaded" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }
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

    const rawText = assistantText(data.choices?.[0]?.message?.content, '').trim();
    if (!rawText) {
      logger.warn('SDK', 'OpenRouter returned empty content', {
        provider: 'openrouter',
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
    return fetchWithOpenRouterTokenCompatibility(this.fetchImpl, this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...openRouterAttributionHeaders(this.siteUrl, this.appName),
        'Content-Type': 'application/json',
      },
      signal,
    }, withOpenRouterExtraBody({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      // Ask for one JSON body, as the worker does (#3668). A gateway that
      // streams by default answers with text/event-stream, which
      // response.json() cannot read, and `stream` is protected from the extra
      // body. The cmem gateway never streams unasked; its requests stay as
      // they are.
      ...(isCmemGatewayUrl(this.apiUrl) ? {} : { stream: false }),
    }, this.extraBody, this.apiUrl), this.maxOutputTokens);
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await readCappedErrorBody(response);
  } catch (readError) {
    const err = readError instanceof Error ? readError : new Error(String(readError));
    logger.warn('SDK', 'Failed to read OpenRouter error response body', { provider: 'openrouter' }, err);
    return '';
  }
}
