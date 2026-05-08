// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

mock.module('../../src/shared/worker-utils.js', () => ({
  fetchWithTimeout: async (url: string, init: RequestInit, _timeoutMs: number) => {
    return globalThis.fetch(url, init);
  },
}));

import {
  ServerBetaClient,
  ServerBetaClientError,
  isServerBetaClientError,
} from '../../src/services/hooks/server-beta-client.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

let captured: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

function installFetch(handler: (req: CapturedRequest) => Response | Promise<Response>): void {
  // Reset capture buffer for each test.
  captured = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init.headers ?? {};
    if (Array.isArray(rawHeaders)) {
      for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
    } else {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const req: CapturedRequest = { url, method: String(init.method ?? 'GET'), headers, body };
    captured.push(req);
    return handler(req);
  }) as typeof globalThis.fetch;
}

describe('ServerBetaClient', () => {
  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws missing_api_key when apiKey is empty', async () => {
    const client = new ServerBetaClient({ serverBaseUrl: 'http://x', apiKey: '' });
    let caught: unknown;
    try {
      await client.recordEvent({
        projectId: 'p1',
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(isServerBetaClientError(caught)).toBe(true);
    if (caught instanceof ServerBetaClientError) {
      expect(caught.kind).toBe('missing_api_key');
      expect(caught.isFallbackEligible()).toBe(true);
    }
  });

  it('startSession sends POST /v1/sessions/start with expected payload', async () => {
    installFetch(async () => new Response(JSON.stringify({ session: { id: 'sess-1', projectId: 'p1', teamId: 't1', externalSessionId: 'ext', contentSessionId: 'ext' } }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999/', apiKey: 'cmem_test' });
    const result = await client.startSession({
      projectId: 'p1',
      externalSessionId: 'ext',
      contentSessionId: 'ext',
      platformSource: 'claude-code',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/sessions/start');
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.headers.authorization).toBe('Bearer cmem_test');
    expect(captured[0]?.headers['content-type']).toBe('application/json');
    expect((captured[0]?.body as Record<string, unknown>).projectId).toBe('p1');
    expect((captured[0]?.body as Record<string, unknown>).externalSessionId).toBe('ext');
    expect(result.session.id).toBe('sess-1');
  });

  it('recordEvent sends POST /v1/events with payload', async () => {
    installFetch(async () => new Response(JSON.stringify({ event: { id: 'e1', projectId: 'p1', serverSessionId: null } }), { status: 201 }));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    const result = await client.recordEvent({
      projectId: 'p1',
      contentSessionId: 'cs1',
      sourceType: 'hook',
      eventType: 'tool_use',
      occurredAtEpoch: 1234,
      payload: { tool: 'Read' },
    });
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/events');
    expect((captured[0]?.body as Record<string, unknown>).eventType).toBe('tool_use');
    expect((captured[0]?.body as Record<string, unknown>).sourceType).toBe('hook');
    expect((captured[0]?.body as Record<string, unknown>).occurredAtEpoch).toBe(1234);
    expect(result.event.id).toBe('e1');
  });

  it('endSession sends POST /v1/sessions/:id/end', async () => {
    installFetch(async () => new Response(JSON.stringify({ session: { id: 'sess-1' } }), { status: 200 }));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    await client.endSession({ sessionId: 'sess-1' });
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/sessions/sess-1/end');
    expect(captured[0]?.method).toBe('POST');
  });

  it('throws transport error on fetch failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    let caught: unknown;
    try {
      await client.recordEvent({ projectId: 'p1', sourceType: 'hook', eventType: 'tool_use', occurredAtEpoch: 1 });
    } catch (error) {
      caught = error;
    }
    expect(isServerBetaClientError(caught)).toBe(true);
    if (caught instanceof ServerBetaClientError) {
      expect(caught.kind).toBe('transport');
      expect(caught.isFallbackEligible()).toBe(true);
    }
  });

  it('classifies 5xx as fallback-eligible http_error', async () => {
    installFetch(async () => new Response('boom', { status: 502 }));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    let caught: unknown;
    try {
      await client.recordEvent({ projectId: 'p1', sourceType: 'hook', eventType: 'tool_use', occurredAtEpoch: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerBetaClientError);
    if (caught instanceof ServerBetaClientError) {
      expect(caught.kind).toBe('http_error');
      expect(caught.status).toBe(502);
      expect(caught.isFallbackEligible()).toBe(true);
    }
  });

  it('classifies 4xx (not 429) as non-fallback http_error', async () => {
    installFetch(async () => new Response('bad', { status: 400 }));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    let caught: unknown;
    try {
      await client.recordEvent({ projectId: 'p1', sourceType: 'hook', eventType: 'tool_use', occurredAtEpoch: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerBetaClientError);
    if (caught instanceof ServerBetaClientError) {
      expect(caught.kind).toBe('http_error');
      expect(caught.status).toBe(400);
      expect(caught.isFallbackEligible()).toBe(false);
    }
  });

  it('classifies 429 as fallback-eligible http_error', async () => {
    installFetch(async () => new Response('rate', { status: 429 }));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    let caught: unknown;
    try {
      await client.recordEvent({ projectId: 'p1', sourceType: 'hook', eventType: 'tool_use', occurredAtEpoch: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerBetaClientError);
    if (caught instanceof ServerBetaClientError) {
      expect(caught.status).toBe(429);
      expect(caught.isFallbackEligible()).toBe(true);
    }
  });

  it('strips trailing slash from baseUrl', async () => {
    installFetch(async () => new Response(JSON.stringify({ session: { id: 's' } }), { status: 200 }));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999///', apiKey: 'cmem_test' });
    await client.endSession({ sessionId: 's' });
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/sessions/s/end');
  });

  // ----- Phase 8 — MCP-backing methods. These exercise the same /v1/* paths
  // the REST core exposes, so MCP tools never have a private write path. -----

  it('addObservation sends POST /v1/memories with content', async () => {
    installFetch(async () => new Response(
      JSON.stringify({ memory: { id: 'o1', projectId: 'p1', teamId: 't1', serverSessionId: null, kind: 'manual', content: 'hello', metadata: {} } }),
      { status: 201 },
    ));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    const result = await client.addObservation({
      projectId: 'p1',
      content: 'hello',
      kind: 'manual',
      metadata: { source: 'mcp' },
    });
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/memories');
    expect(captured[0]?.method).toBe('POST');
    expect((captured[0]?.body as Record<string, unknown>).content).toBe('hello');
    expect((captured[0]?.body as Record<string, unknown>).kind).toBe('manual');
    expect(result.memory.id).toBe('o1');
  });

  it('searchObservations sends POST /v1/search with query', async () => {
    installFetch(async () => new Response(
      JSON.stringify({ observations: [{ id: 'o1', projectId: 'p1', content: 'matched' }] }),
      { status: 200 },
    ));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    const result = await client.searchObservations({
      projectId: 'p1',
      query: 'login bug',
      limit: 5,
    });
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/search');
    expect((captured[0]?.body as Record<string, unknown>).query).toBe('login bug');
    expect((captured[0]?.body as Record<string, unknown>).limit).toBe(5);
    expect(result.observations[0]?.id).toBe('o1');
  });

  it('contextObservations sends POST /v1/context and returns context string', async () => {
    installFetch(async () => new Response(
      JSON.stringify({
        observations: [{ id: 'o1', projectId: 'p1', content: 'a' }, { id: 'o2', projectId: 'p1', content: 'b' }],
        context: 'a\n\nb',
      }),
      { status: 200 },
    ));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    const result = await client.contextObservations({ projectId: 'p1', query: 'q' });
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/context');
    expect(result.context).toBe('a\n\nb');
    expect(result.observations).toHaveLength(2);
  });

  it('getJobStatus sends GET /v1/jobs/:id', async () => {
    installFetch(async () => new Response(
      JSON.stringify({ generationJob: { id: 'j1', status: 'queued' } }),
      { status: 200 },
    ));
    const client = new ServerBetaClient({ serverBaseUrl: 'http://localhost:9999', apiKey: 'cmem_test' });
    const result = await client.getJobStatus('j1');
    expect(captured[0]?.url).toBe('http://localhost:9999/v1/jobs/j1');
    expect(captured[0]?.method).toBe('GET');
    expect(result.generationJob.status).toBe('queued');
  });

  it('getJobStatus rejects empty jobId', async () => {
    const client = new ServerBetaClient({ serverBaseUrl: 'http://x', apiKey: 'cmem_test' });
    let caught: unknown;
    try {
      await client.getJobStatus('');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServerBetaClientError);
  });

  it('payload builders omit absent fields', () => {
    const client = new ServerBetaClient({ serverBaseUrl: 'http://x', apiKey: 'k' });
    expect(client.buildAddObservationPayload({ projectId: 'p', content: 'c' })).toEqual({
      projectId: 'p',
      content: 'c',
    });
    expect(client.buildSearchPayload({ projectId: 'p', query: 'q' })).toEqual({
      projectId: 'p',
      query: 'q',
    });
    expect(client.buildSearchPayload({ projectId: 'p', query: 'q', limit: 7 })).toEqual({
      projectId: 'p',
      query: 'q',
      limit: 7,
    });
  });
});
