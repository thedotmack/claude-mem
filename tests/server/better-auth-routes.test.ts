// SPDX-License-Identifier: Apache-2.0
//
// #5453 — the worker mounts BetterAuthRoutes for Pro sign-in, but on a fresh
// install every /api/auth/* request 500'd: better-auth was missing from the
// plugin's runtime dependencies, and once present by hand its tables were
// never created ("Database schema mismatch"). These tests pin the table
// half: the first auth request must create the better-auth schema in the
// worker's database and then serve normally.

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import type { Server } from 'node:http';
import { tmpdir } from 'os';
import path from 'path';

// Point the data dir at a temp dir before the auth modules load:
// src/shared/paths.ts freezes DATA_DIR at import time. The previous value
// is restored in afterAll below so other test files in this process never
// inherit this file's (deleted) temp dir.
const dataDir = mkdtempSync(path.join(tmpdir(), 'cmem-auth-routes-'));
const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = dataDir;
const { BetterAuthRoutes } = await import('../../src/server/auth/BetterAuthRoutes.js');

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

  afterAll(() => {
    if (previousDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
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
  });

  it('keeps serving from the cached handler and reads the session table', async () => {
    await start();
    expect((await fetch(`${baseUrl}/api/auth/ok`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/auth/ok`)).status).toBe(200);

    // A session lookup against the migrated schema returns "no session"
    // instead of failing on the missing session table.
    const sessionRes = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { Cookie: 'better-auth.session_token=bogus-token' },
    });
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toBeNull();
  });
});
