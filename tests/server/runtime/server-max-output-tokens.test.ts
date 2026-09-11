// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'bun:test';
import { resolveServerMaxOutputTokens } from '../../../src/server/runtime/create-server-service.js';
import { OpenRouterObservationProvider } from '../../../src/server/generation/providers/OpenRouterObservationProvider.js';

const KEY = 'CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS';

afterEach(() => {
  delete process.env[KEY];
});

describe('resolveServerMaxOutputTokens', () => {
  it('is undefined when unset, so the provider default is unchanged', () => {
    expect(resolveServerMaxOutputTokens()).toBeUndefined();
  });

  it('reads a positive integer', () => {
    process.env[KEY] = '16384';
    expect(resolveServerMaxOutputTokens()).toBe(16384);
  });

  it('ignores values that are not positive integers rather than sending NaN', () => {
    for (const bad of ['0', '-1', 'lots', '1.5', '']) {
      process.env[KEY] = bad;
      expect(resolveServerMaxOutputTokens()).toBeUndefined();
    }
  });
});

describe('OpenRouterObservationProvider max_tokens', () => {
  async function capture(maxOutputTokens?: number): Promise<number> {
    let body: { max_tokens?: number } = {};
    const provider = new OpenRouterObservationProvider({
      apiKey: 'k',
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      fetchImpl: (async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '<skip_summary />' } }] }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    await provider.generate({
      job: {
        id: 'job-1', projectId: 'p', teamId: 't', agentEventId: 'e', sourceType: 'agent_event',
        sourceId: 'e', serverSessionId: null, jobType: 'observation_generate_for_event',
        status: 'processing', idempotencyKey: 'k', bullmqJobId: null, attempts: 1,
        maxAttempts: 3, nextAttemptAtEpoch: null, lockedAtEpoch: null,
      },
      events: [],
      project: { projectId: 'p', teamId: 't' },
    } as never);
    return body.max_tokens as number;
  }

  it('defaults to 4096', async () => {
    expect(await capture()).toBe(4096);
  });

  it('sends the configured cap instead', async () => {
    expect(await capture(16384)).toBe(16384);
  });
});
