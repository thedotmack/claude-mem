// SPDX-License-Identifier: Apache-2.0
//
// Fixed-window rate-limit counters. One atomic UPSERT per request increments the
// (subject, window) bucket and returns the new count, so the limiter needs a
// single round-trip and is correct across concurrent server instances (the
// increment happens in Postgres, not in app memory).

import type { PostgresQueryable } from './utils.js';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  windowStart: Date;
}

export class PostgresRateLimitRepository {
  constructor(private readonly client: PostgresQueryable) {}

  /**
   * Atomically increment the current window's counter for `subjectId` and
   * report whether it is still within `limit`.
   */
  async hit(input: { subjectId: string; windowStart: Date; limit: number }): Promise<RateLimitResult> {
    const res = await this.client.query<{ count: string }>(
      `INSERT INTO rate_limit_counters (subject_id, window_start, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (subject_id, window_start)
       DO UPDATE SET count = rate_limit_counters.count + 1
       RETURNING count`,
      [input.subjectId, input.windowStart],
    );
    const count = Number(res.rows[0]?.count ?? 0);
    return { allowed: count <= input.limit, count, limit: input.limit, windowStart: input.windowStart };
  }

  /** Best-effort cleanup of expired windows. Call off the hot path. */
  async prune(before: Date): Promise<void> {
    await this.client.query(`DELETE FROM rate_limit_counters WHERE window_start < $1`, [before]);
  }
}
