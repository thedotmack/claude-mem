// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type {
  ObservationGenerationJobSourceType,
  ObservationGenerationJobStatus
} from '../../storage/postgres/generation-jobs.js';

export type ServerGenerationJobKind = 'event' | 'event-batch' | 'summary' | 'reindex';

export type ServerGenerationJobStatus = ObservationGenerationJobStatus;

// Phase 11 — every BullMQ job carries the full team-aware tracing surface so
// the worker can audit and scope-check on every retry. team_id and project_id
// are advisory: the worker MUST reload the canonical outbox row from Postgres
// and compare these fields before any side effect. Treating these as auth
// authority would be a bypass — the comparison is a tampering detector, not
// the auth gate.
export interface ServerGenerationJob {
  kind: ServerGenerationJobKind;
  team_id: string;
  project_id: string;
  source_type: ObservationGenerationJobSourceType;
  source_id: string;
  generation_job_id: string;
  // Identity of the API key that initiated this job at the HTTP boundary.
  // Reused at execution time to detect revocation between enqueue and run.
  api_key_id: string | null;
  // The actor associated with the api key at enqueue time. Audit-only;
  // never trust this for authz decisions.
  actor_id: string | null;
  // Legacy adapter or surface that produced the source row, for routing
  // and audit (e.g. 'api', 'hooks', 'mcp', 'compat:sessions-observations').
  source_adapter: string;
  // Phase 12 — request correlation id, optional but always serialized as a
  // nullable field so downstream consumers can rely on shape stability.
  request_id?: string | null;
}

export interface GenerateObservationsForEventJob extends ServerGenerationJob {
  kind: 'event';
  agent_event_id: string;
}

export interface GenerateObservationsForEventBatchJob extends ServerGenerationJob {
  kind: 'event-batch';
  agent_event_ids: string[];
}

export interface GenerateSessionSummaryJob extends ServerGenerationJob {
  kind: 'summary';
  server_session_id: string;
}

export interface ReindexObservationJob extends ServerGenerationJob {
  kind: 'reindex';
  observation_id: string;
}

export type ServerGenerationJobPayload =
  | GenerateObservationsForEventJob
  | GenerateObservationsForEventBatchJob
  | GenerateSessionSummaryJob
  | ReindexObservationJob;

export const SERVER_JOB_QUEUE_NAMES: Record<ServerGenerationJobKind, string> = {
  event: 'server_beta_generate_event',
  'event-batch': 'server_beta_generate_event_batch',
  summary: 'server_beta_generate_summary',
  reindex: 'server_beta_reindex'
};

export const SERVER_JOB_KIND_PREFIX: Record<ServerGenerationJobKind, string> = {
  event: 'evt',
  'event-batch': 'evtb',
  summary: 'sum',
  reindex: 'rdx'
};

// Phase 11 — Zod schema validates payloads at the queue boundary so a
// malformed enqueue is rejected synchronously rather than silently producing
// a job the worker can't audit. Required fields here mirror the
// ServerGenerationJob interface; a missing team_id, project_id, or
// generation_job_id should always be a programmer error caught at enqueue.

const baseFieldsSchema = z.object({
  team_id: z.string().min(1, 'team_id is required'),
  project_id: z.string().min(1, 'project_id is required'),
  source_type: z.enum(['agent_event', 'session_summary', 'observation_reindex']),
  source_id: z.string().min(1, 'source_id is required'),
  generation_job_id: z.string().min(1, 'generation_job_id is required'),
  // api_key_id and actor_id are nullable to accommodate local-dev/system
  // enqueues, but the *field* must be present in the payload so audit
  // records always render the same shape.
  api_key_id: z.string().min(1).nullable(),
  actor_id: z.string().min(1).nullable(),
  source_adapter: z.string().min(1, 'source_adapter is required'),
  // Phase 12 — request_id is optional in the schema (older jobs predating
  // this phase have nullable/missing values) but always passes through to
  // logs and audit when present.
  request_id: z.string().min(1).nullable().optional(),
});

export const GenerateObservationsForEventJobSchema = baseFieldsSchema.extend({
  kind: z.literal('event'),
  agent_event_id: z.string().min(1),
});

export const GenerateObservationsForEventBatchJobSchema = baseFieldsSchema.extend({
  kind: z.literal('event-batch'),
  agent_event_ids: z.array(z.string().min(1)).min(1),
});

export const GenerateSessionSummaryJobSchema = baseFieldsSchema.extend({
  kind: z.literal('summary'),
  server_session_id: z.string().min(1),
});

export const ReindexObservationJobSchema = baseFieldsSchema.extend({
  kind: z.literal('reindex'),
  observation_id: z.string().min(1),
});

export const ServerGenerationJobPayloadSchema = z.discriminatedUnion('kind', [
  GenerateObservationsForEventJobSchema,
  GenerateObservationsForEventBatchJobSchema,
  GenerateSessionSummaryJobSchema,
  ReindexObservationJobSchema,
]);

export class ServerGenerationJobPayloadValidationError extends Error {
  readonly issues: z.ZodIssue[];

  constructor(issues: z.ZodIssue[]) {
    super(`invalid server generation job payload: ${issues.map(i => i.message).join('; ')}`);
    this.issues = issues;
  }
}

/**
 * Validate a candidate BullMQ payload against the discriminated union and
 * return a typed payload, or throw `ServerGenerationJobPayloadValidationError`.
 * Use this at every enqueue site so a malformed payload never enters the
 * transport — the worker MUST also re-validate from Postgres but defense in
 * depth is cheap.
 */
export function assertServerGenerationJobPayload(
  candidate: unknown,
): ServerGenerationJobPayload {
  const result = ServerGenerationJobPayloadSchema.safeParse(candidate);
  if (!result.success) {
    throw new ServerGenerationJobPayloadValidationError(result.error.issues);
  }
  return result.data as ServerGenerationJobPayload;
}
