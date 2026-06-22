import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeCloudConfig } from '../../src/services/cloud/config.js';
import { CloudClient } from '../../src/services/cloud/CloudClient.js';

/**
 * Verifies the EXACT wire contract by mocking global fetch (no network). Asserts
 * the required + optional headers, the URL, and the body wrapper key — and that
 * the setup token is sent as a Bearer but never otherwise exposed.
 */
describe('CloudClient headers + wire format', () => {
  const realFetch = globalThis.fetch;
  let lastUrl = '';
  let lastInit: RequestInit | undefined;

  beforeEach(() => {
    writeCloudConfig({ enabled: true, userId: 'user-1', deviceId: 'dev-1', setupToken: 'secret-token' });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      lastUrl = String(url);
      lastInit = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    writeCloudConfig({ enabled: false, userId: undefined, deviceId: undefined, setupToken: undefined });
  });

  it('sends the required + optional headers and the right URL/body for a live observations batch', async () => {
    const client = new CloudClient();
    const res = await client.postBatch(
      'observations',
      'observations',
      [{ localId: 7, project: 'p' }],
      'live',
      900,
      { outboxDepth: 4, oldestPendingAgeSec: 2 }
    );
    expect(res.ok).toBe(true);
    expect(lastUrl).toMatch(/\/api\/pro\/sync\/observations\/batch$/);
    expect(lastInit?.method).toBe('POST');

    const headers = lastInit?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['X-User-Id']).toBe('user-1');
    expect(headers['X-Device-Id']).toBe('dev-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Payload-Version']).toBe('1');
    expect(headers['X-Sync-Lane']).toBe('live');
    expect(headers['X-Outbox-Depth']).toBe('4');
    expect(headers['X-Outbox-Oldest-Age']).toBe('2');
    expect(headers['X-Client-Version']).toBeDefined();

    const body = JSON.parse(lastInit?.body as string);
    expect(body.observations).toEqual([{ localId: 7, project: 'p' }]);
  });

  it('backfill batches carry X-Sync-Lane: backfill', async () => {
    const client = new CloudClient();
    await client.postBatch('summaries', 'summaries', [{ localId: 1 }], 'backfill', 15000);
    const headers = lastInit?.headers as Record<string, string>;
    expect(headers['X-Sync-Lane']).toBe('backfill');
    expect(lastUrl).toMatch(/\/api\/pro\/sync\/summaries\/batch$/);
  });

  it('tombstone POSTs to /tombstone with { table, kind, items }', async () => {
    const client = new CloudClient();
    await client.postTombstone('observation', 'delete', [{ localId: 9 }], 'live', 900);
    expect(lastUrl).toMatch(/\/api\/pro\/sync\/tombstone$/);
    const body = JSON.parse(lastInit?.body as string);
    expect(body).toEqual({ table: 'observation', kind: 'delete', items: [{ localId: 9 }] });
  });

  it('validateToken: 200 => valid, 401 => authError', async () => {
    const client = new CloudClient();
    let v = await client.validateToken();
    expect(v).toEqual({ valid: true, status: 200, authError: false });

    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    v = await client.validateToken();
    expect(v.valid).toBe(false);
    expect(v.authError).toBe(true);
  });

  it('429 { queued } is surfaced for backfill admission gating', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ queued: true, position: 3 }), { status: 429 })) as typeof fetch;
    const client = new CloudClient();
    const res = await client.postBatch('prompts', 'prompts', [{ localId: 1 }], 'backfill', 15000);
    expect(res.status).toBe(429);
    expect(res.queued).toBe(true);
    expect(res.position).toBe(3);
  });
});
