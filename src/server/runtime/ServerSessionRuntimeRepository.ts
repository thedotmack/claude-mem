// SPDX-License-Identifier: Apache-2.0

import {
  PostgresServerSessionsRepository,
  type PostgresServerSession,
} from '../../storage/postgres/server-sessions.js';
import type { PostgresAgentEvent } from '../../storage/postgres/agent-events.js';
import type { JsonObject } from '../../storage/postgres/utils.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';

// ServerSessionRuntimeRepository is the runtime helper layer used by Server
// beta routes and generation policies. It is intentionally thin: every method
// requires explicit `team_id` + `project_id` and validates scope through the
// underlying PostgresServerSessionsRepository (which calls
// assertProjectOwnership before any write). It does NOT cache state — every
// call hits Postgres so the runtime never trusts in-memory ActiveSession-style
// objects, per the Phase 6 anti-pattern guard.

export interface ServerSessionScope {
  teamId: string;
  projectId: string;
}

export interface GetActiveSessionInput extends ServerSessionScope {
  externalSessionId: string;
  contentSessionId?: string | null;
  agentId?: string | null;
  agentType?: string | null;
  platformSource?: string | null;
  metadata?: JsonObject;
}

export interface ServerSessionRuntimeRepositoryOptions {
  client: PostgresQueryable;
}

export class ServerSessionRuntimeRepository {
  private readonly repo: PostgresServerSessionsRepository;

  constructor(private readonly options: ServerSessionRuntimeRepositoryOptions) {
    this.repo = new PostgresServerSessionsRepository(options.client);
  }

  /**
   * Find or create the canonical Server beta session row for an external
   * session id. Idempotent on (project_id, external_session_id).
   *
   * Anti-pattern guard: this MUST NOT consult worker `ActiveSession` or any
   * legacy SessionStore. server_sessions is the canonical model.
   */
  async getActiveSession(input: GetActiveSessionInput): Promise<PostgresServerSession> {
    const existing = await this.repo.findByExternalIdForScope({
      externalSessionId: input.externalSessionId,
      projectId: input.projectId,
      teamId: input.teamId,
    });
    if (existing) {
      return existing;
    }
    return this.repo.create({
      projectId: input.projectId,
      teamId: input.teamId,
      externalSessionId: input.externalSessionId,
      contentSessionId: input.contentSessionId ?? null,
      agentId: input.agentId ?? null,
      agentType: input.agentType ?? null,
      platformSource: input.platformSource ?? null,
      metadata: input.metadata ?? {},
    });
  }

  async getById(input: { id: string } & ServerSessionScope): Promise<PostgresServerSession | null> {
    return this.repo.getByIdForScope({
      id: input.id,
      projectId: input.projectId,
      teamId: input.teamId,
    });
  }

  async findByExternalId(input: {
    externalSessionId: string;
  } & ServerSessionScope): Promise<PostgresServerSession | null> {
    return this.repo.findByExternalIdForScope({
      externalSessionId: input.externalSessionId,
      projectId: input.projectId,
      teamId: input.teamId,
    });
  }

  async listUnprocessedEvents(
    input: { serverSessionId: string; limit?: number } & ServerSessionScope,
  ): Promise<PostgresAgentEvent[]> {
    const params: {
      serverSessionId: string;
      projectId: string;
      teamId: string;
      limit?: number;
    } = {
      serverSessionId: input.serverSessionId,
      projectId: input.projectId,
      teamId: input.teamId,
    };
    if (input.limit !== undefined) {
      params.limit = input.limit;
    }
    return this.repo.listUnprocessedEvents(params);
  }

  /**
   * End the session if not already ended. Idempotent — re-ending a session
   * returns the unchanged row and never creates a duplicate summary job
   * because the (team_id, project_id, source_type='session_summary',
   * source_id) UNIQUE constraint on observation_generation_jobs collapses
   * duplicate enqueue attempts.
   */
  async endSession(
    input: { id: string } & ServerSessionScope,
  ): Promise<PostgresServerSession | null> {
    return this.repo.endSession({
      id: input.id,
      projectId: input.projectId,
      teamId: input.teamId,
    });
  }

  async markGenerationStarted(
    input: { id: string } & ServerSessionScope,
  ): Promise<PostgresServerSession | null> {
    return this.repo.markGenerationStarted({
      id: input.id,
      projectId: input.projectId,
      teamId: input.teamId,
    });
  }

  async markGenerationCompleted(
    input: { id: string } & ServerSessionScope,
  ): Promise<PostgresServerSession | null> {
    return this.repo.markGenerationCompleted({
      id: input.id,
      projectId: input.projectId,
      teamId: input.teamId,
    });
  }

  async markGenerationFailed(
    input: { id: string; error?: string | null } & ServerSessionScope,
  ): Promise<PostgresServerSession | null> {
    return this.repo.markGenerationFailed({
      id: input.id,
      projectId: input.projectId,
      teamId: input.teamId,
      error: input.error ?? null,
    });
  }
}

export function createServerSessionRuntimeRepository(
  pool: PostgresPool,
): ServerSessionRuntimeRepository {
  return new ServerSessionRuntimeRepository({ client: pool });
}
