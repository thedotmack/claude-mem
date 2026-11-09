import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterObservationProvider } from '../../../src/server/generation/providers/OpenRouterObservationProvider.js';
import { ServerClassifiedProviderError } from '../../../src/server/generation/providers/shared/error-classification.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

function context(attempts: number): ServerGenerationContext {
  return {
    job: {
      id: 'job-1', projectId: 'project-1', teamId: 'team-1', agentEventId: 'event-1',
      sourceType: 'agent_event', sourceId: 'event-1', serverSessionId: null,
      jobType: 'observation_generate_for_event', status: 'processing',
      idempotencyKey: 'key', bullmqJobId: null, attempts, maxAttempts: 3,
      nextAttemptAtEpoch: null, lockedAtEpoch: null, lockedBy: null,
      completedAtEpoch: null, failedAtEpoch: null, cancelledAtEpoch: null,
      lastError: null, payload: {}, createdAtEpoch: 0, updatedAtEpoch: 0,
    },
    events: [{
      id: 'event-1', projectId: 'project-1', teamId: 'team-1', serverSessionId: null,
      sourceAdapter: 'api', sourceEventId: null, idempotencyKey: 'key',
      eventType: 'tool_use', payload: { tool: 'Bash', output: 'Build completed' },
      metadata: {}, occurredAtEpoch: 0, receivedAtEpoch: 0, createdAtEpoch: 0,
    }],
    project: { projectId: 'project-1', teamId: 'team-1', serverSessionId: null, projectName: 'demo' },
  };
}

const truncated = () => Response.json({
  choices: [{ message: { content: '' }, finish_reason: 'length' }],
  usage: { total_tokens: 40 },
});
const answer = () => Response.json({
  choices: [{ message: { content: '<observation>Kept the answer</observation>' }, finish_reason: 'stop' }],
  usage: { total_tokens: 60 },
});

describe('server reasoning correction shares the job paid-send cap', () => {
  it('does not buy a third request after an ambiguous first job attempt', async () => {
    let requests = 0;
    const provider = new OpenRouterObservationProvider({
      apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gateway.example/v1',
      fetchImpl: (async () => {
        requests++;
        if (requests === 1) return new Response('upstream unavailable', { status: 503 });
        return requests === 2 ? truncated() : answer();
      }) as typeof fetch,
    });

    await assert.rejects(provider.generate(context(1)), error =>
      error instanceof ServerClassifiedProviderError && error.kind === 'transient');
    const result = await provider.generate(context(2));

    assert.equal(requests, 2, 'the second job attempt has spent the remaining paid send');
    assert.equal(result.rawText, '');
    assert.equal(result.tokensUsed, 40);
  });

  it('allows the first attempt one correction and retains both billed token totals', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new OpenRouterObservationProvider({
      apiKey: 'test-key', model: 'test-model', baseUrl: 'https://gateway.example/v1',
      fetchImpl: (async (_url, options) => {
        bodies.push(JSON.parse(String(options?.body)));
        return bodies.length === 1 ? truncated() : answer();
      }) as typeof fetch,
    });

    const result = await provider.generate(context(1));

    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].reasoning, undefined);
    assert.deepEqual(bodies[1].reasoning, { enabled: false });
    assert.equal(result.rawText, '<observation>Kept the answer</observation>');
    assert.equal(result.tokensUsed, 100);
  });
});
