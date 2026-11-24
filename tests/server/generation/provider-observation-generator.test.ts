// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import type { ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import { ServerClassifiedProviderError } from '../../../src/server/generation/providers/shared/error-classification.js';
import { Job } from 'bullmq';
import type { GenerateObservationsForEventJob } from '../../../src/server/jobs/types.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier } from '../../sdk/pg-isolation.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

class StubProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  calls = 0;

  constructor(private readonly response: string | Error) {}

  async generate() {
    this.calls += 1;
    if (this.response instanceof Error) throw this.response;
    return { rawText: this.response, providerLabel: this.providerLabel };
  }
}

describe('ProviderObservationGenerator', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;

  beforeEach(async () => {
    // The generation path reads the active ModeManager mode; load it so this
    // file runs standalone instead of relying on another test file's side effect.
    ModeManager.getInstance().loadMode('code');
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_phase5_gen');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);


    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 1 },
      occurredAt: new Date(),
    });
    eventId = event.id;
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
    });
    jobId = job.id;
  });

  afterEach(async () => {
    if (client) {
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      } catch {}
      client.release();
    }
    await pool.end();
  });

  function makeJob(): Job<GenerateObservationsForEventJob> {
    return {
      id: 'bull-1',
      data: {
        kind: 'event',
        team_id: teamId,
        project_id: projectId,
        source_type: 'agent_event',
        source_id: eventId,
        generation_job_id: jobId,
        agent_event_id: eventId,
        api_key_id: null,
        actor_id: null,
        source_adapter: 'api',
      },
    } as unknown as Job<GenerateObservationsForEventJob>;
  }

  // A real BullMQ Job with no Redis behind it, carrying the attempts and
  // backoff ServerJobQueue.add sends, so a test can ask BullMQ's own retry
  // decision whether the job would be delivered again.
  function makeBullmqJob(): Job<GenerateObservationsForEventJob> {
    const queue = { opts: {}, keys: {}, toKey: (type: string) => type };
    return new Job(queue as never, 'server_beta_generate_event', makeJob().data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    }, 'bull-1');
  }

  function bullmqRetryDecision(job: Job, error: unknown): Promise<[boolean, number]> {
    return (job as unknown as { shouldRetryJob(err: unknown): Promise<[boolean, number]> }).shouldRetryJob(error);
  }

  async function failWith(providerError: ServerClassifiedProviderError) {
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]['pool'],
      provider: new StubProvider(providerError),
    });
    const job = makeBullmqJob();
    // The job has no Redis behind it: record the delay it is asked for.
    const delayedBy: Array<{ ms: number; token: string | undefined }> = [];
    job.moveToDelayed = async (timestamp: number, token?: string) => {
      delayedBy.push({ ms: timestamp - Date.now(), token });
    };
    const rejection = await generator.process(job, 'worker-token').then(() => null, (error: unknown) => error);
    const reloaded = await storage.observationGenerationJobs.getByIdForScope({ id: jobId, projectId, teamId });
    return { rejection, status: reloaded?.status, retry: await bullmqRetryDecision(job, rejection), delayedBy };
  }

  it('keeps BullMQ from redelivering a job whose provider error left the row failed', async () => {
    const authError = new ServerClassifiedProviderError('openrouter auth error (status 401)', {
      kind: 'auth_invalid',
      cause: null,
    });
    const result = await failWith(authError);

    expect(result.rejection).toBe(authError);
    expect(result.status).toBe('failed');
    // Redelivered, the job finds its row terminal and returns normally, which
    // BullMQ records as a completed job.
    expect(result.retry).toEqual([false, 0]);
  });

  it('leaves a job whose row went back to queued to the BullMQ backoff', async () => {
    const rateLimit = new ServerClassifiedProviderError('openrouter rate limit (429)', {
      kind: 'rate_limit',
      cause: null,
    });
    const result = await failWith(rateLimit);

    expect(result.rejection).toBe(rateLimit);
    expect(result.status).toBe('queued');
    expect(result.retry).toEqual([true, 5000]);
    expect(result.delayedBy).toEqual([]);
  });

  // Gemini's free tier answers a per-minute 429 with RetryInfo.retryDelay. The
  // BullMQ backoff (5s, then 10s) spends all three attempts inside that window.
  it('delays a rate-limited job by the wait the provider asked for', async () => {
    const rateLimit = new ServerClassifiedProviderError('Gemini rate limit (429)', {
      kind: 'rate_limit',
      cause: null,
      retryAfterMs: 34_000,
    });
    const result = await failWith(rateLimit);

    expect(result.status).toBe('queued');
    expect(result.delayedBy.length).toBe(1);
    expect(result.delayedBy[0]!.token).toBe('worker-token');
    expect(result.delayedBy[0]!.ms).toBeGreaterThan(33_000);
    expect(result.delayedBy[0]!.ms).toBeLessThanOrEqual(34_000);
    // BullMQ leaves a job alone when its processor throws a DelayedError.
    expect((result.rejection as Error).name).toBe('DelayedError');
    expect((result.rejection as Error).message).toContain('Gemini rate limit (429)');
  });

  it('caps the wait it takes from a rate limit', async () => {
    const rateLimit = new ServerClassifiedProviderError('openrouter rate limit (429)', {
      kind: 'rate_limit',
      cause: null,
      retryAfterMs: 3_600_000,
    });
    const result = await failWith(rateLimit);

    expect(result.status).toBe('queued');
    expect(result.delayedBy.length).toBe(1);
    expect(result.delayedBy[0]!.ms).toBeGreaterThan(59_000);
    expect(result.delayedBy[0]!.ms).toBeLessThanOrEqual(60_000);
  });

  // A delayed delivery does not use one of BullMQ's attempts, so the row's
  // max_attempts is what ends a rate limit that never clears.
  it('stops delaying a rate-limited job once the row has used its attempts', async () => {
    const rateLimit = new ServerClassifiedProviderError('Gemini rate limit (429)', {
      kind: 'rate_limit',
      cause: null,
      retryAfterMs: 34_000,
    });
    const provider = new StubProvider(rateLimit);
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]['pool'],
      provider,
    });
    // One BullMQ job, delivered again after each delay.
    const job = makeBullmqJob();
    let delays = 0;
    job.moveToDelayed = async () => { delays += 1; };
    const reload = () => storage.observationGenerationJobs.getByIdForScope({ id: jobId, projectId, teamId });
    const maxAttempts = (await reload())!.maxAttempts;
    expect(maxAttempts).toBe(3);

    const deliveries: Array<{ error: string; status: string | undefined; attempts: number | undefined; delays: number }> = [];
    let lastRejection: unknown = null;
    for (let delivery = 1; delivery <= maxAttempts; delivery++) {
      lastRejection = await generator.process(job, 'worker-token').then(() => null, (error: unknown) => error);
      const row = await reload();
      deliveries.push({ error: (lastRejection as Error).name, status: row?.status, attempts: row?.attempts, delays });
    }

    expect(deliveries).toEqual([
      { error: 'DelayedError', status: 'queued', attempts: 1, delays: 1 },
      { error: 'DelayedError', status: 'queued', attempts: 2, delays: 2 },
      // The last attempt: the row is failed, nothing is delayed, and the
      // provider error itself reaches BullMQ.
      { error: 'ServerClassifiedProviderError', status: 'failed', attempts: 3, delays: 2 },
    ]);
    expect(lastRejection).toBe(rateLimit);
    expect(provider.calls).toBe(3);
    // BullMQ counted none of the delayed deliveries, so only the discard
    // keeps it from delivering the job a fourth time.
    expect(job.attemptsMade).toBe(0);
    expect(await bullmqRetryDecision(job, lastRejection)).toEqual([false, 0]);
  });

  it('does not delay a job whose error is not retried', async () => {
    const quota = new ServerClassifiedProviderError('Gemini quota exhausted (status 429)', {
      kind: 'quota_exhausted',
      cause: null,
      retryAfterMs: 11_000,
    });
    const result = await failWith(quota);

    expect(result.rejection).toBe(quota);
    expect(result.status).toBe('failed');
    expect(result.delayedBy).toEqual([]);
    expect(result.retry).toEqual([false, 0]);
  });

  it('fails fast with an UnrecoverableError when provider returns an empty response', async () => {
    const provider = new StubProvider('');
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    // UnrecoverableError name is what makes BullMQ skip its remaining retry
    // attempts instead of re-dispatching a job whose outbox row is terminal.
    const rejection = await generator.process(makeJob()).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(rejection).not.toBeNull();
    expect(rejection?.name).toBe('UnrecoverableError');
    expect(rejection?.message).toMatch(/empty response/);
    expect(provider.calls).toBe(1);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.lastError?.classification).toBe('empty_response');
  });

  it('marks a job as failed (no retry) when provider returns malformed XML', async () => {
    const provider = new StubProvider('not xml at all');
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('failed');
  });

  it('times out a hung provider call and requeues it as transient (#4100)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const provider: ServerGenerationProvider = {
      providerLabel: 'openrouter',
      generate(_context, signal) {
        receivedSignal = signal;
        // Never resolves on its own; settles only when the signal aborts,
        // mirroring fetch()/response.json() in the real providers.
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]['pool'],
      provider,
      providerTimeoutMs: 50,
    });

    await expect(generator.process(makeJob())).rejects.toThrow(/timed out after 50ms/);
    expect(receivedSignal?.aborted).toBe(true);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('queued');
    expect(reloaded?.lastError).toMatchObject({ classification: 'transient' });
  });
});
