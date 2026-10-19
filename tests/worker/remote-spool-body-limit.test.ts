import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { createMiddleware } from '../../src/services/worker/http/middleware.js';
import { HookSpoolRoutes } from '../../src/services/worker/http/routes/HookSpoolRoutes.js';

const mib = 1024 * 1024;
let server: Server;
let directory: string;

async function start(limit?: string | number) {
  directory = mkdtempSync(join(tmpdir(), 'claude-mem-body-limit-'));
  const spool = new HookSpool(directory);
  const markers = new Set<string>();
  const app = express();
  app.use(...createMiddleware());
  new HookSpoolRoutes(spool, () => ({
    isConsumed: key => markers.has(key),
    markConsumed: key => { markers.add(key); },
    clearConsumed: key => { markers.delete(key); },
    pruneConsumedBefore: () => {},
  }), () => {}, () => 'test-token', limit).setupRoutes(app);
  app.post('/other', (_req, res) => { res.sendStatus(204); });
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('server did not bind');
  return { spool, url: `http://127.0.0.1:${bound.port}` };
}

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function body(bytes: number) {
  const envelope = { protocolVersion: 1, entry: {
    kind: 'observation', enqueuedAtEpochMs: 1700000000000,
    payload: { contentSessionId: 's', platformSource: 'codex', toolName: 'exec', toolResponse: '' },
  } };
  envelope.entry.payload.toolResponse = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(envelope)));
  return JSON.stringify(envelope);
}

function send(url: string, payload: string, token = 'test-token') {
  return fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
  }, body: payload });
}

describe('remote spool body limit', () => {
  it('preserves the default five MiB limit', async () => {
    const { url, spool } = await start();
    expect((await send(`${url}/api/spool/ingest`, body(5 * mib + 1))).status).toBe(413);
    expect(spool.entries()).toEqual([]);
  });

  it.each(['', 'invalid', '1.5', '0', '-1', 'Infinity', '9007199254740992'])('falls back to five MiB for invalid configuration %s', async limit => {
    const { url, spool } = await start(limit);
    expect((await send(`${url}/api/spool/ingest`, body(5 * mib + 1))).status).toBe(413);
    expect(spool.entries()).toEqual([]);
  });

  it('persists a complete envelope at the configured twenty MiB boundary', async () => {
    const { url, spool } = await start(String(20 * mib));
    const payload = body(20 * mib);
    expect(Buffer.byteLength(payload)).toBe(20 * mib);
    expect((await send(`${url}/api/spool/ingest`, payload)).status).toBe(202);
    expect(spool.entries()).toEqual([JSON.parse(payload).entry]);
  });

  it('rejects one byte over the configured limit without persisting', async () => {
    const { url, spool } = await start(20 * mib);
    expect((await send(`${url}/api/spool/ingest`, body(20 * mib + 1))).status).toBe(413);
    expect(spool.entries()).toEqual([]);
  });

  it('authenticates before parsing malformed or oversized JSON', async () => {
    const { url, spool } = await start(20 * mib);
    expect((await send(`${url}/api/spool/ingest`, '{invalid', 'wrong')).status).toBe(401);
    expect((await send(`${url}/api/spool/ingest`, body(20 * mib + 1), 'wrong')).status).toBe(401);
    expect(spool.entries()).toEqual([]);
  });

  it('keeps unrelated API requests at five MiB', async () => {
    const { url } = await start(20 * mib);
    expect((await send(`${url}/other`, body(5 * mib + 1))).status).toBe(413);
  });

  it('uses the same limit for Express case-insensitive and trailing-slash routes', async () => {
    const { url } = await start(20 * mib);
    expect((await send(`${url}/API/SPOOL/INGEST/`, body(6 * mib))).status).toBe(202);
  });
});
