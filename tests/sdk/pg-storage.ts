// SPDX-License-Identifier: Apache-2.0
//
// Test-only convenience facade over the Postgres repositories. Production
// code constructs the individual repositories it needs directly; only tests
// want "one of everything" against a single client.

import {
  PostgresAgentEventsRepository,
  PostgresAuthRepository,
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
  PostgresObservationRepository,
  PostgresObservationSourcesRepository,
  PostgresProjectsRepository,
  PostgresRateLimitRepository,
  PostgresServerSessionsRepository,
  PostgresTeamsRepository,
  PostgresUsageRepository,
  type PostgresQueryable
} from '../../src/storage/postgres/index.js';

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
  usage: PostgresUsageRepository;
  rateLimits: PostgresRateLimitRepository;
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
    observationGenerationJobEvents: new PostgresObservationGenerationJobEventsRepository(client),
    usage: new PostgresUsageRepository(client),
    rateLimits: new PostgresRateLimitRepository(client)
  };
}
