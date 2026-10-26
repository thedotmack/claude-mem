// SPDX-License-Identifier: Apache-2.0

// Fail-fast guard for empty assistant responses on the server observer output
// path. An empty rawText used to fall through parseAgentXml and surface as a
// generic 'parse_error' ("parser rejected response"), and the generic Error
// thrown afterwards burned all 3 BullMQ retry attempts on a job whose outbox
// row was already terminally failed. These tests pin the new behavior:
//
//   - processGeneratedResponse / processSessionSummaryResponse detect empty
//     rawText BEFORE parsing and return a distinct 'empty_response' outcome
//     without touching the database.
//   - the generator surfaces terminal outcomes as a bullmq UnrecoverableError
//     subclass so BullMQ fails the job immediately instead of retry fan-out.
//
// These tests deliberately run without CLAUDE_MEM_TEST_POSTGRES_URL: the
// empty-response path must return before any pool usage, which the poisoned
// pool below enforces for real.

import { describe, expect, it } from 'bun:test';
import { UnrecoverableError } from 'bullmq';
import {
  processGeneratedResponse,
  processSessionSummaryResponse,
  type ProcessGeneratedResponseInput,
} from '../../../src/server/generation/processGeneratedResponse.js';
import { ServerGenerationTerminalOutcomeError } from '../../../src/server/generation/ProviderObservationGenerator.js';
import type { PostgresObservationGenerationJob } from '../../../src/storage/postgres/generation-jobs.js';

// Any pool method call means the guard leaked past the early return.
const poisonedPool = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`empty-response guard touched the database (pool.${String(prop)})`);
  },
}) as ProcessGeneratedResponseInput['pool'];

function makeJob(sourceType: PostgresObservationGenerationJob['sourceType']): PostgresObservationGenerationJob {
  return {
    id: 'job-1',
    projectId: 'project-1',
    teamId: 'team-1',
    agentEventId: sourceType === 'agent_event' ? 'event-1' : null,
    sourceType,
    sourceId: 'source-1',
    serverSessionId: sourceType === 'session_summary' ? 'session-1' : null,
    jobType: 'observation_generate_for_event',
    status: 'processing',
    idempotencyKey: 'idem-1',
    bullmqJobId: 'bull-1',
    attempts: 1,
    maxAttempts: 3,
    nextAttemptAtEpoch: null,
    lockedAtEpoch: Date.now(),
    lockedBy: 'test-worker',
    completedAtEpoch: null,
    failedAtEpoch: null,
    cancelledAtEpoch: null,
    lastError: null,
    payload: {},
    createdAtEpoch: Date.now(),
    updatedAtEpoch: Date.now(),
  };
}

function makeInput(rawText: string, sourceType: PostgresObservationGenerationJob['sourceType'] = 'agent_event'): ProcessGeneratedResponseInput {
  return {
    pool: poisonedPool,
    job: makeJob(sourceType),
    rawText,
    providerLabel: 'claude',
  };
}

describe('empty assistant response fail-fast guard', () => {
  it('processGeneratedResponse returns empty_response for an empty rawText without touching the database', async () => {
    const outcome = await processGeneratedResponse(makeInput(''));
    expect(outcome.kind).toBe('empty_response');
    if (outcome.kind === 'empty_response') {
      expect(outcome.jobId).toBe('job-1');
      expect(outcome.reason).toMatch(/empty/i);
    }
  });

  it('processGeneratedResponse treats whitespace-only rawText as empty', async () => {
    const outcome = await processGeneratedResponse(makeInput('  \n\t '));
    expect(outcome.kind).toBe('empty_response');
  });

  it('processSessionSummaryResponse returns empty_response for an empty rawText', async () => {
    const outcome = await processSessionSummaryResponse(makeInput('', 'session_summary'));
    expect(outcome.kind).toBe('empty_response');
  });

  it('non-empty malformed text still classifies as parse_error, not empty_response', async () => {
    const outcome = await processGeneratedResponse(makeInput('not xml at all'));
    expect(outcome.kind).toBe('parse_error');
  });

  it('terminal outcome error is a bullmq UnrecoverableError so BullMQ skips remaining attempts', () => {
    const error = new ServerGenerationTerminalOutcomeError('empty_response', 'generation empty response: provider returned empty content');
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.classification).toBe('empty_response');
    // BullMQ identifies unrecoverable errors by name, so subclassing must not change it.
    expect(error.name).toBe('UnrecoverableError');
  });
});
