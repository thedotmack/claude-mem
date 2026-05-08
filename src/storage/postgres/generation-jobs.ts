// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import {
  assertProjectOwnership,
  assertSessionOwnership,
  deterministicKey,
  newId,
  queryOne,
  toDate,
  toEpoch,
  toJsonObject
} from './utils.js';

export type ObservationGenerationJobSourceType = 'agent_event' | 'session_summary' | 'observation_reindex';
export type ObservationGenerationJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type ObservationGenerationJobEventType =
  | 'queued'
  | 'enqueued'
  | 'processing'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PostgresObservationGenerationJob {
  id: string;
  projectId: string;
  teamId: string;
  agentEventId: string | null;
  sourceType: ObservationGenerationJobSourceType;
  sourceId: string;
  serverSessionId: string | null;
  jobType: string;
  status: ObservationGenerationJobStatus;
  idempotencyKey: string;
  bullmqJobId: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAtEpoch: number | null;
  lockedAtEpoch: number | null;
  lockedBy: string | null;
  completedAtEpoch: number | null;
  failedAtEpoch: number | null;
  cancelledAtEpoch: number | null;
  lastError: JsonObject | null;
  payload: JsonObject;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface PostgresObservationGenerationJobEvent {
  id: string;
  generationJobId: string;
  eventType: ObservationGenerationJobEventType;
  statusAfter: ObservationGenerationJobStatus;
  attempt: number;
  details: JsonObject;
  createdAtEpoch: number;
}

interface JobRow {
  id: string;
  project_id: string;
  team_id: string;
  agent_event_id: string | null;
  source_type: ObservationGenerationJobSourceType;
  source_id: string;
  server_session_id: string | null;
  job_type: string;
  status: ObservationGenerationJobStatus;
  idempotency_key: string;
  bullmq_job_id: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  locked_at: Date | null;
  locked_by: string | null;
  completed_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  last_error: unknown | null;
  payload: unknown;
  created_at: Date;
  updated_at: Date;
}

interface JobEventRow {
  id: string;
  generation_job_id: string;
  event_type: ObservationGenerationJobEventType;
  status_after: ObservationGenerationJobStatus;
  attempt: number;
  details: unknown;
  created_at: Date;
}

export class PostgresObservationGenerationJobRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: {
    id?: string;
    projectId: string;
    teamId: string;
    sourceType: ObservationGenerationJobSourceType;
    sourceId: string;
    agentEventId?: string | null;
    serverSessionId?: string | null;
    jobType: string;
    status?: ObservationGenerationJobStatus;
    bullmqJobId?: string | null;
    maxAttempts?: number;
    payload?: JsonObject;
  }): Promise<PostgresObservationGenerationJob> {
    await this.validateSource(input);
    const sourceModel = normalizeSourceModel(input);
    const idempotencyKey = buildObservationGenerationJobIdempotencyKey(input);
    const row = await queryOne<JobRow>(
      this.client,
      `
        INSERT INTO observation_generation_jobs (
          id, project_id, team_id, agent_event_id, source_type, source_id,
          server_session_id, job_type, status, idempotency_key, bullmq_job_id,
          max_attempts, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT (idempotency_key) DO UPDATE SET
          payload = observation_generation_jobs.payload || excluded.payload,
          updated_at = now()
        RETURNING *
      `,
      [
        input.id ?? newId(),
        input.projectId,
        input.teamId,
        sourceModel.agentEventId,
        input.sourceType,
        input.sourceId,
        sourceModel.serverSessionId,
        input.jobType,
        input.status ?? 'queued',
        idempotencyKey,
        input.bullmqJobId ?? null,
        input.maxAttempts ?? 3,
        JSON.stringify(input.payload ?? {})
      ]
    );
    return mapJobRow(row!);
  }

  async getByIdForScope(input: {
    id: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservationGenerationJob | null> {
    const row = await queryOne<JobRow>(
      this.client,
      'SELECT * FROM observation_generation_jobs WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    return row ? mapJobRow(row) : null;
  }

  async transitionStatus(input: {
    id: string;
    projectId: string;
    teamId: string;
    status: ObservationGenerationJobStatus;
    lockedBy?: string | null;
    lastError?: JsonObject | null;
    nextAttemptAt?: Date | null;
  }): Promise<PostgresObservationGenerationJob | null> {
    const row = await queryOne<JobRow>(
      this.client,
      `
        UPDATE observation_generation_jobs
        SET
          status = $2,
          attempts = CASE WHEN $2 = 'processing' THEN attempts + 1 ELSE attempts END,
          locked_at = CASE WHEN $2 = 'processing' THEN now() ELSE NULL END,
          locked_by = CASE WHEN $2 = 'processing' THEN $3 ELSE NULL END,
          next_attempt_at = CASE WHEN $2 = 'queued' THEN $4::timestamptz ELSE NULL::timestamptz END,
          completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END,
          failed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
          cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE NULL END,
          last_error = $5::jsonb,
          updated_at = now()
        WHERE id = $1
          AND project_id = $6
          AND team_id = $7
          AND (
            (status = 'queued' AND $2 IN ('processing', 'failed', 'cancelled'))
            OR
            (status = 'processing' AND $2 IN ('queued', 'completed', 'failed', 'cancelled'))
          )
          AND ($2 <> 'processing' OR attempts < max_attempts)
          AND ($2 <> 'queued' OR attempts < max_attempts)
        RETURNING *
      `,
      [
        input.id,
        input.status,
        input.lockedBy ?? null,
        input.nextAttemptAt ?? null,
        input.lastError == null ? null : JSON.stringify(input.lastError),
        input.projectId,
        input.teamId
      ]
    );
    if (row) {
      return mapJobRow(row);
    }

    const current = await queryOne<JobRow>(
      this.client,
      'SELECT * FROM observation_generation_jobs WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.id, input.projectId, input.teamId]
    );
    if (!current) {
      return null;
    }
    assertValidJobStatusTransition(mapJobRow(current), input.status);
    throw new Error('observation generation job status transition was not applied');
  }

  async listByStatusForScope(input: {
    status: ObservationGenerationJobStatus;
    projectId: string;
    teamId: string;
    limit?: number;
  }): Promise<PostgresObservationGenerationJob[]> {
    const result = await this.client.query<JobRow>(
      `
        SELECT * FROM observation_generation_jobs
        WHERE status = $1 AND project_id = $2 AND team_id = $3
        ORDER BY created_at ASC
        LIMIT $4
      `,
      [input.status, input.projectId, input.teamId, input.limit ?? 100]
    );
    return result.rows.map(mapJobRow);
  }

  private async validateSource(input: {
    projectId: string;
    teamId: string;
    sourceType: ObservationGenerationJobSourceType;
    sourceId: string;
    agentEventId?: string | null;
    serverSessionId?: string | null;
  }): Promise<void> {
    await assertProjectOwnership(this.client, input.projectId, input.teamId);
    if (input.sourceType === 'agent_event') {
      const eventId = input.agentEventId ?? input.sourceId;
      const row = await queryOne<{ id: string; server_session_id: string | null }>(
        this.client,
        'SELECT id, server_session_id FROM agent_events WHERE id = $1 AND project_id = $2 AND team_id = $3',
        [eventId, input.projectId, input.teamId]
      );
      if (!row || input.sourceId !== eventId) {
        throw new Error('agent_event source_id must belong to project_id and team_id');
      }
      if (input.serverSessionId) {
        await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
        if (row.server_session_id && row.server_session_id !== input.serverSessionId) {
          throw new Error('server_session_id must match the agent_event server_session_id');
        }
      }
      return;
    }

    if (input.sourceType === 'session_summary') {
      const sessionId = input.serverSessionId ?? input.sourceId;
      await assertSessionOwnership(this.client, sessionId, input.projectId, input.teamId);
      if (input.sourceId !== sessionId) {
        throw new Error('session_summary source_id must equal server_session_id');
      }
      return;
    }

    const observation = await queryOne<{ id: string }>(
      this.client,
      'SELECT id FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3',
      [input.sourceId, input.projectId, input.teamId]
    );
    if (!observation) {
      throw new Error('observation_reindex source_id must belong to project_id and team_id');
    }
    if (input.serverSessionId) {
      await assertSessionOwnership(this.client, input.serverSessionId, input.projectId, input.teamId);
    }
  }
}

export class PostgresObservationGenerationJobEventsRepository {
  constructor(private client: PostgresQueryable) {}

  async append(input: {
    id?: string;
    generationJobId: string;
    projectId: string;
    teamId: string;
    eventType: ObservationGenerationJobEventType;
    statusAfter: ObservationGenerationJobStatus;
    attempt?: number;
    details?: JsonObject;
  }): Promise<PostgresObservationGenerationJobEvent> {
    const row = await queryOne<JobEventRow>(
      this.client,
      `
        INSERT INTO observation_generation_job_events (
          id, generation_job_id, event_type, status_after, attempt, details
        )
        SELECT $1, jobs.id, $4, $5, $6, $7::jsonb
        FROM observation_generation_jobs jobs
        WHERE jobs.id = $2
          AND jobs.project_id = $3
          AND jobs.team_id = $8
        RETURNING observation_generation_job_events.*
      `,
      [
        input.id ?? newId(),
        input.generationJobId,
        input.projectId,
        input.eventType,
        input.statusAfter,
        input.attempt ?? 0,
        JSON.stringify(input.details ?? {}),
        input.teamId
      ]
    );
    if (!row) {
      throw new Error('generation_job_id must belong to project_id and team_id');
    }
    return mapJobEventRow(row!);
  }

  async listByJobForScope(input: {
    generationJobId: string;
    projectId: string;
    teamId: string;
  }): Promise<PostgresObservationGenerationJobEvent[]> {
    const result = await this.client.query<JobEventRow>(
      `
        SELECT events.*
        FROM observation_generation_job_events events
        INNER JOIN observation_generation_jobs jobs ON jobs.id = events.generation_job_id
        WHERE events.generation_job_id = $1 AND jobs.project_id = $2 AND jobs.team_id = $3
        ORDER BY events.created_at ASC
      `,
      [input.generationJobId, input.projectId, input.teamId]
    );
    return result.rows.map(mapJobEventRow);
  }
}

export function buildObservationGenerationJobIdempotencyKey(input: {
  teamId: string;
  projectId: string;
  sourceType: ObservationGenerationJobSourceType;
  sourceId: string;
  jobType: string;
}): string {
  return `observation_generation_job:v1:${deterministicKey([
    input.teamId,
    input.projectId,
    input.sourceType,
    input.sourceId,
    input.jobType
  ])}`;
}

function normalizeSourceModel(input: {
  sourceType: ObservationGenerationJobSourceType;
  sourceId: string;
  agentEventId?: string | null;
  serverSessionId?: string | null;
}): { agentEventId: string | null; serverSessionId: string | null } {
  if (input.sourceType === 'agent_event') {
    return { agentEventId: input.agentEventId ?? input.sourceId, serverSessionId: input.serverSessionId ?? null };
  }
  if (input.sourceType === 'session_summary') {
    return { agentEventId: null, serverSessionId: input.serverSessionId ?? input.sourceId };
  }
  return { agentEventId: null, serverSessionId: input.serverSessionId ?? null };
}

const TERMINAL_JOB_STATUSES = new Set<ObservationGenerationJobStatus>(['completed', 'failed', 'cancelled']);

const ALLOWED_JOB_TRANSITIONS: Record<ObservationGenerationJobStatus, readonly ObservationGenerationJobStatus[]> = {
  queued: ['processing', 'failed', 'cancelled'],
  processing: ['queued', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
};

function assertValidJobStatusTransition(
  current: PostgresObservationGenerationJob,
  nextStatus: ObservationGenerationJobStatus
): void {
  if (TERMINAL_JOB_STATUSES.has(current.status)) {
    throw new Error(`cannot transition observation generation job from terminal status ${current.status}`);
  }

  if (!ALLOWED_JOB_TRANSITIONS[current.status].includes(nextStatus)) {
    throw new Error(`illegal observation generation job transition from ${current.status} to ${nextStatus}`);
  }

  if (nextStatus === 'processing' && current.attempts >= current.maxAttempts) {
    throw new Error('cannot process observation generation job after max_attempts is reached');
  }

  if (nextStatus === 'queued' && current.attempts >= current.maxAttempts) {
    throw new Error('cannot retry observation generation job after max_attempts is reached');
  }
}

function mapJobRow(row: JobRow): PostgresObservationGenerationJob {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    agentEventId: row.agent_event_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    serverSessionId: row.server_session_id,
    jobType: row.job_type,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    bullmqJobId: row.bullmq_job_id,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAtEpoch: toDate(row.next_attempt_at)?.getTime() ?? null,
    lockedAtEpoch: toDate(row.locked_at)?.getTime() ?? null,
    lockedBy: row.locked_by,
    completedAtEpoch: toDate(row.completed_at)?.getTime() ?? null,
    failedAtEpoch: toDate(row.failed_at)?.getTime() ?? null,
    cancelledAtEpoch: toDate(row.cancelled_at)?.getTime() ?? null,
    lastError: row.last_error == null ? null : toJsonObject(row.last_error),
    payload: toJsonObject(row.payload),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}

function mapJobEventRow(row: JobEventRow): PostgresObservationGenerationJobEvent {
  return {
    id: row.id,
    generationJobId: row.generation_job_id,
    eventType: row.event_type,
    statusAfter: row.status_after,
    attempt: row.attempt,
    details: toJsonObject(row.details),
    createdAtEpoch: toEpoch(row.created_at)
  };
}
