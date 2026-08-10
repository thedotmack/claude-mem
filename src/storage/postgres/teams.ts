// SPDX-License-Identifier: Apache-2.0

import type { PostgresQueryable, JsonObject } from './utils.js';
import { newId, queryOne, toEpoch, toJsonObject } from './utils.js';

export interface PostgresTeam {
  id: string;
  name: string;
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
