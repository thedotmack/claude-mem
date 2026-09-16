// SPDX-License-Identifier: Apache-2.0

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

// v1beta is required: current Gemini 3.x models and the `-latest` aliases are
// only served under v1beta, and the retired v1-only 2.x models 404 for new keys.
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// `gemini-flash-latest` is a Google-maintained alias for the current GA Flash
// model, so it stays valid for new API keys instead of pinning a retired ID.
const DEFAULT_MODEL = 'gemini-flash-latest';

export interface GeminiObservationProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
  usageMetadata?: { totalTokenCount?: number };
  error?: { code?: number; status?: string; message?: string };
}

/** A response part. Gemini 3 marks a reasoning part with `thought: true`. */
interface GeminiPart {
  text?: string;
  thought?: boolean;
}

/**
 * The answer's text — not the reasoning that came before it.
 *
 * A response arrives as an ordered list of parts, and when thinking output is
 * included the chain of thought is `parts[0]`, so reading the first part
 * returns the model's private deliberation instead of its answer. Confirmed
 * against the live endpoint: with `thinkingConfig.includeThoughts` a two-part
 * response came back, reasoning first and answer second. An answer can also be
 * split across parts, so the answer parts are joined rather than picked.
 *
 * A response whose every part is reasoning has no answer at all; returning ''
 * lets the caller report the empty response it is, instead of storing
 * deliberation as an observation.
 */
function readAnswerText(parts: GeminiPart[] | undefined): string {
  if (!parts?.length) return '';
  return parts
    .filter((part): part is GeminiPart & { text: string } =>
      part.thought !== true && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
    .trim();
}

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

interface ClassifyGeminiServerErrorInput {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
}

/**
 * A `QuotaFailure` violation naming a window longer than a day. Gemini answers
 * a spent allowance and a momentary throttle identically — 429 with
 * `RESOURCE_EXHAUSTED` — and lists both a per-minute and a per-day violation
 * whenever the period quota is the one that ran out. The named window is what
 * separates "retry shortly" from "stop until the period turns over", so match
 * it on the `quotaId` rather than anywhere in the body.
 */
const PERIOD_QUOTA_WINDOW = /"quotaid"\s*:\s*"[^"]*per(day|week|month)/;

function namesPeriodQuotaWindow(lowerBody: string): boolean {
  return PERIOD_QUOTA_WINDOW.test(lowerBody);
}

/**
 * The retry hint Gemini actually sends. Google omits `Retry-After` on these
 * responses and puts the same information in the body as
 * `google.rpc.RetryInfo.retryDelay` (e.g. "11s"), so the header alone is
 * undefined on every real 429 from this provider.
 */
const BODY_RETRY_DELAY = /"retryDelay"\s*:\s*"([0-9.]+)s"/;

function parseGeminiRetryDelayMs(bodyText: string): number | undefined {
  const match = BODY_RETRY_DELAY.exec(bodyText);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

function isQuotaBody(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota') ||
    lower.includes('resource_exhausted')
  );
}

export function classifyGeminiServerError(input: ClassifyGeminiServerErrorInput): ServerClassifiedProviderError {
  const status = input.status;
  const bodyText = input.bodyText ?? '';

  if (status === 400 && !isQuotaBody(bodyText)) {
    const category = categorizeGeminiBadRequest(bodyText);
    return new ServerClassifiedProviderError(`Gemini bad request: ${category}`, {
      kind: 'unrecoverable',
      cause: new Error('Gemini HTTP error (status 400)'),
    });
  }

  // A 429 is decided BEFORE the shared body markers, because every Gemini 429
  // carries `RESOURCE_EXHAUSTED` whatever it is actually refusing. Letting the
  // marker decide made a per-minute throttle indistinguishable from a spent
  // allowance here, and dropped the retry hint on the floor with it.
  if (status === 429) {
    const retryAfterMs =
      (input.headers ? parseRetryAfterMs(input.headers.get('retry-after')) : undefined)
      ?? parseGeminiRetryDelayMs(bodyText);
    const exhausted = namesPeriodQuotaWindow(bodyText.toLowerCase());
    return new ServerClassifiedProviderError(
      exhausted ? 'Gemini quota exhausted (status 429)' : 'Gemini rate limit (429)',
      {
        kind: exhausted ? 'quota_exhausted' : 'rate_limit',
        cause: new Error('Gemini HTTP error (status 429)'),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }

  return classifyHttpProviderError({
    ...input,
    providerLabel: 'Gemini',
  });
}

export class GeminiObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'gemini' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('Gemini API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
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

    const url = `${GEMINI_API_URL}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    let response: Response;
    try {
      response = await this.postGenerateContent(url, prompt, signal);
    } catch (networkError) {
      const err = networkError instanceof Error ? networkError : new Error(String(networkError));
      throw classifyGeminiServerError({
        cause: err,
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyGeminiServerError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Gemini HTTP error (status ${response.status})`),
      });
    }

    let data: GeminiResponse;
    try {
      data = (await response.json()) as GeminiResponse;
    } catch (parseError) {
      const err = parseError instanceof Error ? parseError : new Error(String(parseError));
      throw new ServerClassifiedProviderError('Gemini returned invalid JSON', {
        kind: 'parse_error',
        cause: err,
      });
    }

    if (data.error) {
      throw classifyGeminiServerError({
        status: response.status,
        bodyText: `${data.error.status ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Gemini HTTP error (status ${response.status})`),
      });
    }

    const rawText = readAnswerText(data.candidates?.[0]?.content?.parts);
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

  private postGenerateContent(url: string, prompt: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: this.maxOutputTokens,
        },
      }),
      signal,
    });
  }
}

// Re-export for tests/auditing parity with worker classifier surface.
export { parseRetryAfterMs };

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (readError) {
    const err = readError instanceof Error ? readError : new Error(String(readError));
    logger.warn('SDK', 'Failed to read Gemini error response body', { provider: 'gemini', status: response.status }, err);
    return '';
  }
}
