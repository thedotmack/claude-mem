// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from 'bun:test';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';

/**
 * The server factory must FORWARD the operator's cap, not leave the provider
 * on its own 4096 default.
 *
 * `AimlapiObservationProvider` already accepted `maxOutputTokens`; the aimlapi
 * branch of the factory never passed it, unlike every other built-in. So a
 * configured 8192 or 16384 produced requests still capped at 4096, and the
 * operator had no way to stop replies being cut off inside the observation
 * XML — which the response processor rejects and the generation handler marks
 * failed, with no automatic retry.
 */
const KEYS = [
  'CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS',
  'AIMLAPI_API_KEY',
  'CLAUDE_MEM_AIMLAPI_API_KEY',
  'CLAUDE_MEM_SERVER_MODEL',
  'CLAUDE_MEM_AIMLAPI_BASE_URL',
  'AIMLAPI_BASE_URL',
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const CONTEXT = {
  job: {
    id: 'job-1', projectId: 'p', teamId: 't', agentEventId: 'e', sourceType: 'agent_event',
    sourceId: 'e', serverSessionId: null, jobType: 'observation_generate_for_event',
    status: 'processing', idempotencyKey: 'k', bullmqJobId: null, attempts: 1,
    maxAttempts: 3, nextAttemptAtEpoch: null, lockedAtEpoch: null,
  },
  events: [{
    id: 'e', projectId: 'p', teamId: 't', serverSessionId: null, sourceAdapter: 'api',
    sourceEventId: null, idempotencyKey: 'ik-e', eventType: 'tool_use', platformSource: 'claude',
    payload: { tool_name: 'Read' }, metadata: {},
    occurredAtEpoch: 1_700_000_000_000, receivedAtEpoch: 1_700_000_000_000, createdAtEpoch: 1_700_000_000_000,
  }],
  project: { projectId: 'p', teamId: 't' },
};

/** The cap that reaches the wire when the factory builds the provider. */
async function sentCap(configured?: string): Promise<number | undefined> {
  process.env.AIMLAPI_API_KEY = 'test-key-never-leaves-this-process';
  if (configured === undefined) delete process.env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS;
  else process.env.CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS = configured;

  let body: { max_tokens?: number } = {};
  let reached: string | null = null;
  const realFetch = globalThis.fetch;
  // Swapped BEFORE the factory runs: the provider resolves its fetch in the
  // constructor (`options.fetchImpl ?? fetch`), so a later swap would be too
  // late and the request would leave this machine.
  globalThis.fetch = (async (url: string | URL | Request, init?: { body?: string }) => {
    reached = String(url);
    body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '<skip_summary />' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  try {
    const provider = await instantiateServerGenerationProvider('aimlapi');
    expect(provider).not.toBeNull();
    await provider!.generate(CONTEXT as never);
  } finally {
    globalThis.fetch = realFetch;
  }
  // nothing left the process: the stub saw the request
  expect(reached).toBe('https://api.aimlapi.com/v1/chat/completions');
  return body.max_tokens;
}

describe('server aimlapi.com provider honors CLAUDE_MEM_SERVER_MAX_OUTPUT_TOKENS', () => {
  it('keeps the provider default when the setting is unset', async () => {
    expect(await sentCap()).toBe(4096);
  });

  it('sends a configured 16384 instead of the 4096 default', async () => {
    expect(await sentCap('16384')).toBe(16384);
  });

  it('sends a configured 8192', async () => {
    expect(await sentCap('8192')).toBe(8192);
  });

  it('keeps the default for a value that is not a positive integer', async () => {
    expect(await sentCap('lots')).toBe(4096);
  });
});
