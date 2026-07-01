// SPDX-License-Identifier: Apache-2.0
//
// Usage metering store. Append-only per-team usage events, aggregated for
// quotas (src/server/middleware/rate-limit.ts) and, later, billing. `kind` is
// open-ended so the same table records request counts, generated observations,
// and provider token spend without a schema change.

import type { JsonObject, PostgresQueryable } from './utils.js';
import { newId } from './utils.js';

export type UsageKind = 'request' | 'observation' | 'tokens_in' | 'tokens_out' | (string & {});

export class PostgresUsageRepository {
  constructor(private readonly client: PostgresQueryable) {}

  async record(input: {
    teamId: string;
    projectId?: string | null;
    kind: UsageKind;
    quantity?: number;
    metadata?: JsonObject;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO usage_events (id, team_id, project_id, kind, quantity, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        newId(),
        input.teamId,
        input.projectId ?? null,
        input.kind,
        Math.max(0, Math.trunc(input.quantity ?? 1)),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  /** Total quantity of one `kind` for a team since `since` — the quota read. */
  async total(input: { teamId: string; kind: UsageKind; since: Date }): Promise<number> {
    const res = await this.client.query<{ total: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::bigint AS total
         FROM usage_events
        WHERE team_id = $1 AND kind = $2 AND created_at >= $3`,
      [input.teamId, input.kind, input.since],
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  /** Per-kind totals for a team since `since` — the /v1/usage read. */
  async summarize(input: { teamId: string; since: Date }): Promise<Record<string, number>> {
    const res = await this.client.query<{ kind: string; total: string }>(
      `SELECT kind, SUM(quantity)::bigint AS total
         FROM usage_events
        WHERE team_id = $1 AND created_at >= $2
        GROUP BY kind`,
      [input.teamId, input.since],
    );
    const out: Record<string, number> = {};
    for (const row of res.rows) out[row.kind] = Number(row.total);
    return out;
  }
}
