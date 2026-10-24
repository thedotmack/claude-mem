import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Server } from 'bun';
import { createWireGatewayFetchHandler } from '../../src/services/wire-gateway/router.js';
import { WireLaunchRegistry } from '../../src/services/wire-gateway/identity/launch-registry.js';
import { buildWireRoutesReport } from '../../src/services/wire-gateway/WireGatewayService.js';
import {
  RawHttpResponseReader,
  describeDirectHttpFailure,
  parseCompleteRawHttpResponse,
  requestDirectlyWithOutcome,
} from '../../src/services/wire-gateway/direct-http.js';
import { buildWireUsageSummary, summarizeInjectedMemory } from '../../src/services/wire-gateway/metrics/usage-summary.js';
import type { WireUsageLedgerRecord } from '../../src/services/wire-gateway/metrics/usage-ledger.js';

/** The router parts these tests never reach. */
const UNUSED_ROUTER_PARTS = {
  relay: () => Promise.reject(new Error('no relay in this test')),
  launchRegistry: new WireLaunchRegistry(),
  statusReport: () => Promise.reject(new Error('no status in this test')),
};

// What the viewer's Wire page (plan Phase 15) needs from the gateway side:
// GET /wire/routes, direct HTTP that ends on a late long-poll answer, and the
// usage summary the worker builds from the ledger.

const testRoot = join(process.env.CLAUDE_MEM_DATA_DIR!, 'viewer-wire-page-test');
const routesFilePath = join(testRoot, 'routes.json');

beforeAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const loopbackServer = { requestIP: () => ({ address: '127.0.0.1' }), timeout: () => {} } as unknown as Server<undefined>;

describe('GET /wire/routes', () => {
  it('lists each route with its upstream (credentials masked, written as is) and feature switches', () => {
    writeFileSync(routesFilePath, JSON.stringify({
      version: 1,
      routes: {
        codex: { agentId: 'codex', upstreamBaseUrl: 'https://user:secret@api.openai.com/v1', captureSource: 'wire', features: { endlessMode: true }, createdAt: '2026-10-24T00:00:00.000Z' },
        bare: { agentId: 'claude-code', upstreamBaseUrl: 'https://api.anthropic.com', captureSource: 'native', createdAt: '2026-10-24T00:00:00.000Z' },
        keyed: { agentId: 'gemini', upstreamBaseUrl: 'https://user:sekrit@gemini.example', captureSource: 'native', createdAt: '2026-10-24T00:00:00.000Z' },
      },
    }));
    const report = buildWireRoutesReport(routesFilePath, {});
    expect(report.routes).toHaveLength(3);
    const upstreamOf = (routeId: string) => report.routes.find(route => route.routeId === routeId)?.upstream;
    // The same masking `wire status` uses (withUrlSecretsMasked), and no "/" added to a bare origin.
    expect(upstreamOf('bare')).toBe('https://api.anthropic.com');
    expect(upstreamOf('keyed')).toBe('https://***@gemini.example');
    expect(JSON.stringify(report)).not.toContain('sekrit');
    expect(report.routes.find(route => route.routeId === 'codex')).toMatchObject({
      routeId: 'codex', agentId: 'codex', captureSource: 'wire', upstream: 'https://***@api.openai.com/v1', createdAt: '2026-10-24T00:00:00.000Z',
      endlessMode: { on: true, decidedBy: 'route' },
      memoryInjection: { decidedBy: 'setting' },
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('is served by the router, GET only, and answers 500 with why for an unreadable routes.json', async () => {
    let routesReport: () => unknown = () => buildWireRoutesReport(routesFilePath, {});
    const handle = createWireGatewayFetchHandler({ ...UNUSED_ROUTER_PARTS, listenHost: '127.0.0.1', routesReport: () => routesReport() });
    const ok = await handle(new Request('http://127.0.0.1/wire/routes'), loopbackServer);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { routes: unknown[] }).routes).toHaveLength(3);

    const post = await handle(new Request('http://127.0.0.1/wire/routes', { method: 'POST' }), loopbackServer);
    expect(post.status).toBe(405);

    writeFileSync(routesFilePath, '{ not json');
    routesReport = () => buildWireRoutesReport(routesFilePath, {});
    const broken = await handle(new Request('http://127.0.0.1/wire/routes'), loopbackServer);
    expect(broken.status).toBe(500);
    expect(((await broken.json()) as { error: { message: string } }).error.message).toContain('routes.json cannot be read');
  });

  it('refuses a foreign web page like every other gateway path', async () => {
    const handle = createWireGatewayFetchHandler({ ...UNUSED_ROUTER_PARTS, listenHost: '127.0.0.1', routesReport: () => ({ routes: [] }) });
    const response = await handle(new Request('http://127.0.0.1/wire/routes', { headers: { origin: 'https://evil.example' } }), loopbackServer);
    expect(response.status).toBe(403);
  });
});

describe('direct HTTP ends on the response, not on the server closing', () => {
  it('parses a response as soon as Content-Length or the last chunk says it is whole', () => {
    const head = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n';
    expect(parseCompleteRawHttpResponse(Buffer.from(`${head}Content-Length: 9\r\n\r\n{"seq":`))).toBeNull();
    expect(parseCompleteRawHttpResponse(Buffer.from(`${head}Content-Length: 9\r\n\r\n{"seq":7}`))).toEqual({ statusCode: 200, bodyText: '{"seq":7}' });
    expect(parseCompleteRawHttpResponse(Buffer.from(`${head}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n`))).toBeNull();
    expect(parseCompleteRawHttpResponse(Buffer.from(`${head}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n`))).toEqual({ statusCode: 200, bodyText: 'abc' });
    // Neither framing: only the server's close can end it.
    expect(parseCompleteRawHttpResponse(Buffer.from(`${head}\r\nabc`))).toBeNull();
  });

  it('keeps exactly Content-Length bytes: anything after them is not the body', () => {
    const response = parseCompleteRawHttpResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{"seq":7}HTTP/1.1 200 OK\r\n'));
    expect(response).toEqual({ statusCode: 200, bodyText: '{"seq":7}' });
  });

  it('joins the received bytes about twice, not once per chunk, even with the head split', () => {
    const body = 'x'.repeat(20_000);
    const chunks = [Buffer.from('HTTP/1.1 200 OK\r\nContent-Le'), Buffer.from(`ngth: ${body.length}\r\n\r\n`)];
    for (let offset = 0; offset < body.length; offset += 100) chunks.push(Buffer.from(body.slice(offset, offset + 100)));
    const realConcat = Buffer.concat;
    let copiedBytes = 0;
    Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
      const joined = realConcat(list, totalLength);
      copiedBytes += joined.length;
      return joined;
    }) as typeof Buffer.concat;
    let response = null;
    try {
      const reader = new RawHttpResponseReader();
      for (const chunk of chunks) {
        expect(response).toBeNull();
        response = reader.push(chunk);
      }
    } finally {
      Buffer.concat = realConcat;
    }
    expect(response).toEqual({ statusCode: 200, bodyText: body });
    // Once when the head arrives, once when the body is whole, plus the few-byte tails: linear, not 200 × 10 KB.
    expect(copiedBytes).toBeLessThan(3 * (body.length + 100));
  });

  it('says a gateway that closed a connection without a byte closed it (not "not HTTP")', async () => {
    const sockets = new Set<Socket>();
    const silentCloser = createServer(socket => {
      sockets.add(socket);
      socket.end();
    });
    await new Promise<void>(resolve => silentCloser.listen(0, '127.0.0.1', () => resolve()));
    const address = silentCloser.address();
    if (!address || typeof address === 'string') throw new Error('no TCP port');
    try {
      const outcome = await requestDirectlyWithOutcome({ url: `http://127.0.0.1:${address.port}/wire/trace`, timeoutMs: 3_000 });
      expect(outcome).toEqual({ failure: { reason: 'closed' } });
      if ('failure' in outcome) expect(describeDirectHttpFailure(outcome.failure, 'the wire gateway')).toBe('the wire gateway closed the connection without answering');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => silentCloser.close(() => resolve()));
    }
  });

  it("gets a long-poll's late answer from Bun.serve (1.3.9 keeps that connection open)", async () => {
    let release: (() => void) | null = null;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        await new Promise<void>(resolve => { release = resolve; });
        return Response.json({ seq: 7 });
      },
    });
    try {
      const pending = requestDirectlyWithOutcome({ url: `http://127.0.0.1:${server.port}/wire/trace?wait=1`, timeoutMs: 3_000 });
      for (let attempt = 0; attempt < 100 && !release; attempt++) await Bun.sleep(10);
      await Bun.sleep(100);
      const releasedAt = Date.now();
      release!();
      const outcome = await pending;
      expect(outcome).toEqual({ response: { statusCode: 200, bodyText: '{"seq":7}' } });
      expect(Date.now() - releasedAt).toBeLessThan(1_000);
    } finally {
      await server.stop(true);
    }
  });
});

describe('usage summary', () => {
  function record(overrides: Partial<WireUsageLedgerRecord>): WireUsageLedgerRecord {
    return {
      t: '2026-10-24T10:00:00.000Z', agent: 'codex', session: 's1', routeId: 'codex', model: 'm', status: 200,
      in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, ms: 1, ttftMs: null, kind: 'turn',
      stages: [], injectedTokensEst: 0, swappedTokensEst: 0, ...overrides,
    };
  }

  it('adds up injected memory per agent: tokens per request × requests', () => {
    expect(summarizeInjectedMemory([
      record({ agent: 'opencode', injectedTokensEst: 500 }),
      record({ agent: 'codex', injectedTokensEst: 100 }),
      record({ agent: 'codex', injectedTokensEst: 201 }),
      record({ agent: 'codex', injectedTokensEst: 0 }),
    ])).toEqual([
      { agentId: 'codex', requestsInjected: 2, injectedTokensEst: 301, averageTokensPerRequest: 151 },
      { agentId: 'opencode', requestsInjected: 1, injectedTokensEst: 500, averageTokensPerRequest: 500 },
    ]);
  });

  it('is empty, not missing, with no records', () => {
    expect(buildWireUsageSummary({ records: [], unreadableLines: 0 }, 7)).toEqual({ usageDays: 7, requests: 0, unreadableLines: 0, endless: [], injectedMemory: [], context: [] });
  });
});
