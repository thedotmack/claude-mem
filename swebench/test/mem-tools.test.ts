import { describe, expect, test } from 'bun:test';
import { dispatchMemTool, isMemTool, MemSearchClient, memSearchToolDefinitions, MEM_TOOL_NAMES } from '../src/mem-tools.ts';
import type { WorkerConfig } from '../src/config.ts';

interface Captured {
  url: string;
  method: string;
  body?: string;
}

function mockFetch(response: unknown, status = 200): { fetchImpl: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    captured.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(typeof response === 'string' ? response : JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

const worker: WorkerConfig = { baseUrl: 'http://127.0.0.1:37742', project: 'claude-mem' };

describe('tool identity', () => {
  test('isMemTool recognizes the three tools', () => {
    for (const n of MEM_TOOL_NAMES) expect(isMemTool(n)).toBe(true);
    expect(isMemTool('bash')).toBe(false);
  });
  test('tool definitions expose exactly the mem tools', () => {
    expect(memSearchToolDefinitions().map((t) => t.function.name).sort()).toEqual([...MEM_TOOL_NAMES].sort());
  });
});

describe('mem_search', () => {
  test('GETs /api/search with query + folded project scope', async () => {
    const { fetchImpl, captured } = mockFetch({ content: [{ type: 'text', text: '| #1 | ... | title |' }] });
    const client = new MemSearchClient(worker, fetchImpl);
    const out = await dispatchMemTool('mem_search', { query: 'auth bug', limit: 5 }, client);
    expect(captured).toHaveLength(1);
    const u = new URL(captured[0]!.url);
    expect(u.pathname).toBe('/api/search');
    expect(u.searchParams.get('query')).toBe('auth bug');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('project')).toBe('claude-mem');
    expect(out).toContain('title');
  });
});

describe('mem_timeline', () => {
  test('GETs /api/timeline with anchor', async () => {
    const { fetchImpl, captured } = mockFetch({ content: [{ type: 'text', text: 'timeline' }] });
    const client = new MemSearchClient(worker, fetchImpl);
    await dispatchMemTool('mem_timeline', { anchor: 42, depth_before: 2 }, client);
    const u = new URL(captured[0]!.url);
    expect(u.pathname).toBe('/api/timeline');
    expect(u.searchParams.get('anchor')).toBe('42');
    expect(u.searchParams.get('depth_before')).toBe('2');
  });
});

describe('mem_get_observations', () => {
  test('POSTs /api/observations/batch with numeric ids', async () => {
    const { fetchImpl, captured } = mockFetch([{ id: 1, title: 'x' }]);
    const client = new MemSearchClient(worker, fetchImpl);
    await dispatchMemTool('mem_get_observations', { ids: [1, 2, 3] }, client);
    expect(captured[0]!.method).toBe('POST');
    expect(new URL(captured[0]!.url).pathname).toBe('/api/observations/batch');
    const body = JSON.parse(captured[0]!.body!);
    expect(body.ids).toEqual([1, 2, 3]);
    expect(body.project).toBe('claude-mem');
  });

  test('coerces string / #-prefixed ids', async () => {
    const { fetchImpl, captured } = mockFetch([]);
    const client = new MemSearchClient(worker, fetchImpl);
    await dispatchMemTool('mem_get_observations', { ids: '#11131, 10942' }, client);
    expect(JSON.parse(captured[0]!.body!).ids).toEqual([11131, 10942]);
  });

  test('empty ids returns a helpful error without calling the worker', async () => {
    const { fetchImpl, captured } = mockFetch([]);
    const client = new MemSearchClient(worker, fetchImpl);
    const out = await dispatchMemTool('mem_get_observations', { ids: [] }, client);
    expect(captured).toHaveLength(0);
    expect(out).toMatch(/requires a non-empty/);
  });
});

describe('error handling', () => {
  test('non-ok worker response is surfaced as text', async () => {
    const { fetchImpl } = mockFetch('boom', 500);
    const client = new MemSearchClient(worker, fetchImpl);
    const out = await dispatchMemTool('mem_search', { query: 'x' }, client);
    expect(out).toMatch(/worker error \(500\)/);
  });
});
