import { resolveMiniMaxChatCompletionsUrl } from '../../../shared/minimax-base-url.js';
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

const DEFAULT_MODEL = 'MiniMax-M3';

export interface MiniMaxObservationProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

interface MiniMaxResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string };
}

export class MiniMaxObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'minimax' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly apiUrl: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MiniMaxObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('MiniMax API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiUrl = resolveMiniMaxChatCompletionsUrl(options.baseUrl);
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
      response = await this.fetchImpl(this.apiUrl, {
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
    } catch (networkError) {
      const err = networkError instanceof Error ? networkError : new Error(String(networkError));
      throw classifyHttpProviderError({ cause: err, providerLabel: 'MiniMax' });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`MiniMax API error: ${response.status}`),
        providerLabel: 'MiniMax',
      });
    }

    let data: MiniMaxResponse;
    try {
      data = await response.json() as MiniMaxResponse;
    } catch (parseError) {
      const err = parseError instanceof Error ? parseError : new Error(String(parseError));
      throw new ServerClassifiedProviderError('MiniMax returned invalid JSON', {
        kind: 'parse_error',
        cause: err,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.code ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`MiniMax API error: ${data.error.code ?? ''}`),
        providerLabel: 'MiniMax',
      });
    }

    const rawText = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!rawText) {
      logger.warn('SDK', 'MiniMax returned empty content', { provider: 'minimax', model: this.model });
    }

    const tokensUsed = typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : undefined;
    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: typeof data.model === 'string' && data.model ? data.model : this.model,
    };
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (readError) {
    const err = readError instanceof Error ? readError : new Error(String(readError));
    logger.warn('SDK', 'Failed to read MiniMax error response body', { provider: 'minimax' }, err);
    return '';
  }
}
