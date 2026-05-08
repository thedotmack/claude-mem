// SPDX-License-Identifier: Apache-2.0

import type {
  ObservationGenerationJobSourceType,
  ObservationGenerationJobStatus
} from '../../storage/postgres/generation-jobs.js';

export type ServerGenerationJobKind = 'event' | 'event-batch' | 'summary' | 'reindex';

export type ServerGenerationJobStatus = ObservationGenerationJobStatus;

export interface ServerGenerationJob {
  kind: ServerGenerationJobKind;
  team_id: string;
  project_id: string;
  source_type: ObservationGenerationJobSourceType;
  source_id: string;
  generation_job_id: string;
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
