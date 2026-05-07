// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import { CreateTeamMemberSchema, CreateTeamSchema, TeamMemberSchema, TeamSchema, type CreateTeam, type CreateTeamMember, type Team, type TeamMember, type TeamRole } from '../../core/schemas/team.js';
import { ensureServerStorageSchema } from './schema.js';
import { parseJsonObject, stringifyJson } from './serde.js';

interface TeamRow {
  id: string;
  name: string;
  slug: string | null;
  metadata: string;
  created_at_epoch: number;
  updated_at_epoch: number;
}

interface TeamMemberRow {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  metadata: string;
  created_at_epoch: number;
}

function mapTeamRow(row: TeamRow): Team {
  return TeamSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  });
}

function mapTeamMemberRow(row: TeamMemberRow): TeamMember {
  return TeamMemberSchema.parse({
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    role: row.role,
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch
  });
}

export class TeamsRepository {
  constructor(private db: Database) {
    ensureServerStorageSchema(this.db);
  }

  create(input: CreateTeam): Team {
    const team = CreateTeamSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO teams (id, name, slug, metadata, created_at_epoch, updated_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, team.name, team.slug ?? null, stringifyJson(team.metadata), now, now);

    return this.getById(id)!;
  }

  addMember(input: CreateTeamMember): TeamMember {
    const member = CreateTeamMemberSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO team_members (id, team_id, user_id, role, metadata, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, user_id) DO UPDATE SET
        role = excluded.role,
        metadata = excluded.metadata
    `).run(id, member.teamId, member.userId, member.role, stringifyJson(member.metadata), now);

    return this.getMember(member.teamId, member.userId)!;
  }

  getById(id: string): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as TeamRow | null;
    return row ? mapTeamRow(row) : null;
  }

  getMember(teamId: string, userId: string): TeamMember | null {
    const row = this.db.prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId) as TeamMemberRow | null;
    return row ? mapTeamMemberRow(row) : null;
  }

  listMembers(teamId: string): TeamMember[] {
    const rows = this.db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY created_at_epoch ASC').all(teamId) as TeamMemberRow[];
    return rows.map(mapTeamMemberRow);
  }
}
