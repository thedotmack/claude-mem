// Adapted from Bleed00/dsh-claude-mem, Apache-2.0; see dsh/LICENSE.
import { describe, expect, it, mock, afterEach } from 'bun:test'
import { WorkerClient } from '../../src/integrations/dsh-plugin/worker.js'

const originalFetch = globalThis.fetch;
function stubFetchGlobal(value: any): void { globalThis.fetch = value; }

const limits = { baseUrl: 'http://127.0.0.1:39999', timeoutMs: 30_000 }

function stubFetch(body: unknown): void {
  stubFetchGlobal( mock(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as Response))
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('WorkerClient.search', () => {
  it('normalizes an MCP-shaped content response into content text', async () => {
    stubFetch({ content: [{ type: 'text', text: 'index table' }] })
    const client = new WorkerClient(limits)
    const result = await client.search({ query: 'q' })
    expect(result.content).toBe('index table')
    expect(result.items).toEqual([])
  })

  it('normalizes a bare array response into items', async () => {
    stubFetch([{ id: 9, title: 'nine', narrative: 'full text', project: 'p' }])
    const client = new WorkerClient(limits)
    const result = await client.search({ query: 'q' })
    expect(result.items).toMatchObject([{ id: 9, title: 'nine', narrative: 'full text', project: 'p' }])
  })

  it('deduplicates the rendered index text (rows differing only by id)', async () => {
    const text = '| #627 | 12:22 PM | ◆ | Media prompt processing session initiated | ~144 |\n| #671 | ″ | ◆ | Media prompt processing session initiated | ~144 |'
    stubFetch({ content: [{ type: 'text', text }] })
    const client = new WorkerClient({ ...limits, dedupe: true })
    const result = await client.search({ query: 'q' })
    expect(result.content).toContain('#627')
    expect(result.content).not.toContain('#671')
  })

  it('leaves rendered text untouched when dedupe is disabled', async () => {
    const text = '| #627 | 12:22 PM | ◆ | Media prompt processing session initiated | ~144 |\n| #671 | ″ | ◆ | Media prompt processing session initiated | ~144 |'
    stubFetch({ content: [{ type: 'text', text }] })
    const client = new WorkerClient({ ...limits, dedupe: false })
    const result = await client.search({ query: 'q' })
    expect(result.content).toBe(text)
  })

  it('omits platformSource when not set (unfiltered)', async () => {
    const fetchMock = mock(async (_url: unknown, _init?: unknown) =>
      ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) as Response)
    stubFetchGlobal( fetchMock)
    const client = new WorkerClient(limits)
    await client.search({ query: 'q' })
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).not.toContain('platformSource')
  })

  it('forwards platformSource when present as an optional filter', async () => {
    const fetchMock = mock(async (_url: unknown, _init?: unknown) =>
      ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) as Response)
    stubFetchGlobal( fetchMock)
    const client = new WorkerClient(limits)
    await client.search({ query: 'q', platformSource: 'dsh' })
    const url = fetchMock.mock.calls[0]![0] as string
    expect(url).toContain('platformSource=dsh')
  })
})

describe('WorkerClient.getObservations', () => {
  it('posts ids as a batch body and normalizes the bare array', async () => {
    const fetchMock = mock(async (_url: unknown, init?: { method?: string; body?: unknown }) =>
      ({ ok: true, status: 200, json: async () => ([{ id: 650, title: 'nine', narrative: 'full' }]), text: async () => '[]' }) as Response)
    stubFetchGlobal( fetchMock)
    const client = new WorkerClient(limits)
    const result = await client.getObservations({ ids: [650, 694] })
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
    expect(result.items).toMatchObject([{ id: 650, title: 'nine', narrative: 'full' }])
  })

  it.each([true, false])('returns every requested record even when content matches (dedupe %p)', async (dedupe) => {
    stubFetch([
      { id: 627, title: 'Media prompt', narrative: 'same' },
      { id: 671, title: 'Media prompt', narrative: 'same' },
      { id: 715, title: 'Media prompt', narrative: 'distinct' },
    ])
    const client = new WorkerClient({ ...limits, dedupe })
    const result = await client.getObservations({ ids: [627, 671, 715] })
    expect(result.items.map(i => i.id)).toEqual([627, 671, 715])
  })

  it('rejects an empty id list', async () => {
    const client = new WorkerClient(limits)
    await expect(client.getObservations({ ids: [] })).rejects.toMatchObject({ code: 'MEM_INVALID_REQUEST' })
  })

  it('decodes JSON-string list/object fields for parity with the raw API', async () => {
    stubFetch([{
      id: 650,
      title: 'nine',
      narrative: 'full',
      facts: '["a","b"]',
      concepts: '[]',
      files_read: '["x.c"]',
      files_modified: '[]',
      metadata: '{"kind":"architecture"}',
      created_at: '2026-08-02T14:03:15.937Z',
      created_at_epoch: 1785679395937,
      memory_session_id: 'manual-VCU',
      subtitle: 'Manual memory',
      content_hash: 'abc123',
    }])
    const client = new WorkerClient(limits)
    const result = await client.getObservations({ ids: [650] })
    expect(result.items[0]).toMatchObject({
      id: 650,
      title: 'nine',
      narrative: 'full',
      facts: ['a', 'b'],
      concepts: [],
      filesRead: ['x.c'],
      filesModified: [],
      metadata: { kind: 'architecture' },
      createdAt: '2026-08-02T14:03:15.937Z',
      createdAtEpoch: 1785679395937,
      memorySessionId: 'manual-VCU',
      subtitle: 'Manual memory',
      contentHash: 'abc123',
    })
  })

  it('drops a non-JSON list string rather than leaking the raw string', async () => {
    stubFetch([{ id: 650, title: 'nine', facts: 'not-json', concepts: '[]' }])
    const client = new WorkerClient(limits)
    const result = await client.getObservations({ ids: [650] })
    expect(result.items[0].concepts).toEqual([])
    expect(result.items[0].facts).toBeUndefined()
  })
})

describe('WorkerClient.context', () => {
  it('sends the checkout alongside a project override so the worker can apply exclusions', async () => {
    const fetchMock = mock(async (_url: unknown) => ({ ok: true, status: 200, text: async () => '' }) as Response)
    stubFetchGlobal(fetchMock)
    await new WorkerClient(limits).context({ projects: 'override', cwd: '/work/excluded' })
    const query = new URL(String(fetchMock.mock.calls[0]![0])).searchParams
    expect(query.get('projects')).toBe('override')
    expect(query.get('cwd')).toBe('/work/excluded')
  })
})
