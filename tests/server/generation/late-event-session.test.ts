import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Job } from 'bullmq';
import type pg from 'pg';
import { ServerService } from '../../../src/server/runtime/ServerService.js';
import { DisabledServerGenerationWorkerManager, DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import { OpenRouterObservationProvider } from '../../../src/server/generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationJobPayload } from '../../../src/server/jobs/types.js';
import {
  bootstrapServerPostgresSchema, createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { logger } from '../../../src/utils/logger.js';
import { createIsolatedSchema, dropSchema, newApiKey, poolForSchema } from '../../sdk/pg-isolation.js';

const databaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('generation after an event acquires its session', () => {
  if (!databaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let schema: string;
  let pool: pg.Pool;
  let storage: PostgresStorageRepositories;
  let service: ServerService;
  let teamId: string;
  let projectId: string;
  let apiKey: string;
  let spies: ReturnType<typeof spyOn>[];

  beforeEach(async () => {
    spies = (['info', 'warn', 'error', 'debug'] as const).map(level =>
      spyOn(logger, level).mockImplementation(() => {}));
    ModeManager.getInstance().loadMode('code');
    schema = await createIsolatedSchema(databaseUrl, 'cm_late_event_session');
    pool = poolForSchema(databaseUrl, schema);
    await bootstrapServerPostgresSchema(pool);
    storage = createPostgresStorageRepositories(pool);
    const team = await storage.teams.create({ name: 'Late event team' });
    teamId = team.id;
    const project = await storage.projects.create({ teamId, name: 'Shared server project' });
    projectId = project.id;
    const key = newApiKey();
    apiKey = key.raw;
    await storage.auth.createApiKey({ keyHash: key.hash, teamId, projectId,
      actorId: 'test', scopes: ['memories:read', 'memories:write'] });
    service = new ServerService({
      graph: {
        runtime: 'server-beta',
        postgres: { pool, bootstrap: { initialized: true, schemaVersion: 1, appliedAt: null } },
        authMode: 'api-key',
        queueManager: new DisabledServerQueueManager('test'),
        generationWorkerManager: new DisabledServerGenerationWorkerManager('test'),
      },
      port: 0, host: '127.0.0.1', persistRuntimeState: false,
    });
    await service.start();
  });

  afterEach(async () => {
    try { await service?.stop(); }
    finally {
      await dropSchema(databaseUrl, schema);
      spies.forEach(spy => spy.mockRestore());
    }
  });

  async function post(path: string, body: unknown) {
    const response = await fetch(`http://127.0.0.1:${service.getRuntimeState().port}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    expect(response.ok).toBe(true);
    return json;
  }

  for (const batch of [false, true]) {
    it(`keeps generated memory in folder context after ${batch ? 'batch' : 'single'} event redelivery`, async () => {
      const contentSessionId = 'codex-native-session';
      const eventInput = {
        projectId, contentSessionId, platformSource: 'codex', sourceType: 'hook',
        eventType: 'tool_use', occurredAtEpoch: Date.now(),
        payload: { tool_name: 'Bash', tool_input: { command: 'deploy --check' }, tool_response: 'canary rollout verified' },
      };
      const ingest = async (body: Record<string, unknown>) => {
        const result = await post(batch ? '/v1/events/batch' : '/v1/events', batch ? [body] : body);
        return batch ? result.events[0] : result;
      };
      const first = await ingest(eventInput);
      expect(first.event.serverSessionId).toBeNull();
      const originalJob = await storage.observationGenerationJobs.getByIdForScope({
        id: first.generationJob.id, projectId, teamId,
      });
      expect(originalJob?.serverSessionId).toBeNull();

      const { session } = await post('/v1/sessions/start', {
        projectId, externalSessionId: contentSessionId, contentSessionId, platformSource: 'codex',
        metadata: { project: 'canary-checkout' },
      });
      const redelivered = await ingest(eventInput);
      expect(redelivered.event.id).toBe(first.event.id);
      // #5546 already repairs this raw row. The job must retain the same link
      // so downstream generation can use its session and folder identity.
      expect(redelivered.event.serverSessionId).toBe(session.id);
      expect(redelivered.generationJob.id).toBe(first.generationJob.id);
      const linkedJob = (await storage.observationGenerationJobs.getByIdForScope({
        id: first.generationJob.id, projectId, teamId,
      }))!;

      let providerCalls = 0;
      const provider = new OpenRouterObservationProvider({
        apiKey: 'offline-test', model: 'offline-test', baseUrl: 'https://provider.invalid/v1',
        fetchImpl: (async (_url, init) => {
          providerCalls++;
          expect(String(init?.body)).toContain('canary rollout verified');
          return Response.json({ choices: [{ message: { content: '<observation><type>discovery</type><title>Canary rollout</title><facts><fact>Canary rollout was verified before release.</fact></facts></observation>' }, finish_reason: 'stop' }] });
        }) as typeof fetch,
      });
      const generator = new ProviderObservationGenerator({ pool, provider });
      const job = { id: linkedJob.bullmqJobId, data: linkedJob.payload } as unknown as Job<ServerGenerationJobPayload>;
      const generated = await generator.process(job);
      expect(generated).toMatchObject({ status: 'completed', observationCount: 1 });
      expect(providerCalls).toBe(1);
      const observations = await storage.observations.listByProject({ projectId, teamId });
      expect(observations).toHaveLength(1);
      const context = await post('/v1/context', {
        projectId, platformSource: 'codex', folderProjects: ['canary-checkout'],
      });
      expect({
        rawSessionId: redelivered.event.serverSessionId,
        jobSessionId: linkedJob.serverSessionId,
        memorySessionId: observations[0]!.serverSessionId,
        folder: observations[0]!.metadata.project,
        contextIds: context.observations.map((row: { id: string }) => row.id),
      }).toEqual({
        rawSessionId: session.id, jobSessionId: session.id, memorySessionId: session.id,
        folder: 'canary-checkout', contextIds: [observations[0]!.id],
      });
      expect(context.context).toContain('Canary rollout was verified');

      const { session: other } = await post('/v1/sessions/start', {
        projectId, externalSessionId: 'different-session', platformSource: 'codex', metadata: { project: 'other-checkout' },
      });
      const later = await ingest({ ...eventInput, serverSessionId: other.id });
      expect(later.event.serverSessionId).toBe(session.id);
      expect((await storage.observationGenerationJobs.getByIdForScope({
        id: first.generationJob.id, projectId, teamId,
      }))?.serverSessionId).toBe(session.id);
      await generator.process(job);
      expect(providerCalls).toBe(1);
      expect(await storage.observations.listByProject({ projectId, teamId })).toHaveLength(1);
    });
  }

  it('does not rebind an existing job when its source has no session link', async () => {
    const firstSession = await storage.sessions.create({ projectId, teamId, externalSessionId: 'first' });
    const secondSession = await storage.sessions.create({ projectId, teamId, externalSessionId: 'second' });
    const event = await storage.agentEvents.create({ projectId, teamId,
      sourceAdapter: 'api', eventType: 'tool_use', occurredAt: Date.now(), payload: {} });
    const input = { projectId, teamId, sourceType: 'agent_event' as const,
      sourceId: event.id, agentEventId: event.id, jobType: 'observation_generate_for_event' };
    const original = await storage.observationGenerationJobs.create({ ...input, serverSessionId: firstSession.id });
    for (const serverSessionId of [secondSession.id, null]) {
      const replay = await storage.observationGenerationJobs.create({ ...input, serverSessionId });
      expect(replay.id).toBe(original.id);
      expect(replay.serverSessionId).toBe(firstSession.id);
    }
  });
});
