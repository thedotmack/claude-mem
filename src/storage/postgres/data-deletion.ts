// SPDX-License-Identifier: Apache-2.0
//
// Data deletion ("forget") for Server Beta — the right-to-erasure path a paid
// cloud must have. Everything is scoped by (project_id, team_id) so a key can
// only ever delete its own team's data. observation_sources cascade from both
// observations and agent_events, so deleting those rows removes their links too.

import type { PostgresPool } from './pool.js';
import { withPostgresTransaction } from './pool.js';

export interface PurgeCounts {
  observations: number;
  agentEvents: number;
  sessions: number;
  jobs: number;
}

export class PostgresDataDeletionRepository {
  constructor(private readonly pool: PostgresPool) {}

  /** Delete a single observation (and its sources, via cascade). Returns true if a row was removed. */
  async deleteObservation(input: { id: string; projectId: string; teamId: string }): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM observations WHERE id = $1 AND project_id = $2 AND team_id = $3`,
      [input.id, input.projectId, input.teamId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Purge ALL of a project's captured content — observations, raw agent events,
   * sessions, and generation jobs — in one transaction. Keeps the project shell
   * (config/membership) so the team can keep using it. Returns per-table counts.
   */
  async purgeProjectMemory(input: { projectId: string; teamId: string }): Promise<PurgeCounts> {
    const { projectId, teamId } = input;
    return withPostgresTransaction(this.pool, async (client) => {
      const del = async (table: string): Promise<number> => {
        const res = await client.query(
          `DELETE FROM ${table} WHERE project_id = $1 AND team_id = $2`,
          [projectId, teamId],
        );
        return res.rowCount ?? 0;
      };
      // Observations first (their sources cascade). Jobs/events next — deleting
      // agent_events cascades its jobs + sources, so the job count is a floor.
      const observations = await del('observations');
      const jobs = await del('observation_generation_jobs');
      const agentEvents = await del('agent_events');
      const sessions = await del('server_sessions');
      return { observations, agentEvents, sessions, jobs };
    });
  }
}
