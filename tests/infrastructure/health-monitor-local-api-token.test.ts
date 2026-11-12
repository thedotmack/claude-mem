// Local API token mode (#5141) and the CLI's worker controls. `claude-mem start` (the
// SessionStart hook), the stdio MCP server, the installer and auto-update wait on
// /api/readiness, and `claude-mem stop`/`restart` POST /api/admin/shutdown. Both take the
// token, so HealthMonitor must send it to this machine's worker, and never to an explicit
// CLAUDE_MEM_WORKER_URL.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpShutdown, waitForReadiness } from '../../src/services/infrastructure/HealthMonitor.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

const TOKEN = 'health-monitor-local-token';

let server: Server;
let port = 0;
let seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
let token = TOKEN;
let spies: Array<ReturnType<typeof spyOn>> = [];

beforeAll(async () => {
  // A worker in local API token mode: everything but /api/health needs the header.
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.url !== '/api/health' && req.headers['x-claude-mem-token'] !== TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
  spies = [
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_LOCAL_API_TOKEN: token,
    })),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  seen = [];
  token = TOKEN;
});

afterAll(async () => {
  spies.forEach(spy => spy.mockRestore());
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('HealthMonitor with a local API token set', () => {
  it('waits out readiness on a token-mode worker well within the budget', async () => {
    const startedAt = Date.now();
    expect(await waitForReadiness(port, 2000)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(seen[0]?.headers['x-claude-mem-token']).toBe(TOKEN);
  });

  it('stops the worker: the shutdown POST carries the token', async () => {
    expect(await httpShutdown(port)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/admin/shutdown');
    expect(seen[0].headers['x-claude-mem-token']).toBe(TOKEN);
  });

  it('never sends the token to an explicit CLAUDE_MEM_WORKER_URL', async () => {
    expect(await waitForReadiness(port, 300, `http://127.0.0.1:${port}`)).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(request.headers['x-claude-mem-token']).toBeUndefined();
  });

  it('sends no token header when none is set', async () => {
    token = '';
    await waitForReadiness(port, 300);
    await httpShutdown(port);
    expect(seen.length).toBeGreaterThan(1);
    for (const request of seen) expect(request.headers['x-claude-mem-token']).toBeUndefined();
  });
});

describe('HealthMonitor with a worker host on another machine', () => {
  it('never sends the token when CLAUDE_MEM_WORKER_HOST is not loopback', async () => {
    const restore = spies[0];
    restore.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_WORKER_HOST: 'worker.invalid',
      CLAUDE_MEM_LOCAL_API_TOKEN: TOKEN,
    }));
    const sent: Array<HeadersInit | undefined> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => { sent.push(init?.headers); return new Response('{}'); }) as typeof fetch;
    try {
      await waitForReadiness(port, 300);
      await httpShutdown(port);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(sent.length).toBeGreaterThan(1);
    for (const headers of sent) expect(headers).toBeUndefined();
  });
});
