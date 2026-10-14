// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type pg from 'pg';
import type { Job } from 'bullmq';
import type { GenerateObservationsForEventJob } from '../../../src/server/jobs/types.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import type { PostgresPool } from '../../../src/storage/postgres/pool.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import type { PostgresObservationGenerationJob } from '../../../src/storage/postgres/generation-jobs.js';
import {
  markGenerationFailed,
  processGeneratedResponse,
  processSessionSummaryResponse,
} from '../../../src/server/generation/processGeneratedResponse.js';
import { reclaimStaleProcessingJobs } from '../../../src/server/generation/reclaimStaleProcessingJobs.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, dropSchema, poolForSchema } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const xml = (title: string) => `<observation><type>discovery</type><title>${title}</title><facts><fact>${title}</fact></facts></observation>`;

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('generation attempt ownership', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schema: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    ModeManager.getInstance().loadMode('code');
    schema = await createIsolatedSchema(databaseUrl, 'cm_attempt');
    pool = poolForSchema(databaseUrl, schema);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);
    teamId = (await storage.teams.create({ name: 'team' })).id;
    projectId = (await storage.projects.create({ teamId, name: 'project' })).id;
  });

  afterEach(async () => {
    await pool.end();
    await dropSchema(databaseUrl, schema);
  });

  async function createJob(summary = false) {
    const session = await storage.sessions.create({
      teamId, projectId, contentSessionId: crypto.randomUUID(), agentId: 'agent', platformSource: 'api',
    });
    const event = await storage.agentEvents.create({
      teamId, projectId, serverSessionId: session.id, sourceAdapter: 'api', eventType: 'tool_use',
      payload: { tool: 'bash', result: 'deployment now uses the new endpoint' }, occurredAt: new Date(),
    });
    return storage.observationGenerationJobs.create({
      teamId, projectId, sourceType: summary ? 'session_summary' : 'agent_event',
      sourceId: summary ? session.id : event.id, agentEventId: summary ? null : event.id,
      serverSessionId: session.id, jobType: summary ? 'observation_generate_session_summary' : 'observation_generate_for_event',
      bullmqJobId: `bull-${event.id}`,
    });
  }

  function reload(job: PostgresObservationGenerationJob) {
    return storage.observationGenerationJobs.getByIdForScope({ id: job.id, projectId, teamId });
  }

  async function claim(job: PostgresObservationGenerationJob) {
    return (await storage.observationGenerationJobs.transitionStatus({
      id: job.id, projectId, teamId, status: 'processing', lockedBy: 'same-worker',
    }))!;
  }

  // Backdate BEFORE taking the worker's snapshot: its snapshot and the row
  // represent the same lease, as they would after a suspended worker resumes.
  async function staleClaim(job: PostgresObservationGenerationJob) {
    await claim(job);
    await pool.query("UPDATE observation_generation_jobs SET locked_at = now() - interval '20 minutes' WHERE id = $1", [job.id]);
    return (await reload(job))!;
  }

  function reclaim() {
    return reclaimStaleProcessingJobs({
      pool, staleAfterMs: 15 * 60 * 1000,
      resolveQueue: () => ({ add: async () => {}, remove: async () => {} }),
    });
  }

  async function write(job: PostgresObservationGenerationJob, title: string) {
    const input = { pool, job, rawText: xml(title), providerLabel: 'test' };
    return job.sourceType === 'session_summary'
      ? processSessionSummaryResponse(input)
      : processGeneratedResponse(input);
  }

  it('preserves completion replay and cancellation without writing extra memory', async () => {
    const current = await claim(await createJob());
    await write(current, 'retained memory');
    await write(current, 'duplicate response');
    const cancelled = await claim(await createJob());
    await storage.observationGenerationJobs.transitionStatus({ id: cancelled.id, teamId, projectId, status: 'cancelled' });
    await write(cancelled, 'cancelled response');
    await markGenerationFailed({ pool, job: cancelled, expectedAttempt: cancelled, reason: 'late error', retryable: false });
    expect((await reload(cancelled))?.status).toBe('cancelled');
    const memories = await storage.observations.listByProject({ projectId, teamId });
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toContain('retained memory');
  });

  it('keeps current-attempt retries and pre-claim rejection working', async () => {
    const current = await claim(await createJob());
    await markGenerationFailed({ pool, job: current, expectedAttempt: current, reason: 'current error', retryable: true });
    expect((await reload(current))?.status).toBe('queued');
    const unclaimed = await createJob();
    await markGenerationFailed({ pool, job: unclaimed, reason: 'revoked key', retryable: false });
    expect((await reload(unclaimed))?.status).toBe('failed');
  });

  it('still rejects a valid lease used with another tenant scope', async () => {
    const current = await claim(await createJob());
    const wrongScope = { ...current, teamId: crypto.randomUUID() };
    await expect(write(wrongScope, 'wrong scope')).rejects.toThrow('not found in scope');
    await markGenerationFailed({ pool, job: wrongScope, expectedAttempt: wrongScope, reason: 'wrong scope', retryable: false });
    expect(await reload(current)).toEqual(current);
    expect(await storage.observations.listByProject({ projectId, teamId })).toEqual([]);
  });

  for (const summary of [false, true]) {
    it(`discards an old ${summary ? 'summary' : 'event'} response after reclaim and lets the new attempt retain its memory`, async () => {
      const old = await staleClaim(await createJob(summary));
      expect(await reclaim()).toEqual({ requeued: 1, failed: 0 });
      const current = await claim(old);

      await write(old, 'old interpretation');
      expect((await reload(old))?.status).toBe('processing');
      expect(await storage.observations.listByProject({ projectId, teamId })).toHaveLength(0);
      expect((await pool.query('SELECT action FROM audit_log')).rows).toEqual([]);

      const result = await write(current, 'current interpretation');
      expect(result.kind).toBe('completed');
      const memories = await storage.observations.listByProject({ projectId, teamId });
      expect(memories).toHaveLength(1);
      expect(memories[0]!.content).toContain('current interpretation');
      expect((await reload(old))?.status).toBe('completed');
      const sources = await pool.query('SELECT generation_job_id FROM observation_sources');
      expect(sources.rows).toEqual([{ generation_job_id: old.id }]);
      const completions = await pool.query("SELECT attempt FROM observation_generation_job_events WHERE event_type = 'completed'");
      expect(completions.rows).toEqual([{ attempt: current.attempts }]);
      const audit = await pool.query('SELECT action FROM audit_log ORDER BY action');
      expect(audit.rows).toEqual([{ action: 'generation_job.completed' }, { action: 'observation.created' }]);
    });
  }

  for (const retryable of [false, true]) {
    it(`ignores an old ${retryable ? 'retryable' : 'terminal'} failure after a new attempt takes ownership`, async () => {
      const old = await staleClaim(await createJob());
      await reclaim();
      const current = await claim(old);

      await markGenerationFailed({ pool, job: old, expectedAttempt: old, reason: 'old failure', retryable });
      expect(await reload(old)).toEqual(current);
      const failures = await pool.query("SELECT event_type FROM observation_generation_job_events WHERE event_type IN ('failed', 'retry_scheduled')");
      expect(failures.rows).toEqual([]);
      await write(current, 'current memory');
      expect((await reload(old))?.status).toBe('completed');
    });
  }

  it('leaves a reclaimed job queued when the old response and failure arrive before replacement', async () => {
    const old = await staleClaim(await createJob());
    await reclaim();
    const queued = await reload(old);
    expect((await write(old, 'stale memory')).kind).toBe('superseded');
    await markGenerationFailed({ pool, job: old, expectedAttempt: old, reason: 'stale error', retryable: false });
    expect(await reload(old)).toEqual(queued);
    expect(await storage.observations.listByProject({ projectId, teamId })).toEqual([]);
  });

  it('distinguishes locks when operator retry reuses the worker and attempt, even within one millisecond', async () => {
    const job = await createJob();
    await claim(job);
    await pool.query(`UPDATE observation_generation_jobs SET attempts = max_attempts,
      locked_at = '2026-01-01 00:00:00.000001+00' WHERE id = $1`, [job.id]);
    const old = (await reload(job))!;
    expect(await reclaim()).toEqual({ requeued: 0, failed: 1 });
    // The operator retry routes reset an exhausted counter to max_attempts-1.
    await pool.query(`UPDATE observation_generation_jobs SET status = 'queued',
      attempts = LEAST(attempts, max_attempts - 1) WHERE id = $1`, [job.id]);
    await claim(job);
    await pool.query(`UPDATE observation_generation_jobs SET
      locked_at = '2026-01-01 00:00:00.000002+00' WHERE id = $1`, [job.id]);
    const current = (await reload(job))!;
    expect(current.attempts).toBe(old.attempts);
    expect(current.lockedBy).toBe(old.lockedBy);
    expect(current.lockedAtEpoch).toBe(old.lockedAtEpoch);
    expect((await write(old, 'stale interpretation')).kind).toBe('superseded');
    await markGenerationFailed({ pool, job: old, expectedAttempt: old, reason: 'stale error', retryable: false });
    expect(await reload(job)).toEqual(current);
    await write(current, 'current interpretation');
    expect((await storage.observations.listByProject({ projectId, teamId }))[0]!.content).toContain('current interpretation');
  });

  for (const fail of [false, true]) {
    it(`holds ownership through the ${fail ? 'failure' : 'memory'} transaction while another stale job remains reclaimable`, async () => {
      const owner = await staleClaim(await createJob());
      const other = await staleClaim(await createJob());
      const read = barrier();
      const resume = barrier();
      // Pause AFTER the real SELECT returns. The sweeper uses a separate
      // connection, so this proves ownership cannot change in the commit gap.
      const gatedPool = {
        connect: async () => {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            query: async (text: string, values?: unknown[]) => {
              const result = await client.query(text, values);
              if (/SELECT[\s\S]*FROM observation_generation_jobs/.test(text)) {
                read.release();
                await resume.promise;
              }
              return result;
            },
          };
        },
      } as PostgresPool;
      const writing = fail
        ? markGenerationFailed({ pool: gatedPool, job: owner, expectedAttempt: owner, reason: 'current failure', retryable: true })
        : processGeneratedResponse({ pool: gatedPool, job: owner, rawText: xml('current memory'), providerLabel: 'test' });
      try {
        await read.promise;
        expect(await reclaim()).toEqual({ requeued: 1, failed: 0 });
        expect((await reload(owner))?.status).toBe('processing');
        expect((await reload(other))?.status).toBe('queued');
      } finally {
        resume.release();
        await writing;
      }
      expect((await reload(owner))?.status).toBe(fail ? 'queued' : 'completed');
    });
  }

  for (const response of [xml('old interpretation'), '', new Error('old provider error')]) {
    it(`fences the real generator's delayed ${response instanceof Error ? 'provider failure' : response ? 'success' : 'empty response'}`, async () => {
      const job = await createJob();
      const entered = barrier();
      const resume = barrier();
      // Provider work has ended before transaction acquisition is delayed:
      // no reliance on a provider ignoring AbortSignal or exceeding its timeout.
      const oldPool = {
        query: pool.query.bind(pool),
        connect: async () => {
          entered.release();
          await resume.promise;
          return pool.connect();
        },
      } as PostgresPool;
      const envelope = {
        id: job.bullmqJobId!,
        data: {
          kind: 'event', team_id: teamId, project_id: projectId, source_type: 'agent_event',
          source_id: job.sourceId, generation_job_id: job.id, agent_event_id: job.agentEventId!,
          api_key_id: null, actor_id: null, source_adapter: 'api',
        },
      } as Job<GenerateObservationsForEventJob>;
      const oldGenerator = new ProviderObservationGenerator({
        pool: oldPool, workerId: 'same-worker', provider: {
          providerLabel: 'claude', generate: async () => {
            if (response instanceof Error) throw response;
            return { rawText: response, providerLabel: 'claude' };
          },
        },
      });
      const oldResult = oldGenerator.process(envelope).then(value => value, error => error as Error);
      try {
        await entered.promise;
        // Accelerate lease ageing with the real database clock. The production
        // threshold is minutes; only the recovery threshold is shortened here.
        await pool.query('SELECT pg_sleep(0.01)');
        expect(await reclaimStaleProcessingJobs({
          pool, staleAfterMs: 1, resolveQueue: () => ({ add: async () => {}, remove: async () => {} }),
        })).toEqual({ requeued: 1, failed: 0 });
        const current = await claim(job);
        resume.release();
        const result = await oldResult;
        if (response && !(response instanceof Error)) {
          expect(result).toEqual({ jobId: job.id, status: 'superseded', observationCount: 0 });
        } else {
          expect(result).toBeInstanceOf(Error);
        }
        expect(await reload(job)).toEqual(current);
        await write(current, 'current interpretation');
        const memories = await storage.observations.listByProject({ projectId, teamId });
        expect(memories).toHaveLength(1);
        expect(memories[0]!.content).toContain('current interpretation');
      } finally {
        resume.release();
        await oldResult;
      }
    });
  }
});
