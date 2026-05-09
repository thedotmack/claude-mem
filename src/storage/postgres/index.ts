// SPDX-License-Identifier: Apache-2.0

import type { PostgresQueryable } from './utils.js';
import { PostgresAgentEventsRepository } from './agent-events.js';
import { PostgresAuthRepository } from './auth.js';
import {
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository
} from './generation-jobs.js';
import { PostgresObservationRepository, PostgresObservationSourcesRepository } from './observations.js';
import { PostgresProjectsRepository } from './projects.js';
import { PostgresServerSessionsRepository } from './server-sessions.js';
import { PostgresTeamsRepository } from './teams.js';

export * from './agent-events.js';
export * from './auth.js';
export * from './config.js';
export * from './generation-jobs.js';
export * from './observations.js';
export * from './pool.js';
export * from './projects.js';
export * from './schema.js';
export * from './server-sessions.js';
export * from './teams.js';
export type * from './utils.js';

export interface PostgresStorageRepositories {
  teams: PostgresTeamsRepository;
  projects: PostgresProjectsRepository;
  auth: PostgresAuthRepository;
  sessions: PostgresServerSessionsRepository;
  agentEvents: PostgresAgentEventsRepository;
  observations: PostgresObservationRepository;
  observationSources: PostgresObservationSourcesRepository;
  observationGenerationJobs: PostgresObservationGenerationJobRepository;
  observationGenerationJobEvents: PostgresObservationGenerationJobEventsRepository;
}

export function createPostgresStorageRepositories(client: PostgresQueryable): PostgresStorageRepositories {
  return {
    teams: new PostgresTeamsRepository(client),
    projects: new PostgresProjectsRepository(client),
    auth: new PostgresAuthRepository(client),
    sessions: new PostgresServerSessionsRepository(client),
    agentEvents: new PostgresAgentEventsRepository(client),
    observations: new PostgresObservationRepository(client),
    observationSources: new PostgresObservationSourcesRepository(client),
    observationGenerationJobs: new PostgresObservationGenerationJobRepository(client),
    observationGenerationJobEvents: new PostgresObservationGenerationJobEventsRepository(client)
  };
}
