// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { NextFunction, Request, Response } from 'express';
import { serverUsageGuards } from '../../../src/server/middleware/usage-guards.js';
import type { PostgresPool } from '../../../src/storage/postgres/pool.js';

const ENV_KEYS = [
  'CLAUDE_MEM_RATE_LIMIT_PER_MIN',
  'CLAUDE_MEM_MONTHLY_REQUEST_CAP',
  'CLAUDE_MEM_MONTHLY_TOKEN_CAP',
  'CLAUDE_MEM_USAGE_METERING',
] as const;

interface UsageRow { teamId: string; kind: string; quantity: number }

/** The two usage_events statements PostgresUsageRepository issues, over an in-memory table. */
function usageEventsPool(rows: UsageRow[]): PostgresPool {
  return {
    async query(sql: string, params: unknown[]) {
      if (sql.includes('INSERT INTO usage_events')) {
        rows.push({ teamId: String(params[1]), kind: String(params[3]), quantity: Number(params[4]) });
        return { rows: [] };
      }
      const total = rows
        .filter(row => row.teamId === params[0] && row.kind === params[1])
        .reduce((sum, row) => sum + row.quantity, 0);
      return { rows: [{ total: String(total) }] };
    },
  } as unknown as PostgresPool;
}

/** Runs one authenticated request through the guards; the status a guard answered, or 200. */
async function send(pool: PostgresPool): Promise<number> {
  const req = { method: 'GET', path: '/v1/usage', authContext: { teamId: 'team-1', projectId: null, apiKeyId: 'key-1' } };
  let status = 200;
  const res = {
    setHeader() {},
    status(code: number) { status = code; return res; },
    json() { return res; },
  };
  for (const guard of serverUsageGuards(pool)) {
    let passed = false;
    const next: NextFunction = () => { passed = true; };
    await guard(req as unknown as Request, res as unknown as Response, next);
    if (!passed) break;
  }
  await new Promise(resolve => setTimeout(resolve, 0)); // the request row is written fire-and-forget
  return status;
}

describe('serverUsageGuards', () => {
  let previous: Map<string, string | undefined>;

  beforeEach(() => {
    previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('enforces the monthly request cap when it is the only variable set', async () => {
    process.env.CLAUDE_MEM_MONTHLY_REQUEST_CAP = '2';
    const pool = usageEventsPool([]);

    expect(await send(pool)).toBe(200);
    expect(await send(pool)).toBe(200);
    expect(await send(pool)).toBe(402);
  });

  it('enforces the monthly request cap with metering on as well', async () => {
    process.env.CLAUDE_MEM_MONTHLY_REQUEST_CAP = '2';
    process.env.CLAUDE_MEM_USAGE_METERING = '1';
    const rows: UsageRow[] = [];
    const pool = usageEventsPool(rows);

    expect(await send(pool)).toBe(200);
    expect(await send(pool)).toBe(200);
    expect(await send(pool)).toBe(402);
    expect(rows.filter(row => row.kind === 'request')).toHaveLength(2);
  });

  it('records nothing and refuses nothing when no variable is set', async () => {
    const rows: UsageRow[] = [];
    const pool = usageEventsPool(rows);

    expect(await send(pool)).toBe(200);
    expect(await send(pool)).toBe(200);
    expect(rows).toEqual([]);
  });
});
