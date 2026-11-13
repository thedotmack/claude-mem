import { describe, expect, test } from 'bun:test';
import { applyImport, collectImportRows, planImport, requestJson, validateImportOptions, type ImportOptions } from '../../src/npx-cli/commands/import-memory.js';

const mem0: ImportOptions = { provider: 'mem0', account: 'fixture-account', scope: 'fixture-user', project: ' migration,project ' };
const supermemory: ImportOptions = { ...mem0, provider: 'supermemory', scope: 'fixture_namespace' };
const row = (id = 'm1') => ({ id, memory: 'Use UTC for scheduled jobs.', user_id: mem0.scope, created_at: '2026-11-01T00:00:00Z', metadata: { team: 'fixture' } });
const smRow = (id = 's1') => ({ id, memory: 'Remember the blue moon.', isLatest: true, isForgotten: false, isInference: false, isStatic: true, version: 1, metadata: {}, system: { createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } });
const pages = (...responses: unknown[]) => (async () => Response.json(responses.shift())) as typeof fetch;

describe('provider import contracts', () => {
  test('Mem0 uses a scoped read POST, sequential pages and no supplied next URL', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [{ count: 2, next: 'https://other.invalid/steal', previous: null, results: [row()] }, { count: 2, next: null, previous: 'ignored', results: [row('m2')] }];
    const rows = await collectImportRows(mem0, 'synthetic', (async (url, init) => { requests.push({ url: String(url), init }); return Response.json(responses.shift()); }) as typeof fetch);
    expect(rows).toHaveLength(2);
    expect(requests[1].url).toBe('https://api.mem0.ai/v3/memories/?page_size=100&page=2');
    expect(JSON.parse(requests[0].init!.body as string)).toEqual({ filters: { user_id: 'fixture-user' }, show_expired: false });
    expect(requests[0].init?.headers).toEqual({ Authorization: 'Token synthetic', 'Content-Type': 'application/json' });
    expect(requests[0].init?.redirect).toBe('error');
  });
  test('Supermemory preserves opaque cursors and requests current active memories', async () => {
    const requests: Array<{ url: URL; body: unknown }> = [];
    const responses = [{ memories: [smRow()], pagination: { totalItems: 2, hasMore: true, nextCursor: 'opaque+/=&' } }, { memories: [smRow('s2')], pagination: { totalItems: 0, hasMore: false, nextCursor: null } }];
    await collectImportRows(supermemory, 'synthetic', (async (url, init) => { requests.push({ url: new URL(String(url)), body: JSON.parse(init!.body as string) }); return Response.json(responses.shift()); }) as typeof fetch);
    expect(requests[1].url.searchParams.get('cursor')).toBe('opaque+/=&');
    expect(requests[1].url.searchParams.has('page')).toBe(false);
    expect(requests[0].body).toEqual({ include: { forgotten: false } });
  });
  test('documents request canonical content, never substitute summaries', async () => {
    let body: unknown;
    await collectImportRows({ ...supermemory, documents: true }, 'synthetic', (async (_, init) => { body = JSON.parse(init!.body as string); return Response.json({ documents: [], pagination: { totalItems: 0, hasMore: false, nextCursor: null } }); }) as typeof fetch);
    expect(body).toEqual({ include: { content: true } });
    expect(() => planImport([{ id: 'd', content: null, summary: 'Not the original', system: { status: 'done' } }], { ...supermemory, documents: true })).toThrow('Source text');
  });
  test('incomplete totals and duplicate pages fail before planning', async () => {
    await expect(collectImportRows(mem0, 'x', pages({ count: 2, next: null, results: [row()] }))).rejects.toThrow('count');
    await expect(collectImportRows(mem0, 'x', pages({ count: 2, next: 'more', results: [row()] }, { count: 2, next: null, results: [row()] }))).rejects.toThrow('Duplicate');
  });
  test('changed totals, empty pages and repeated cursors stop', async () => {
    await expect(collectImportRows(mem0, 'x', pages({ count: 2, next: 'more', results: [row()] }, { count: 3, next: null, results: [row('m2')] }))).rejects.toThrow('changed');
    await expect(collectImportRows(mem0, 'x', pages({ count: 2, next: 'more', results: [] }))).rejects.toThrow('empty');
    await expect(collectImportRows(supermemory, 'x', pages({ memories: [smRow()], pagination: { totalItems: 3, hasMore: true, nextCursor: 'a' } }, { memories: [smRow('s2')], pagination: { hasMore: true, nextCursor: 'a' } }))).rejects.toThrow('repeated');
  });
  test('invalid pagination, limits and namespace reject', async () => {
    await expect(collectImportRows(mem0, 'x', pages({ count: 1, results: [row()] }))).rejects.toThrow('pagination');
    await expect(collectImportRows({ ...mem0, maxRecords: 1 }, 'x', pages({ count: 2, next: null, results: [] }))).rejects.toThrow('max-records');
    expect(() => validateImportOptions({ ...supermemory, scope: '../another' })).toThrow('namespace');
    expect(() => validateImportOptions({ ...mem0, account: '' })).toThrow('source-account');
    expect(() => validateImportOptions({ ...mem0, documents: true })).toThrow('documents');
  });
  test('wrong source owner and unknown lifecycle reject', () => {
    expect(() => planImport([{ ...row(), user_id: 'another-user' }], mem0)).toThrow('different user');
    expect(() => planImport([{ ...row(), lifecycle_state: 'mystery' }], mem0)).toThrow('lifecycle');
    expect(() => planImport([{ id: 's', memory: 'missing flags' }], supermemory)).toThrow('lifecycle');
  });
  test('expired, replaced, forgotten and older versions are skipped', () => {
    expect(planImport([row('keep'), { ...row('expired'), expiration_date: '2020-01-01' }, { ...row('old'), replaced_by: 'new' }], mem0).skipped).toBe(2);
    expect(planImport([smRow(), { ...smRow('old'), isLatest: false }, { ...smRow('forgotten'), isForgotten: true }], supermemory).skipped).toBe(2);
    expect(() => planImport([{ ...row(), expiration_date: 'bad' }], mem0)).toThrow('expiration');
  });
  test('raw metadata, provenance and text are preserved; control keys stay nested', () => {
    const source = { ...row(), memory: '  Original text\nSecond line. ', metadata: { project: 'other', platformSource: 'other', sourceFingerprint: 'malicious', when: 'original' } };
    const note = planImport([source], mem0).notes[0];
    expect(note.text).toBe(source.memory); expect(note.project).toBe(mem0.project);
    expect(note.metadata.platformSource).toBe('mem0');
    expect((note.metadata.importSource as any).record).toEqual(source);
    expect(note.metadata.sourceFingerprint).not.toBe('malicious');
  });
  test('fingerprints survive key ordering; isolate account, namespace and versions', () => {
    const fingerprint = (value: unknown, options = mem0) => planImport([value as any], options).notes[0].metadata.sourceFingerprint;
    expect(fingerprint(row())).toBe(fingerprint({ ...row(), metadata: { team: 'fixture' } }));
    expect(fingerprint(row())).not.toBe(fingerprint(row(), { ...mem0, account: 'second-account' }));
    expect(fingerprint(row())).not.toBe(fingerprint({ ...row(), user_id: 'second' }, { ...mem0, scope: 'second' }));
    expect(fingerprint(row())).not.toBe(fingerprint({ ...row(), memory: 'Updated note' }));
    expect(planImport([row()], mem0).notes[0].title).not.toBe(planImport([row()], { ...mem0, account: 'second-account' }).notes[0].title);
  });
  test('unready, blank, oversized and duplicate source records reject', () => {
    expect(() => planImport([{ ...row(), memory: '' }], mem0)).toThrow('Source text');
    expect(() => planImport([{ ...row(), memory: 'a'.repeat(100001) }], mem0)).toThrow('100000');
    expect(() => planImport([row(), row()], mem0)).toThrow('Duplicate');
    expect(() => planImport([{ id: 'd', content: 'text', system: { status: 'queued' } }], { ...supermemory, documents: true })).toThrow('not ready');
  });
  test('save acknowledgements require success, positive ID and exact project', async () => {
    const plan = planImport([row()], mem0);
    for (const result of [{ success: false, skipped: true }, { success: true, id: 0, project: mem0.project }, { success: true, id: 1, project: 'other' }]) {
      await expect(applyImport(plan, async () => result)).rejects.toThrow('did not confirm');
    }
  });
  test('confirmed replay is counted separately and failed writes never auto-retry', async () => {
    const plan = planImport([row(), row('m2'), row('m3')], mem0); let calls = 0;
    await expect(applyImport(plan, async () => { calls++; if (calls === 2) throw new Error('synthetic outage'); return { success: true, id: 1, project: mem0.project }; })).rejects.toThrow('1 new');
    expect(calls).toBe(2);
    const result = await applyImport(plan, async () => ({ success: true, duplicate: true, id: 1, project: mem0.project }));
    expect(result).toEqual({ imported: 0, existing: 3 });
  });
  test('network errors, response bodies and authorization redirects do not leak secrets', async () => {
    for (const response of [new Response('synthetic-secret', { status: 401 }), new Response('synthetic-secret')]) {
      try { await requestJson('https://example.invalid', {}, 100, (async () => response) as typeof fetch); throw new Error('must fail'); }
      catch (error) { expect((error as Error).message).not.toContain('synthetic-secret'); }
    }
    await expect(requestJson('https://example.invalid', {}, 100, (async () => { throw new Error('synthetic-secret'); }) as typeof fetch)).rejects.toThrow('Request failed');
  });
});
