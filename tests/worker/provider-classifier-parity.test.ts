// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { classifyGeminiError } from '../../src/services/worker/GeminiProvider.js';
import { classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';
import { classifyOpenAICompatError } from '../../src/services/worker/OpenAICompatProvider.js';
import { classifyGeminiServerError } from '../../src/server/generation/providers/GeminiObservationProvider.js';
import { classifyHttpProviderError } from '../../src/server/generation/providers/shared/error-classification.js';

/**
 * The worker and the server runtime classify the same provider answers, each
 * with its own error model (src/server may not import from the worker). What
 * they decide must not drift: a per-day cap retried by one and parked by the
 * other spends requests for nothing, and a region refusal read as a refused
 * key by one rotates and parks every pooled key.
 */

const openRouterBody = (message: string) => JSON.stringify({ error: { message, code: 429 } });
const geminiQuota = (...quotaIds: string[]) => JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'You exceeded your current quota, please check your plan and billing details.',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: quotaIds.map(quotaId => ({ quotaId })) },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '6s' },
    ],
  },
});
const geminiRegion = (status: number) => JSON.stringify({
  error: { code: status, message: 'User location is not supported for the API use.', status: status === 400 ? 'FAILED_PRECONDITION' : 'PERMISSION_DENIED' },
});

describe('worker and server agree on provider refusals', () => {
  const openRouterCases: Array<[string, string, string]> = [
    ['a per-day free-model cap', 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', 'quota_exhausted'],
    ['a per-minute free-model limit', 'Rate limit exceeded: free-models-per-min.', 'rate_limit'],
  ];
  for (const [name, message, kind] of openRouterCases) {
    it(`OpenRouter 429: ${name} is ${kind} on both, and on openai-compatible`, () => {
      const bodyText = openRouterBody(message);
      expect(classifyOpenRouterError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
      expect(classifyHttpProviderError({ status: 429, bodyText, cause: new Error('429'), providerLabel: 'OpenRouter' }).kind).toBe(kind);
      // The same answer through the openai-compatible provider (R4-9): as a
      // rate limit, a daily cap was re-probed every 90 seconds until it reset.
      expect(classifyOpenAICompatError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
    });
  }

  const geminiQuotaCases: Array<[string, string, string]> = [
    ['a per-minute window', geminiQuota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), 'rate_limit'],
    ['a per-day window', geminiQuota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'), 'quota_exhausted'],
  ];
  for (const [name, bodyText, kind] of geminiQuotaCases) {
    it(`Gemini 429 naming ${name} is ${kind} on both`, () => {
      expect(classifyGeminiError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
      expect(classifyGeminiServerError({ status: 429, bodyText, cause: new Error('429') }).kind).toBe(kind);
    });
  }

  for (const status of [400, 403]) {
    it(`Gemini region refusal (${status}) is the same refusal on both`, () => {
      const worker = classifyGeminiError({ status, bodyText: geminiRegion(status), cause: new Error(String(status)) });
      const server = classifyGeminiServerError({ status, bodyText: geminiRegion(status), cause: new Error(String(status)) });
      expect(server.kind).toBe(worker.kind);
      expect(server.message).toBe(worker.message);
    });
  }
});
