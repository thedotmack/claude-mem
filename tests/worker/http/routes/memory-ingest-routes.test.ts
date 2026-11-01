// POST /api/memory/ingest reads only Claude Code's projects directory: a
// caller-supplied source anywhere else is refused with 400 before any file is
// read, and a missing source is a 400, not a 500.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { MemoryIngestRoutes } from '../../../../src/services/worker/http/routes/MemoryIngestRoutes.js';
import { logger } from '../../../../src/utils/logger.js';

let server: Server | undefined;
let port = 0;
let outside: string;
let storeCalls = 0;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(async () => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
  storeCalls = 0;
  outside = mkdtempSync(join(tmpdir(), 'memory-ingest-outside-'));
  writeFileSync(join(outside, 'notes.md'), '# private\n\nnot a Claude Code memory');

  const dbManager = {
    getSessionStore: () => {
      storeCalls++;
      return {};
    },
    getChromaSync: () => null,
    getCloudSync: () => null,
  };
  const app = express();
  app.use(express.json());
  new MemoryIngestRoutes(dbManager as any).setupRoutes(app);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('memory-ingest test server did not bind a port'));
        return;
      }
      port = addr.port;
      resolve();
    });
  });
});

afterEach(async () => {
  loggerSpies.forEach(spy => spy.mockRestore());
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(err => (err ? reject(err) : resolve()));
    server = undefined;
  });
  rmSync(outside, { recursive: true, force: true });
});

async function postIngest(body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/memory/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/memory/ingest source restriction', () => {
  it('refuses a source outside Claude Code\'s projects directory with 400', async () => {
    const response = await postIngest({ source: outside });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('projects directory');
  });

  it('answers a missing source with 400, not 500', async () => {
    const response = await postIngest({ source: join(outside, 'does-not-exist') });

    expect(response.status).toBe(400);
  });

  it('requires a source or all=true', async () => {
    const response = await postIngest({});

    expect(response.status).toBe(400);
  });
});
