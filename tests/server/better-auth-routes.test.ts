// SPDX-License-Identifier: Apache-2.0
//
// #5453 — the worker mounts BetterAuthRoutes for Pro sign-in, but on a fresh
// install every /api/auth/* request 500'd: better-auth was missing from the
// plugin's runtime dependencies, and once present by hand its tables were
// never created ("Database schema mismatch"). These tests pin the table
// half: the first auth request must create the better-auth schema in the
// worker's database and then serve normally.

import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import type { Server } from 'node:http';

import { BetterAuthRoutes } from '../../src/server/auth/BetterAuthRoutes.js';

const AUTH_TABLES = [
  'user',
  'session',
  'account',
  'verification',
  'apikey',
  'organization',
  'team',
  'teamMember',
  'member',
  'invitation',
];

describe('BetterAuthRoutes', () => {
  let db: Database;
  let server: Server;
  let baseUrl: string;

  afterEach(() => {
    server?.close();
    db?.close();
  });

  async function start(): Promise<void> {
    db = new Database(':memory:');
    const app = express();
    new BetterAuthRoutes(() => db).setupRoutes(app);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).send(err instanceof Error ? err.message : String(err));
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server has no port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  function tableNames(): string[] {
    return (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
  }

  it('creates the better-auth tables on first use and serves /api/auth/ok', async () => {
    await start();
    expect(tableNames()).not.toContain('user');

    const res = await fetch(`${baseUrl}/api/auth/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const tables = tableNames();
    for (const table of AUTH_TABLES) {
      expect(tables).toContain(table);
    }

    // A session lookup against the migrated schema returns "no session"
    // instead of failing on the missing session table.
    const sessionRes = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { Cookie: 'better-auth.session_token=bogus-token' },
    });
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toBeNull();
  });
});
