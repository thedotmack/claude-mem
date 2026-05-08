// SPDX-License-Identifier: Apache-2.0

import type { PostgresQueryable, JsonObject } from './utils.js';
import { newId, queryOne, toEpoch, toJsonObject } from './utils.js';

export type PostgresTeamRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface PostgresTeam {
  id: string;
  name: string;
  metadata: JsonObject;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

export interface PostgresTeamMember {
  teamId: string;
  userId: string;
  role: PostgresTeamRole;
  metadata: JsonObject;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

interface TeamRow {
  id: string;
  name: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: PostgresTeamRole;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export class PostgresTeamsRepository {
  constructor(private client: PostgresQueryable) {}

  async create(input: { id?: string; name: string; metadata?: JsonObject }): Promise<PostgresTeam> {
    const id = input.id ?? newId();
    const row = await queryOne<TeamRow>(
      this.client,
      `
        INSERT INTO teams (id, name, metadata)
        VALUES ($1, $2, $3::jsonb)
        RETURNING *
      `,
      [id, input.name, JSON.stringify(input.metadata ?? {})]
    );
    return mapTeamRow(row!);
  }

  async addMember(input: {
    teamId: string;
    userId: string;
    role: PostgresTeamRole;
    metadata?: JsonObject;
  }): Promise<PostgresTeamMember> {
    const row = await queryOne<TeamMemberRow>(
      this.client,
      `
        INSERT INTO team_members (team_id, user_id, role, metadata)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (team_id, user_id) DO UPDATE SET
          role = excluded.role,
          metadata = excluded.metadata,
          updated_at = now()
        RETURNING *
      `,
      [input.teamId, input.userId, input.role, JSON.stringify(input.metadata ?? {})]
    );
    return mapTeamMemberRow(row!);
  }

  async getByIdForUser(input: {
    id: string;
    userId: string;
  }): Promise<PostgresTeam | null> {
    const row = await queryOne<TeamRow>(
      this.client,
      `
        SELECT teams.*
        FROM teams
        INNER JOIN team_members ON team_members.team_id = teams.id
        WHERE teams.id = $1 AND team_members.user_id = $2
      `,
      [input.id, input.userId]
    );
    return row ? mapTeamRow(row) : null;
  }

  async getMember(teamId: string, userId: string): Promise<PostgresTeamMember | null> {
    const row = await queryOne<TeamMemberRow>(
      this.client,
      'SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, userId]
    );
    return row ? mapTeamMemberRow(row) : null;
  }
}

function mapTeamRow(row: TeamRow): PostgresTeam {
  return {
    id: row.id,
    name: row.name,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}

function mapTeamMemberRow(row: TeamMemberRow): PostgresTeamMember {
  return {
    teamId: row.team_id,
    userId: row.user_id,
    role: row.role,
    metadata: toJsonObject(row.metadata),
    createdAtEpoch: toEpoch(row.created_at),
    updatedAtEpoch: toEpoch(row.updated_at)
  };
}
