// SPDX-License-Identifier: Apache-2.0

import { GoogleAuth } from 'google-auth-library';
import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
  parseRetryAfterMs,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_VERTEX_MODEL = 'gemini-3.1-flash-lite';

export interface VertexConfig {
  project: string;
  location: string;
}

export interface GeminiObservationProviderOptions {
  apiKey?: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
  vertex?: VertexConfig;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: { totalTokenCount?: number };
  error?: { code?: number; status?: string; message?: string };
}

export class GeminiObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'gemini' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly vertex?: VertexConfig;
  private readonly googleAuth?: GoogleAuth;

  constructor(options: GeminiObservationProviderOptions) {
    if (options.vertex) {
      if (!options.vertex.project) {
        throw new ServerClassifiedProviderError('Vertex AI mode requires a GCP project ID', {
          kind: 'auth_invalid',
          cause: new Error('vertex.project is required'),
        });
      }
      this.vertex = options.vertex;
      this.googleAuth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      this.apiKey = '';
    } else {
      if (!options.apiKey) {
        throw new ServerClassifiedProviderError('Gemini API key not configured', {
          kind: 'auth_invalid',
          cause: new Error('apiKey is required when not using Vertex AI'),
        });
      }
      this.apiKey = options.apiKey;
    }
    this.model = options.model ?? (options.vertex ? DEFAULT_VERTEX_MODEL : DEFAULT_MODEL);
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

    let url: string;
    let authHeaders: Record<string, string>;

    if (this.vertex && this.googleAuth) {
      const { project, location } = this.vertex;
      url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(this.model)}:generateContent`;
      const client = await this.googleAuth.getClient();
      const token = await client.getAccessToken();
      if (!token.token) {
        throw new ServerClassifiedProviderError(
          'Failed to obtain Google Cloud access token. Ensure Application Default Credentials are configured.',
          { kind: 'auth_invalid', cause: new Error('No access token returned') },
        );
      }
      authHeaders = { 'Authorization': `Bearer ${token.token}` };
    } else {
      url = `${GEMINI_API_URL}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      authHeaders = {};
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: this.maxOutputTokens,
          },
        }),
        signal,
      });
    } catch (networkError) {
      throw classifyHttpProviderError({
        cause: networkError,
        providerLabel: 'Gemini',
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Gemini API error: ${response.status} - ${bodyText}`),
        providerLabel: 'Gemini',
      });
    }

    let data: GeminiResponse;
    try {
      data = (await response.json()) as GeminiResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('Gemini returned invalid JSON', {
        kind: 'parse_error',
        cause: parseError,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.status ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Gemini API error: ${data.error.status} - ${data.error.message}`),
        providerLabel: 'Gemini',
      });
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (!rawText) {
      logger.warn('SDK', 'Gemini returned empty content', { provider: 'gemini', model: this.model });
    }

    const tokensUsed = typeof data.usageMetadata?.totalTokenCount === 'number'
      ? data.usageMetadata.totalTokenCount
      : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }
}

// Re-export for tests/auditing parity with worker classifier surface.
export { parseRetryAfterMs };

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
