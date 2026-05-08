import { describe, expect, it } from 'bun:test';
import {
  enqueueOutbox,
  markCompleted,
  markFailed,
  reconcileOnStartup,
  type SingleSourceJobPayload
} from '../../../src/server/jobs/outbox.js';
import type { ServerJobQueue } from '../../../src/server/jobs/ServerJobQueue.js';
import type {
  ObservationGenerationJobStatus,
  PostgresObservationGenerationJob,
  PostgresObservationGenerationJobEvent,
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository
} from '../../../src/storage/postgres/generation-jobs.js';

interface CreateInput {
  id?: string;
  projectId: string;
  teamId: string;
  sourceType: PostgresObservationGenerationJob['sourceType'];
  sourceId: string;
  agentEventId?: string | null;
  serverSessionId?: string | null;
  jobType: string;
  status?: ObservationGenerationJobStatus;
  bullmqJobId?: string | null;
  maxAttempts?: number;
  payload?: Record<string, unknown>;
}

interface StubJobRepoState {
  rows: Map<string, PostgresObservationGenerationJob>;
  counter: number;
}

function buildStubJobRepo(state: StubJobRepoState): PostgresObservationGenerationJobRepository {
  const rowId = () => `job_${++state.counter}`;
  const ts = () => Date.now();

  return {
    async create(input: CreateInput): Promise<PostgresObservationGenerationJob> {
      const idempotencyKey = `idem:${input.teamId}:${input.projectId}:${input.sourceType}:${input.sourceId}:${input.jobType}`;
      const existing = [...state.rows.values()].find(r => r.idempotencyKey === idempotencyKey);
      if (existing) {
        return existing;
      }
      const id = input.id ?? rowId();
      const row: PostgresObservationGenerationJob = {
        id,
        projectId: input.projectId,
        teamId: input.teamId,
        agentEventId: input.agentEventId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        serverSessionId: input.serverSessionId ?? null,
        jobType: input.jobType,
        status: input.status ?? 'queued',
        idempotencyKey,
        bullmqJobId: input.bullmqJobId ?? null,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        nextAttemptAtEpoch: null,
        lockedAtEpoch: null,
        lockedBy: null,
        completedAtEpoch: null,
        failedAtEpoch: null,
        cancelledAtEpoch: null,
        lastError: null,
        payload: (input.payload as PostgresObservationGenerationJob['payload']) ?? {},
        createdAtEpoch: ts(),
        updatedAtEpoch: ts()
      };
      state.rows.set(id, row);
      return row;
    },

    async getByIdForScope(input) {
      const row = state.rows.get(input.id);
      if (!row || row.projectId !== input.projectId || row.teamId !== input.teamId) {
        return null;
      }
      return row;
    },

    async transitionStatus(input) {
      const row = state.rows.get(input.id);
      if (!row || row.projectId !== input.projectId || row.teamId !== input.teamId) {
        return null;
      }
      const next: PostgresObservationGenerationJob = {
        ...row,
        status: input.status,
        attempts: input.status === 'processing' ? row.attempts + 1 : row.attempts,
        lastError: input.lastError ?? null,
        nextAttemptAtEpoch: input.nextAttemptAt ? input.nextAttemptAt.getTime() : null,
        completedAtEpoch: input.status === 'completed' ? ts() : null,
        failedAtEpoch: input.status === 'failed' ? ts() : null,
        cancelledAtEpoch: input.status === 'cancelled' ? ts() : null,
        updatedAtEpoch: ts()
      };
      state.rows.set(input.id, next);
      return next;
    },

    async listByStatusForScope(input) {
      return [...state.rows.values()].filter(
        r => r.status === input.status && r.projectId === input.projectId && r.teamId === input.teamId
      );
    }
  } as unknown as PostgresObservationGenerationJobRepository;
}

interface EventLogEntry {
  generationJobId: string;
  eventType: PostgresObservationGenerationJobEvent['eventType'];
  statusAfter: ObservationGenerationJobStatus;
  attempt: number;
  details?: Record<string, unknown>;
}

function buildStubEventsRepo(log: EventLogEntry[]): PostgresObservationGenerationJobEventsRepository {
  return {
    async append(input) {
      log.push({
        generationJobId: input.generationJobId,
        eventType: input.eventType,
        statusAfter: input.statusAfter,
        attempt: input.attempt ?? 0,
        details: input.details ?? {}
      });
      return {
        id: `evt_${log.length}`,
        generationJobId: input.generationJobId,
        eventType: input.eventType,
        statusAfter: input.statusAfter,
        attempt: input.attempt ?? 0,
        details: input.details ?? {},
        createdAtEpoch: Date.now()
      };
    },
    async listByJobForScope() {
      return [];
    }
  } as unknown as PostgresObservationGenerationJobEventsRepository;
}

interface StubQueueState {
  added: Array<{ jobId: string; payload: SingleSourceJobPayload }>;
  removed: string[];
  failOnAdd: boolean;
}

function buildStubQueue(state: StubQueueState): ServerJobQueue<SingleSourceJobPayload> {
  return {
    name: 'stub',
    add: async (jobId: string, payload: SingleSourceJobPayload) => {
      if (state.failOnAdd) {
        throw new Error('redis unavailable');
      }
      state.added.push({ jobId, payload });
    },
    remove: async (jobId: string) => {
      state.removed.push(jobId);
    },
    getJob: async () => null,
    getCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 }),
    start: () => {},
    isStarted: () => false,
    close: async () => {}
  } as unknown as ServerJobQueue<SingleSourceJobPayload>;
}

const eventPayload: SingleSourceJobPayload = {
  kind: 'event',
  team_id: 'team_1',
  project_id: 'project_1',
  source_type: 'agent_event',
  source_id: 'evt_1',
  generation_job_id: 'gen_1',
  agent_event_id: 'evt_1',
  api_key_id: 'apk_1',
  actor_id: 'system:test',
  source_adapter: 'api'
};

describe('outbox.enqueueOutbox', () => {
  it('writes the row, records two events, and publishes to BullMQ', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const queueState: StubQueueState = { added: [], removed: [], failOnAdd: false };
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);
    const queue = buildStubQueue(queueState);

    const { row, bullmqJobId } = await enqueueOutbox(jobRepo, eventsRepo, queue, {
      payload: eventPayload
    });

    expect(row.status).toBe('queued');
    expect(row.agentEventId).toBe('evt_1');
    expect(row.jobType).toBe('observation_generate_for_event');
    expect(bullmqJobId.startsWith('evt_')).toBe(true);
    expect(bullmqJobId.includes(':')).toBe(false);
    expect(queueState.added).toHaveLength(1);
    expect(queueState.added[0]!.jobId).toBe(bullmqJobId);
    expect(log.map(e => e.eventType)).toEqual(['queued', 'enqueued']);
  });

  it('suppresses duplicate enqueues by returning the same idempotency-keyed row', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const queueState: StubQueueState = { added: [], removed: [], failOnAdd: false };
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);
    const queue = buildStubQueue(queueState);

    const first = await enqueueOutbox(jobRepo, eventsRepo, queue, { payload: eventPayload });
    const second = await enqueueOutbox(jobRepo, eventsRepo, queue, { payload: eventPayload });

    expect(second.row.id).toBe(first.row.id);
    expect(second.bullmqJobId).toBe(first.bullmqJobId);
    expect(repoState.rows.size).toBe(1);
  });

  it('marks the row failed when BullMQ publish throws', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const queueState: StubQueueState = { added: [], removed: [], failOnAdd: true };
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);
    const queue = buildStubQueue(queueState);

    await expect(
      enqueueOutbox(jobRepo, eventsRepo, queue, { payload: eventPayload })
    ).rejects.toThrow(/redis unavailable/);

    const row = [...repoState.rows.values()][0]!;
    expect(row.status).toBe('failed');
    expect(row.lastError?.source).toBe('bullmq_publish');
    const eventTypes = log.map(e => e.eventType);
    expect(eventTypes).toContain('queued');
    expect(eventTypes).toContain('failed');
  });
});

describe('outbox.reconcileOnStartup', () => {
  it('replaces terminal BullMQ jobs and re-enqueues queued + processing rows', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const queueState: StubQueueState = { added: [], removed: [], failOnAdd: false };
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);
    const queue = buildStubQueue(queueState);

    await enqueueOutbox(jobRepo, eventsRepo, queue, { payload: eventPayload });
    queueState.added.length = 0;
    log.length = 0;

    const result = await reconcileOnStartup(jobRepo, eventsRepo, queue, {
      projectId: 'project_1',
      teamId: 'team_1'
    });

    expect(result.requeued).toBe(1);
    expect(result.skipped).toBe(0);
    expect(queueState.removed).toHaveLength(1);
    expect(queueState.added).toHaveLength(1);
    expect(log.some(e => e.eventType === 'enqueued')).toBe(true);
  });

  it('skips rows that have hit max_attempts', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const queueState: StubQueueState = { added: [], removed: [], failOnAdd: false };
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);
    const queue = buildStubQueue(queueState);

    const created = await jobRepo.create({
      projectId: 'project_1',
      teamId: 'team_1',
      sourceType: 'agent_event',
      sourceId: 'evt_1',
      agentEventId: 'evt_1',
      jobType: 'observation_generate_for_event',
      payload: {},
      maxAttempts: 1
    });
    repoState.rows.set(created.id, { ...created, attempts: 1 });

    const result = await reconcileOnStartup(jobRepo, eventsRepo, queue, {
      projectId: 'project_1',
      teamId: 'team_1'
    });

    expect(result.requeued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(queueState.added).toHaveLength(0);
  });

  it('demotes processing rows back to queued before re-enqueue', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const queueState: StubQueueState = { added: [], removed: [], failOnAdd: false };
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);
    const queue = buildStubQueue(queueState);

    const created = await jobRepo.create({
      projectId: 'project_1',
      teamId: 'team_1',
      sourceType: 'agent_event',
      sourceId: 'evt_1',
      agentEventId: 'evt_1',
      jobType: 'observation_generate_for_event',
      payload: {}
    });
    repoState.rows.set(created.id, { ...created, status: 'processing', attempts: 1 });

    await reconcileOnStartup(jobRepo, eventsRepo, queue, {
      projectId: 'project_1',
      teamId: 'team_1'
    });

    const row = repoState.rows.get(created.id)!;
    expect(row.status).toBe('queued');
    expect(queueState.added).toHaveLength(1);
  });
});

describe('outbox.markCompleted / markFailed', () => {
  it('transitions to completed and appends a completed event', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);

    const created = await jobRepo.create({
      projectId: 'project_1',
      teamId: 'team_1',
      sourceType: 'agent_event',
      sourceId: 'evt_1',
      agentEventId: 'evt_1',
      jobType: 'observation_generate_for_event'
    });

    await markCompleted(jobRepo, eventsRepo, {
      id: created.id,
      projectId: 'project_1',
      teamId: 'team_1'
    });

    expect(repoState.rows.get(created.id)!.status).toBe('completed');
    expect(log[0]!.eventType).toBe('completed');
  });

  it('transitions to failed and records the error', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);

    const created = await jobRepo.create({
      projectId: 'project_1',
      teamId: 'team_1',
      sourceType: 'agent_event',
      sourceId: 'evt_1',
      agentEventId: 'evt_1',
      jobType: 'observation_generate_for_event'
    });

    await markFailed(jobRepo, eventsRepo, {
      id: created.id,
      projectId: 'project_1',
      teamId: 'team_1',
      error: { message: 'provider 500', source: 'processor' }
    });

    expect(repoState.rows.get(created.id)!.status).toBe('failed');
    expect(repoState.rows.get(created.id)!.lastError).toEqual({
      message: 'provider 500',
      source: 'processor'
    });
    expect(log[0]!.eventType).toBe('failed');
  });

  it('schedules a retry by transitioning to queued when nextAttemptAt is given', async () => {
    const repoState: StubJobRepoState = { rows: new Map(), counter: 0 };
    const log: EventLogEntry[] = [];
    const jobRepo = buildStubJobRepo(repoState);
    const eventsRepo = buildStubEventsRepo(log);

    const created = await jobRepo.create({
      projectId: 'project_1',
      teamId: 'team_1',
      sourceType: 'agent_event',
      sourceId: 'evt_1',
      agentEventId: 'evt_1',
      jobType: 'observation_generate_for_event'
    });

    const retryAt = new Date(Date.now() + 60_000);
    await markFailed(jobRepo, eventsRepo, {
      id: created.id,
      projectId: 'project_1',
      teamId: 'team_1',
      error: { message: 'transient', source: 'processor' },
      nextAttemptAt: retryAt
    });

    expect(repoState.rows.get(created.id)!.status).toBe('queued');
    expect(log[0]!.eventType).toBe('retry_scheduled');
  });
});
