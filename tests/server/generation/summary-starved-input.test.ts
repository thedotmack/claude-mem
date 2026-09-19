// SPDX-License-Identifier: Apache-2.0
//
// A session_summary job was fed ONLY the events the per-event lane had not yet
// collapsed. The per-event lane normally wins that race, so a summary job that
// runs after it arrives at an EMPTY event list — and the prompt then rendered
// that list as "<!-- empty after privacy stripping -->", which is not what
// happened and is the exact case the instruction beside it names as a reason to
// skip. The model returns <skip_summary />, the job completes having written
// nothing, and the only trace is a flag called `privateContentDetected` when
// nothing was private.
//
// It is worst for a job that runs late — a retried or previously stuck summary
// finds every event of its session already collapsed, so its input is empty by
// construction rather than by timing.
//
// These tests pin the three halves of the repair: the loader feeds the whole
// session, the prompt never claims a privacy strip that did not happen, and an
// empty input is a NAMED outcome rather than an anonymous `completed`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import { buildServerGenerationPrompt } from '../../../src/server/generation/providers/shared/prompt-builder.js';
import { OpenRouterObservationProvider } from '../../../src/server/generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationContext, ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import type { PostgresAgentEvent } from '../../../src/storage/postgres/agent-events.js';
import type { Job } from 'bullmq';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

const summaryJob = (events: readonly PostgresAgentEvent[]): ServerGenerationContext => ({
  job: {
    id: 'job-sum', projectId: 'p', teamId: 't', agentEventId: null,
    sourceType: 'session_summary', sourceId: 'sess-1', serverSessionId: 'sess-1',
    jobType: 'observation_generate_for_session', status: 'processing', idempotencyKey: 'k',
    bullmqJobId: null, attempts: 1, maxAttempts: 3, nextAttemptAtEpoch: null,
    lockedAtEpoch: null, lockedBy: null, completedAtEpoch: null, failedAtEpoch: null,
    cancelledAtEpoch: null, lastError: null, payload: {}, createdAtEpoch: 0, updatedAtEpoch: 0,
  },
  events,
  project: { projectId: 'p', teamId: 't', serverSessionId: 'sess-1', projectName: 'proj' },
});

const eventWith = (payload: unknown): PostgresAgentEvent => ({
  id: 'evt-1', projectId: 'p', teamId: 't', serverSessionId: 'sess-1', sourceAdapter: 'api',
  sourceEventId: null, idempotencyKey: 'ik-1', eventType: 'tool_use', platformSource: 'claude',
  payload: payload as Record<string, unknown>, metadata: {},
  occurredAtEpoch: 1_700_000_000_000, receivedAtEpoch: 1_700_000_000_000, createdAtEpoch: 1_700_000_000_000,
});

describe('summary prompt: an empty input is not a privacy strip', () => {
  it('does not tell the model the events were scrubbed when there were no events', () => {
    const { prompt, noEvents, skippedAll } = buildServerGenerationPrompt(summaryJob([]));
    expect(noEvents).toBe(true);
    expect(skippedAll).toBe(false);
    expect(prompt).not.toContain('empty after privacy stripping');
  });

  it('still reports a genuine privacy strip as one', () => {
    const { noEvents, skippedAll, prompt } = buildServerGenerationPrompt(
      summaryJob([eventWith('<private>secret</private>')]),
    );
    expect(noEvents).toBe(false);
    expect(skippedAll).toBe(true);
    expect(prompt).toContain('empty after privacy stripping');
  });
});

describe('provider: an empty input never reaches the model', () => {
  it('skips the call and names the reason', async () => {
    let calls = 0;
    const provider = new OpenRouterObservationProvider({
      apiKey: 'k',
      fetchImpl: (async () => { calls += 1; throw new Error('the provider must not be called'); }) as unknown as typeof fetch,
    });
    const result = await provider.generate(summaryJob([]));
    expect(calls).toBe(0);
    expect(result.rawText).toBe('<skip_summary reason="no_events_loaded" />');
  });
});

describe('the summary loader feeds the WHOLE session', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  // The generation path reads the active ModeManager mode; load it so this
  // suite exercises the real parser rather than a mock.
  ModeManager.getInstance().loadMode('code');

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let sessionId: string;
  let jobId: string;

  class RecordingProvider implements ServerGenerationProvider {
    readonly providerLabel = 'claude' as const;
    seen: number | null = null;
    async generate(context: ServerGenerationContext) {
      this.seen = context.events.length;
      return { rawText: '<summary><learned>a thing</learned></summary>', providerLabel: this.providerLabel };
    }
  }

  beforeEach(async () => {
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_summary_input');
    pool = poolForSchema(testDatabaseUrl, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const session = await storage.sessions.create({ projectId, teamId });
    sessionId = session.id;

    // Three events, every one of them ALREADY collapsed into a completed
    // per-event generation job — the state a finished session is normally in
    // by the time its summary job runs.
    for (let i = 0; i < 3; i += 1) {
      const event = await storage.agentEvents.create({
        projectId, teamId, serverSessionId: sessionId, sourceAdapter: 'api',
        eventType: 'tool_use', payload: { step: i }, occurredAt: new Date(Date.now() + i),
      });
      const collapsed = await storage.observationGenerationJobs.create({
        projectId, teamId, sourceType: 'agent_event', sourceId: event.id,
        agentEventId: event.id, jobType: 'observation_generate_for_event',
        idempotencyKey: `done-${i}`, payload: {},
      });
      await storage.observationGenerationJobs.transitionStatus({
        id: collapsed.id, projectId, teamId, status: 'processing',
      });
      await storage.observationGenerationJobs.transitionStatus({
        id: collapsed.id, projectId, teamId, status: 'completed',
      });
    }

    const job = await storage.observationGenerationJobs.create({
      projectId, teamId, sourceType: 'session_summary', sourceId: sessionId,
      serverSessionId: sessionId, jobType: 'observation_generate_for_session',
      idempotencyKey: 'sum-1', payload: {},
    });
    jobId = job.id;
  });

  const makeJob = (): Job<never> => ({
    id: 'bull-sum-1',
    data: {
      kind: 'summary', team_id: teamId, project_id: projectId,
      source_type: 'session_summary', source_id: sessionId,
      server_session_id: sessionId, generation_job_id: jobId,
      api_key_id: null, actor_id: null, source_adapter: 'api', request_id: null,
    },
  } as unknown as Job<never>);

  it('hands the provider every event in the session, not only the uncollapsed ones', async () => {
    const provider = new RecordingProvider();
    const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider });

    const result = await generator.process(makeJob());

    expect(provider.seen).toBe(3);
    expect(result.observationCount).toBe(1);
  });

  it('records the input event count on the completion, so a zero is never anonymous', async () => {
    const provider = new RecordingProvider();
    const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider });
    await generator.process(makeJob());

    const { rows } = await client.query(
      `SELECT details FROM observation_generation_job_events
        WHERE generation_job_id = $1 AND event_type = 'completed'`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].details.inputEventCount).toBe(3);
    expect(rows[0].details.skipReason).toBeNull();
  });

  afterEach(async () => {
    if (client) {
      try { await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`); } catch {}
      client.release();
    }
    await pool.end();
  });
});
