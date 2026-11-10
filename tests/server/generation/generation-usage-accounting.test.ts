import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type pg from 'pg';
import {
  bootstrapServerPostgresSchema, createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import type { PostgresObservationGenerationJob } from '../../../src/storage/postgres/generation-jobs.js';
import {
  processGeneratedResponse, processSessionSummaryResponse,
  type ProcessGeneratedResponseInput,
} from '../../../src/server/generation/processGeneratedResponse.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, poolForSchema, quoteIdentifier } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const EVENT_XML = '<observation><type>discovery</type><title>Metered observation</title><narrative>Saved event</narrative></observation>';
const SUMMARY_XML = '<summary><request>Metered session</request><completed>Saved summary</completed></summary>';

describe('generation usage belongs to one committed completion', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }

  let pool: pg.Pool;
  let schema: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let previousMetering: string | undefined;

  beforeEach(async () => {
    previousMetering = process.env.CLAUDE_MEM_USAGE_METERING;
    process.env.CLAUDE_MEM_USAGE_METERING = '1';
    ModeManager.getInstance().loadMode('code');
    schema = await createIsolatedSchema(databaseUrl!, 'cm_usage_owner');
    pool = poolForSchema(databaseUrl!, schema);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'usage-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'usage-project' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    if (previousMetering === undefined) delete process.env.CLAUDE_MEM_USAGE_METERING;
    else process.env.CLAUDE_MEM_USAGE_METERING = previousMetering;
    try { await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`); }
    finally { await pool.end(); }
  });

  async function inputFor(kind: 'event' | 'summary', tokensUsed = 1234): Promise<ProcessGeneratedResponseInput> {
    let job: PostgresObservationGenerationJob;
    if (kind === 'summary') {
      const session = await storage.sessions.create({
        teamId, projectId, contentSessionId: crypto.randomUUID(), agentId: 'usage-fixture',
        platformSource: 'claude-code', metadata: {},
      });
      job = await storage.observationGenerationJobs.create({
        teamId, projectId, sourceType: 'session_summary', sourceId: session.id,
        serverSessionId: session.id, jobType: 'observation_generate_session_summary',
      });
    } else {
      const event = await storage.agentEvents.create({
        teamId, projectId, sourceAdapter: 'api', eventType: 'tool_use',
        payload: { tool: 'Read' }, occurredAt: new Date(),
      });
      job = await storage.observationGenerationJobs.create({
        teamId, projectId, sourceType: 'agent_event', sourceId: event.id,
        agentEventId: event.id, jobType: 'observation_generate_for_event',
      });
    }
    await storage.observationGenerationJobs.transitionStatus({
      id: job.id, teamId, projectId, status: 'processing', lockedBy: 'usage-worker',
    });
    const fresh = (await storage.observationGenerationJobs.getByIdForScope({ id: job.id, teamId, projectId }))!;
    return { pool, job: fresh, rawText: kind === 'summary' ? SUMMARY_XML : EVENT_XML, providerLabel: 'fixture', tokensUsed };
  }

  async function usage(): Promise<Record<string, number>> {
    const result = await pool.query('SELECT kind, SUM(quantity)::bigint AS total FROM usage_events WHERE team_id = $1 GROUP BY kind', [teamId]);
    return Object.fromEntries(result.rows.map(row => [row.kind, Number(row.total)]));
  }

  for (const kind of ['event', 'summary'] as const) {
    it(`meters a ${kind} completion once across concurrent responses and terminal redelivery`, async () => {
      const input = await inputFor(kind);
      const processResponse = kind === 'summary' ? processSessionSummaryResponse : processGeneratedResponse;
      const outcomes = await Promise.all([processResponse(input), processResponse(input)]);
      expect(outcomes.every(outcome => outcome.kind === 'completed')).toBe(true);
      await processResponse(input);
      expect(await usage()).toEqual({ tokens: 1234, observation: 1 });
      const count = await pool.query('SELECT COUNT(*)::int AS n FROM observations WHERE team_id = $1', [teamId]);
      expect(count.rows[0].n).toBe(1);
    });
  }

  it('records billed summary tokens even when the model elects to skip the summary', async () => {
    const input = await inputFor('summary', 55);
    input.rawText = '<skip_summary reason="model_skipped" />';
    expect((await processSessionSummaryResponse(input)).kind).toBe('completed');
    expect(await usage()).toEqual({ tokens: 55 });
  });

  for (const status of ['cancelled', 'failed'] as const) {
    it(`does not meter a response rejected by an already ${status} job`, async () => {
      const input = await inputFor('event');
      await storage.observationGenerationJobs.transitionStatus({ id: input.job.id, teamId, projectId, status });
      await processGeneratedResponse(input);
      expect(await usage()).toEqual({});
    });
  }

  it('keeps the summary and completed job when post-commit usage storage fails', async () => {
    const input = await inputFor('summary');
    await pool.query('DROP TABLE usage_events');
    expect((await processSessionSummaryResponse(input)).kind).toBe('completed');
    const job = await storage.observationGenerationJobs.getByIdForScope({ id: input.job.id, teamId, projectId });
    expect(job?.status).toBe('completed');
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM observations WHERE team_id = $1', [teamId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('keeps metering disabled unless the existing opt-in is enabled', async () => {
    delete process.env.CLAUDE_MEM_USAGE_METERING;
    const input = await inputFor('summary');
    await processSessionSummaryResponse(input);
    expect(await usage()).toEqual({});
  });
});
