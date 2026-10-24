import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { WireViewerRoutes, isViewerOriginRequest, WIRE_GATEWAY_NOT_RUNNING_ERROR } from '../../../../src/services/worker/http/routes/WireViewerRoutes.js';
import { readWireRecordingConsentFile } from '../../../../src/services/wire-gateway/privacy/recording-consent.js';
import type { WireUsageLedgerRecord } from '../../../../src/services/wire-gateway/metrics/usage-ledger.js';

// The viewer's /api/wire/* routes, end to end over real sockets: an Express app
// with the routes in front of a fake gateway (Bun.serve) on loopback.

const testRoot = join(process.env.CLAUDE_MEM_DATA_DIR!, 'wire-viewer-routes-test');

interface FakeGatewayRequest { path: string; search: string; aborted: boolean }

let fakeGateway: ReturnType<typeof Bun.serve>;
const gatewayRequests: FakeGatewayRequest[] = [];
let releaseLongPoll: (() => void) | null = null;

let worker: HttpServer;
let workerOrigin = '';
let gatewayOrigin = '';
let config = { recordingForcedOff: false, retentionDays: 7 };
const consentFilePath = join(testRoot, 'consent.json');
const recordingsDirectory = join(testRoot, 'recordings');
const usageDirectory = join(testRoot, 'usage');

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
  fakeGateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const seen: FakeGatewayRequest = { path: url.pathname, search: url.search, aborted: false };
      gatewayRequests.push(seen);
      request.signal.addEventListener('abort', () => { seen.aborted = true; });
      if (url.pathname === '/wire/status') return Response.json({ gateway: { running: true }, agents: [{ agentId: 'codex', state: 'ok' }] });
      if (url.pathname === '/wire/routes') return Response.json({ routes: [{ routeId: 'codex' }] });
      if (url.pathname === '/wire/call') return Response.json({ error: { type: 'not_found_error', message: 'This call is no longer in the live trace.' } }, { status: 404 });
      if (url.pathname === '/wire/trace') {
        server.timeout(request, 0);
        if (url.searchParams.get('wait') === null) return Response.json({ seq: 0, calls: [], now: '' });
        const holdMs = Number(url.searchParams.get('hold') ?? 0);
        if (holdMs > 0) {
          // Answers on its own after holdMs, like the real feed's 25 s wait running out.
          await Bun.sleep(holdMs);
          return Response.json({ seq: 0, calls: [], now: 'held' });
        }
        // Held like the real feed's long-poll until the test releases it (or the client leaves).
        await new Promise<void>(resolve => {
          releaseLongPoll = resolve;
          request.signal.addEventListener('abort', () => resolve());
        });
        return Response.json({ seq: 7, calls: [{ id: 'call-1', seq: 7 }], now: 'later' });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    },
  });
  gatewayOrigin = `http://127.0.0.1:${fakeGateway.port}`;

  const app = express();
  app.use(express.json());
  new WireViewerRoutes({
    originPolicy: { allowedOrigins: ['https://viewer.example'], workerHost: '' },
    gatewayOrigin: () => gatewayOrigin,
    loadConfig: () => config,
    consentFilePath,
    recordingsDirectory,
    usageDirectory,
  }).setupRoutes(app);
  worker = await new Promise<HttpServer>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = worker.address();
  if (!address || typeof address === 'string') throw new Error('worker did not bind a TCP port');
  workerOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  releaseLongPoll?.();
  await new Promise<void>(resolve => worker.close(() => resolve()));
  await fakeGateway.stop(true);
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  gatewayRequests.length = 0;
  config = { recordingForcedOff: false, retentionDays: 7 };
});

describe('forwarded to the gateway over loopback', () => {
  it('passes status and routes through as the gateway answered them', async () => {
    const status = await fetch(`${workerOrigin}/api/wire/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ gateway: { running: true }, agents: [{ agentId: 'codex', state: 'ok' }] });
    const routes = await fetch(`${workerOrigin}/api/wire/routes`);
    expect(await routes.json()).toEqual({ routes: [{ routeId: 'codex' }] });
    expect(gatewayRequests.map(request => request.path)).toEqual(['/wire/status', '/wire/routes']);
  });

  it("keeps the query and the gateway's own status (a 404 from /wire/call stays a 404)", async () => {
    const response = await fetch(`${workerOrigin}/api/wire/call?id=abc%20def`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('no longer');
    expect(gatewayRequests[0]).toMatchObject({ path: '/wire/call', search: '?id=abc%20def' });
  });

  it('holds a long-poll open until the gateway answers it, then passes the answer on', async () => {
    const pending = fetch(`${workerOrigin}/api/wire/trace?after=5&wait=1`);
    // The gateway has the request and holds it: no answer yet.
    for (let attempt = 0; attempt < 100 && !releaseLongPoll; attempt++) await Bun.sleep(10);
    expect(gatewayRequests[0]).toMatchObject({ path: '/wire/trace', search: '?after=5&wait=1' });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Bun.sleep(300);
    expect(settled).toBe(false);
    releaseLongPoll!();
    releaseLongPoll = null;
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seq: 7, calls: [{ id: 'call-1', seq: 7 }], now: 'later' });
  });

  it("lets go of the gateway's long-poll when the viewer leaves", async () => {
    const viewerLeft = new AbortController();
    const pending = fetch(`${workerOrigin}/api/wire/trace?after=0&wait=1`, { signal: viewerLeft.signal }).then(
      () => 'answered',
      () => 'aborted',
    );
    for (let attempt = 0; attempt < 100 && !releaseLongPoll; attempt++) await Bun.sleep(10);
    viewerLeft.abort();
    expect(await pending).toBe('aborted');
    for (let attempt = 0; attempt < 100 && !gatewayRequests[0]?.aborted; attempt++) await Bun.sleep(10);
    expect(gatewayRequests[0]?.aborted).toBe(true);
    releaseLongPoll = null;
  });

  it('forwards a long-poll with the long-poll timeout: an answer after the 2 s quick timeout still arrives', async () => {
    const response = await fetch(`${workerOrigin}/api/wire/trace?after=0&wait=1&hold=2300`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ seq: 0, calls: [], now: 'held' });
  }, 10_000);

  it('says a gateway that closed the connection without answering closed it (502), not "not HTTP"', async () => {
    const sockets = new Set<Socket>();
    const silentCloser = createServer(socket => {
      sockets.add(socket);
      socket.end();
    });
    await new Promise<void>(resolve => silentCloser.listen(0, '127.0.0.1', () => resolve()));
    const address = silentCloser.address();
    if (!address || typeof address === 'string') throw new Error('no TCP port');
    const saved = gatewayOrigin;
    gatewayOrigin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${workerOrigin}/api/wire/status`);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'the wire gateway closed the connection without answering' });
    } finally {
      gatewayOrigin = saved;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => silentCloser.close(() => resolve()));
    }
  });

  it('answers 503 {error:"wire gateway not running"} when nothing listens', async () => {
    const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const closedOrigin = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    const saved = gatewayOrigin;
    gatewayOrigin = closedOrigin;
    try {
      for (const path of ['/api/wire/status', '/api/wire/routes', '/api/wire/trace?after=0&wait=1', '/api/wire/call?id=x']) {
        const response = await fetch(`${workerOrigin}${path}`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: WIRE_GATEWAY_NOT_RUNNING_ERROR });
      }
    } finally {
      gatewayOrigin = saved;
    }
  });
});

describe('the viewer page only', () => {
  const readRoutes = ['/api/wire/status', '/api/wire/routes', '/api/wire/trace?after=0', '/api/wire/call?id=x', '/api/wire/consent', '/api/wire/usage'];

  it('refuses every route to another page CORS admits (a localhost dev server), before asking the gateway', async () => {
    for (const path of readRoutes) {
      const response = await fetch(`${workerOrigin}${path}`, { headers: { origin: 'http://localhost:3000' } });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain('viewer');
    }
    for (const path of ['/api/wire/consent', '/api/wire/consent/clear']) {
      const response = await fetch(`${workerOrigin}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' }, body: JSON.stringify(path.endsWith('clear') ? {} : { recording: true }),
      });
      expect(response.status).toBe(403);
    }
    expect(gatewayRequests).toEqual([]);
  });

  it("answers the viewer's own origin, an allowlisted one, and a client with no Origin (the CLI)", async () => {
    const localhostOrigin = workerOrigin.replace('127.0.0.1', 'localhost');
    for (const headers of [{ origin: workerOrigin }, { origin: localhostOrigin }, { origin: 'https://viewer.example' }, {}] as Array<Record<string, string>>) {
      for (const path of readRoutes) {
        const response = await fetch(`${workerOrigin}${path}`, { headers });
        expect(response.status).not.toBe(403);
      }
    }
  });
});

describe('recording consent, from the viewer only', () => {
  beforeEach(() => {
    rmSync(consentFilePath, { force: true });
    rmSync(recordingsDirectory, { recursive: true, force: true });
  });

  it('is off until decided, and says what, where and how long', async () => {
    const response = await fetch(`${workerOrigin}/api/wire/consent`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      recording: false, forcedOff: false, effective: false, decidedAt: null, retentionDays: 7, recordingsDirectory,
    });
  });

  it('refuses a change without an Origin (a script) or from another page', async () => {
    for (const origin of [undefined, 'http://localhost:3000', 'https://evil.example']) {
      const response = await fetch(`${workerOrigin}/api/wire/consent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ recording: true }),
      });
      expect(response.status).toBe(403);
    }
    expect(existsSync(consentFilePath)).toBe(false);
  });

  it("turns recording on and off from the viewer's own origin", async () => {
    const on = await fetch(`${workerOrigin}/api/wire/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: workerOrigin }, body: JSON.stringify({ recording: true }),
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ recording: true, effective: true });
    expect(readWireRecordingConsentFile(consentFilePath)?.recording).toBe(true);
    const off = await fetch(`${workerOrigin}/api/wire/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: workerOrigin }, body: JSON.stringify({ recording: false }),
    });
    expect(await off.json()).toMatchObject({ recording: false, effective: false });
  });

  it('reports CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false as forced off, whatever the decision', async () => {
    await fetch(`${workerOrigin}/api/wire/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: workerOrigin }, body: JSON.stringify({ recording: true }),
    });
    config = { recordingForcedOff: true, retentionDays: 3 };
    const response = await fetch(`${workerOrigin}/api/wire/consent`);
    expect(await response.json()).toMatchObject({ recording: true, forcedOff: true, effective: false, retentionDays: 3 });
  });

  it('clears every recording from the viewer only, keeping the decision', async () => {
    await fetch(`${workerOrigin}/api/wire/consent`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: workerOrigin }, body: JSON.stringify({ recording: true }),
    });
    mkdirSync(join(recordingsDirectory, '2026-10-24'), { recursive: true });
    writeFileSync(join(recordingsDirectory, '2026-10-24', 'turns.jsonl'), '{}\n');
    const refused = await fetch(`${workerOrigin}/api/wire/consent/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(403);
    expect(existsSync(recordingsDirectory)).toBe(true);
    const generationBefore = readWireRecordingConsentFile(consentFilePath)!.generation;
    const cleared = await fetch(`${workerOrigin}/api/wire/consent/clear`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: workerOrigin }, body: '{}',
    });
    expect(cleared.status).toBe(200);
    expect(existsSync(recordingsDirectory)).toBe(false);
    expect(readWireRecordingConsentFile(consentFilePath)).toMatchObject({ recording: true, generation: generationBefore + 1 });
  });

  it('answers 500 with why when consent.json cannot be read (unknown is never shown as off)', async () => {
    writeFileSync(consentFilePath, 'not json');
    const response = await fetch(`${workerOrigin}/api/wire/consent`);
    expect(response.status).toBe(500);
  });
});

describe('isViewerOriginRequest', () => {
  const policy = { allowedOrigins: ['https://viewer.example'], workerHost: '' };
  it("needs an Origin that is the worker's own page", () => {
    expect(isViewerOriginRequest({ headers: {} }, policy)).toBe(false);
    expect(isViewerOriginRequest({ headers: { origin: 'http://127.0.0.1:37777', host: '127.0.0.1:37777' } }, policy)).toBe(true);
    expect(isViewerOriginRequest({ headers: { origin: 'http://localhost:37777', host: '127.0.0.1:37777' } }, policy)).toBe(true);
    expect(isViewerOriginRequest({ headers: { origin: 'https://viewer.example', host: '127.0.0.1:37777' } }, policy)).toBe(true);
    expect(isViewerOriginRequest({ headers: { origin: 'http://127.0.0.1:37778', host: '127.0.0.1:37777' } }, policy)).toBe(false);
    expect(isViewerOriginRequest({ headers: { origin: 'http://localhost:3000', host: '127.0.0.1:37777' } }, policy)).toBe(false);
    expect(isViewerOriginRequest({ headers: { origin: 'null', host: '127.0.0.1:37777' } }, policy)).toBe(false);
  });
});

describe('usage, read from the ledger on disk', () => {
  function record(overrides: Partial<WireUsageLedgerRecord>): WireUsageLedgerRecord {
    return {
      t: '2026-10-24T10:00:00.000Z', agent: 'codex', session: 's1', routeId: 'codex', model: 'm', status: 200,
      in: 100, out: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, ms: 5, ttftMs: 1, kind: 'turn',
      stages: [], injectedTokensEst: 0, swappedTokensEst: 0, ...overrides,
    };
  }

  it('counts a valid-JSON line of the wrong shape (null) as unreadable instead of failing the panel', async () => {
    rmSync(usageDirectory, { recursive: true, force: true });
    mkdirSync(usageDirectory, { recursive: true });
    writeFileSync(join(usageDirectory, `${new Date().toISOString().slice(0, 10)}.jsonl`), `null\n${JSON.stringify(record({}))}\n{"agent":"codex"}\n`);
    const response = await fetch(`${workerOrigin}/api/wire/usage`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requests: 1, unreadableLines: 2 });
  });

  it('counts only the retention window, even with older day files the gateway has not pruned', async () => {
    rmSync(usageDirectory, { recursive: true, force: true });
    mkdirSync(usageDirectory, { recursive: true });
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    writeFileSync(join(usageDirectory, `${longAgo}.jsonl`), `${JSON.stringify(record({}))}\n`);
    writeFileSync(join(usageDirectory, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(record({}))}\n`);
    const response = await fetch(`${workerOrigin}/api/wire/usage`);
    expect(await response.json()).toMatchObject({ usageDays: 7, requests: 1, unreadableLines: 0 });
  });

  it('answers savings, injected memory and context buckets, also while the gateway is down', async () => {
    rmSync(usageDirectory, { recursive: true, force: true });
    mkdirSync(usageDirectory, { recursive: true });
    const lines = [
      record({ t: '2026-10-24T10:00:00.000Z', cacheWrite: 1000, injectedTokensEst: 300, stages: ['memory-injection'],
        buckets: { system: 100, tools: 100, memory: 300, files: 0, results: 0, chat: 500 } }),
      record({ t: '2026-10-24T10:01:00.000Z', cacheRead: 900, cacheWrite: 200, swappedTokensEst: 4000, injectedTokensEst: 100, stages: ['memory-injection', 'endless-mode'] }),
    ];
    writeFileSync(join(usageDirectory, `${new Date().toISOString().slice(0, 10)}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const saved = gatewayOrigin;
    gatewayOrigin = 'http://127.0.0.1:1';
    try {
      const response = await fetch(`${workerOrigin}/api/wire/usage`);
      expect(response.status).toBe(200);
      const summary = await response.json() as any;
      expect(summary.usageDays).toBe(7);
      expect(summary.requests).toBe(2);
      expect(summary.injectedMemory).toEqual([{ agentId: 'codex', requestsInjected: 2, injectedTokensEst: 400, averageTokensPerRequest: 200 }]);
      expect(summary.endless[0]).toMatchObject({ agentId: 'codex', conversationsSwapped: 1, requestsSwapped: 1, tokensSaved: 4000 });
      expect(summary.endless[0].beforeFirstSwap).toMatchObject({ requests: 1, cacheWrite: 1000 });
      expect(summary.context[0]).toMatchObject({ agent: 'codex', requests: 1, tags: ['memory-heavy'] });
      expect(summary.context[0].shares.memory).toBeCloseTo(0.3);
    } finally {
      gatewayOrigin = saved;
    }
  });
});
