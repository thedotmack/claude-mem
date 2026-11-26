import { describe, expect, spyOn, test } from 'bun:test';
import { constants as bufferConstants } from 'node:buffer';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyImport, collectImportRows, observationSyncBodyBound, planImport, requestJson, runImportCommand, saveRequestBody, validateImportOptions, type ImportOptions } from '../../src/npx-cli/commands/import-memory.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../../src/shared/worker-http-limits.js';
import { CONTENT_BODY_MAX_BYTES } from '../../src/shared/cloud-sync-limits.js';
import { MEMORY_SAVE_REFUSAL_REASONS } from '../../src/shared/memory-save-refusal.js';
import { LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY } from '../../src/shared/memory-save-replay.js';

const mem0: ImportOptions = { provider: 'mem0', account: 'fixture-account', scope: 'fixture-user', project: ' migration,project ' };
const supermemory: ImportOptions = { ...mem0, provider: 'supermemory', scope: 'fixture_namespace' };
const row = (id = 'm1') => ({ id, memory: 'Use UTC for scheduled jobs.', user_id: mem0.scope, created_at: '2026-11-01T00:00:00Z', metadata: { team: 'fixture' } });
const smRow = (id = 's1') => ({ id, memory: 'Remember the blue moon.', isLatest: true, isForgotten: false, isInference: false, isStatic: true, version: 1, metadata: {}, system: { createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } });
// The v5 list-documents item shape, published and still generating memories.
const doc = (system: Record<string, unknown> = {}, content = 'Original document text.') => ({ id: 'd1', title: 'Fixture document', type: 'text', content, summary: null, metadata: { original: 'document' }, url: null,
  system: { status: 'done', dreamingStatus: 'dreaming', memoryCount: 0, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...system } });
const pages = (...responses: unknown[]) => (async () => Response.json(responses.shift())) as typeof fetch;
const failure = (promise: Promise<unknown>) => promise.then(() => '', (error: Error) => error.message);
const syncBodyBytes = (note: Parameters<typeof observationSyncBodyBound>[0]) => Buffer.byteLength(JSON.stringify(observationSyncBodyBound(note)));

/** A synthetic source key. It must reach the vendor fakes and nothing else. */
const SYNTHETIC_SOURCE_KEY = 'synthetic-source-key-never-real';
type RecordedRequest = { url: URL; headers: Record<string, string>; body: string; signal?: AbortSignal | null };
/** A port nothing listens on, so a request that escaped the fake fetcher could reach no worker. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
/**
 * runImportCommand with every request answered in this process: vendor pages by `vendor`,
 * worker saves by `save`. Every request is recorded; console output is captured.
 */
async function runCommand(args: string[], vendor: (url: URL) => unknown, save: (body: any, request: RecordedRequest) => unknown = body => ({ success: true, id: 1, project: body.project }), extraEnv: Record<string, string> = {}) {
  const vendorRequests: RecordedRequest[] = []; const workerRequests: RecordedRequest[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request: RecordedRequest = { url: new URL(String(input)), headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body ?? ''), signal: init.signal };
    if (['api.mem0.ai', 'api.supermemory.ai'].includes(request.url.hostname)) { vendorRequests.push(request); return Response.json(vendor(request.url)); }
    workerRequests.push(request);
    if (request.url.pathname !== '/api/memory/save') throw new Error(`Unexpected worker request ${request.url.pathname}`);
    return Response.json(await save(JSON.parse(request.body), request));
  }) as typeof fetch;
  const env = { CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(await closedPort()), MEM0_API_KEY: SYNTHETIC_SOURCE_KEY, SUPERMEMORY_API_KEY: SYNTHETIC_SOURCE_KEY, ...extraEnv };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { lines.push(parts.join(' ')); });
  try {
    const error = await failure(runImportCommand(args, fetcher));
    return { error, lines, vendorRequests, workerRequests };
  } finally {
    log.mockRestore();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const mem0Args = ['--from', 'mem0', '--source-account', 'fixture-account', '--user', 'fixture-user', '--project', 'imported'];
const supermemoryArgs = ['--from', 'supermemory', '--source-account', 'fixture-account', '--namespace', 'fixture_namespace', '--project', 'imported'];
const mem0Page = (...rows: unknown[]) => () => ({ count: rows.length, next: null, results: rows });

describe('provider import contracts', () => {
  test('nullable Mem0 lifecycle imports and preserves original provenance', () => {
    const source = { ...row(), lifecycle_state: null };
    const plan = planImport([source], mem0);
    expect(plan.notes).toHaveLength(1);
    expect(plan.skipped).toBe(0);
    expect((plan.notes[0].metadata.importSource as { record: unknown }).record).toEqual(source);
    expect(source.lifecycle_state).toBeNull();
  });
  test('nullable lifecycle still skips replaced and expired memories', () => {
    const plan = planImport([
      { ...row('replaced-null'), lifecycle_state: null, replaced_by: 'replacement' },
      { ...row('expired-null'), lifecycle_state: null, expiration_date: '2020-01-01' },
    ], mem0);
    expect(plan.notes).toHaveLength(0);
    expect(plan.skipped).toBe(2);
  });
  test('nullable lifecycle exception does not accept other invalid values', () => {
    for (const lifecycle_state of ['', false, 0, {}, []]) {
      expect(() => planImport([{ ...row(), lifecycle_state }], mem0)).toThrow('lifecycle');
    }
  });

  test('Mem0 uses a scoped read POST, sequential pages and no supplied next URL', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [{ count: 2, next: 'https://other.invalid/steal', previous: null, results: [row()] }, { count: 2, next: null, previous: 'ignored', results: [row('m2')] }];
    const rows = await collectImportRows(mem0, 'synthetic', (async (url, init) => { requests.push({ url: String(url), init }); return Response.json(responses.shift()); }) as typeof fetch);
    expect(rows).toHaveLength(2);
    expect(requests[1].url).toBe('https://api.mem0.ai/v3/memories/?page_size=200&page=2');
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
  });
  test('Mem0 expiry includes the whole UTC expiration day, and dates Mem0 cannot read fail open', () => {
    const plan = (now: number) => planImport([{ ...row('last-day'), expiration_date: '2026-11-15' }], mem0, now);
    expect(plan(Date.UTC(2026, 10, 15)).notes).toHaveLength(1); // 15.19.0 dropped it from this moment on
    expect(plan(Date.UTC(2026, 10, 15, 23, 59, 59, 999)).notes).toHaveLength(1);
    expect(plan(Date.UTC(2026, 10, 16)).skipped).toBe(1);
    for (const value of ['bad', '2026-02-30', '2026-11-15T00:00:00Z', 20261115, '', null]) {
      const imported = planImport([{ ...row(), expiration_date: value }], mem0, Date.UTC(2030, 0, 1));
      expect(imported.skipped).toBe(0);
      expect((imported.notes[0].metadata.importSource as any).record.expiration_date).toBe(value);
    }
  });
  test('memories whose expiration date Mem0 cannot read are counted, and the summary says how many', async () => {
    const rows = [{ ...row('bad'), expiration_date: 'bad' }, { ...row('impossible'), expiration_date: '2026-02-30' }, { ...row('datetime'), expiration_date: '2026-11-15T00:00:00Z' },
      { ...row('valid'), expiration_date: '2999-01-01' }, { ...row('none'), expiration_date: null }, row('absent'),
      // Skipped for another reason, so not imported and not counted.
      { ...row('replaced'), expiration_date: 'bad', replaced_by: 'valid' }];
    const plan = planImport(rows, mem0, Date.UTC(2026, 10, 15));
    expect(plan.notes).toHaveLength(6);
    expect(plan.memoriesWithUnreadableExpirationDate).toBe(3);
    expect(planImport([row()], mem0).memoriesWithUnreadableExpirationDate).toBe(0);
    const dryRun = await runCommand([...mem0Args, '--dry-run'], mem0Page(...rows));
    expect(dryRun.error).toBe('');
    expect(dryRun.lines).toContain('3 memories have an expiration date Mem0 cannot read; Mem0 treats them as never expiring, so they are imported that way.');
    const one = await runCommand([...mem0Args, '--dry-run'], mem0Page({ ...row(), expiration_date: 'bad' }));
    expect(one.lines).toContain('1 memory has an expiration date Mem0 cannot read; Mem0 treats it as never expiring, so it is imported that way.');
    expect((await runCommand([...mem0Args, '--dry-run'], mem0Page(row()))).lines.some(line => line.includes('cannot read'))).toBe(false);
  });
  test('raw metadata, provenance and text are preserved; control keys stay nested', () => {
    const source = { ...row(), memory: '  Original text\nSecond line. ', metadata: { project: 'other', platformSource: 'other', sourceFingerprint: 'malicious', when: 'original' } };
    const note = planImport([source], mem0).notes[0];
    expect(note.text).toBe(source.memory); expect(note.project).toBe(mem0.project);
    expect(note.metadata).not.toHaveProperty('platformSource');
    expect((note.metadata.importSource as any).record).toEqual(source);
    expect(note.metadata.sourceFingerprint).not.toBe('malicious');
  });
  test('imported notes land on the host platform, never the vendor name', () => {
    // A vendor platformSource ('mem0') would hide every imported note from the
    // host's memory search, which filters to the asking host's platform.
    for (const [rows, options] of [[[row()], mem0], [[smRow()], supermemory]] as const) {
      expect(planImport([...rows], options).notes[0].metadata).not.toHaveProperty('platformSource');
      expect(planImport([...rows], { ...options, platformSource: 'codex' }).notes[0].metadata.platformSource).toBe('codex');
    }
    expect(() => validateImportOptions({ ...mem0, platformSource: ' ' })).toThrow('--platform');
  });
  test('fingerprints survive key ordering; isolate account, namespace and versions', () => {
    const fingerprint = (value: unknown, options = mem0) => planImport([value as any], options).notes[0].metadata.sourceFingerprint;
    expect(fingerprint(row())).toBe(fingerprint({ ...row(), metadata: { team: 'fixture' } }));
    expect(fingerprint(row())).not.toBe(fingerprint(row(), { ...mem0, account: 'second-account' }));
    expect(fingerprint(row())).not.toBe(fingerprint({ ...row(), user_id: 'second' }, { ...mem0, scope: 'second' }));
    expect(fingerprint(row())).not.toBe(fingerprint({ ...row(), memory: 'Updated note' }));
    expect(planImport([row()], mem0).notes[0].title).not.toBe(planImport([row()], { ...mem0, account: 'second-account' }).notes[0].title);
  });
  test('memory fingerprints are the ones 15.19.0 saved, so an exact repeat after upgrading is already imported', () => {
    expect(planImport([row()], mem0).notes[0].metadata.sourceFingerprint).toBe('import:mem0:4a7120034edf9cf13d494bd1b56abfa45db30c8656ad033e73e5b26cfe0acff8');
    expect(planImport([smRow()], supermemory).notes[0].metadata.sourceFingerprint).toBe('import:supermemory:8ccb36f33a734fa5f65194d73ac7665dd7a9770bf9167a1bb11d1493053bab05');
    // Their fingerprint already is the 15.19.0 one, so they send no alternative.
    for (const note of [planImport([row()], mem0).notes[0], planImport([smRow()], supermemory).notes[0]]) {
      expect(note.metadata).not.toHaveProperty(LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY);
    }
  });
  test('a Supermemory document keeps its fingerprint while Supermemory updates its own fields; new text is a new revision', () => {
    const documents = { ...supermemory, documents: true };
    const first = planImport([doc()], documents).notes[0];
    const later = planImport([doc({ dreamingStatus: 'done', memoryCount: 7, updatedAt: '2026-11-01T00:05:00Z' })], documents).notes[0];
    expect(later.metadata.sourceFingerprint).toBe(first.metadata.sourceFingerprint);
    expect(later.title).toBe(first.title);
    expect((later.metadata.importSource as any).record).toEqual(doc({ dreamingStatus: 'done', memoryCount: 7, updatedAt: '2026-11-01T00:05:00Z' }));
    expect(planImport([doc({}, 'Corrected document text.')], documents).notes[0].metadata.sourceFingerprint).not.toBe(first.metadata.sourceFingerprint);
    expect(planImport([doc()], { ...documents, account: 'second-account' }).notes[0].metadata.sourceFingerprint).not.toBe(first.metadata.sourceFingerprint);
    expect(planImport([doc()], { ...documents, scope: 'second_namespace' }).notes[0].metadata.sourceFingerprint).not.toBe(first.metadata.sourceFingerprint);
  });
  test('a document also sends, for the worker lookup only, the exact fingerprint 15.19.0 saved for it', () => {
    const documents = { ...supermemory, documents: true };
    const note = planImport([doc()], documents).notes[0];
    // What 15.19.0's planImport saved as sourceFingerprint for this same row (run from f705e9b99).
    expect(note.metadata[LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY]).toBe('import:supermemory:ffed2fba72831eed324781063dd3ca2e037ce180ad28531242d6794db432eb4e');
    expect(note.metadata.sourceFingerprint).not.toBe(note.metadata[LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY]);
    // 15.19.0 also fingerprinted the fields Supermemory changes by itself, so the old value moves with them.
    expect(planImport([doc({ memoryCount: 7 })], documents).notes[0].metadata[LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY]).not.toBe(note.metadata[LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY]);
  });
  test('a record must fit one worker save request, cwd included', () => {
    const oneCharacter = Buffer.byteLength(saveRequestBody(planImport([{ ...row(), memory: 'a' }], mem0).notes[0], undefined));
    // Each ASCII character adds two bytes: the text is kept as the memory and inside its source record.
    const size = (length: number) => oneCharacter + 2 * (length - 1);
    const fits = 'a'.repeat(1 + Math.floor((WORKER_JSON_BODY_LIMIT_BYTES - oneCharacter) / 2));
    expect(size(fits.length)).toBeGreaterThan(WORKER_JSON_BODY_LIMIT_BYTES - 2);
    expect(size(fits.length)).toBeLessThanOrEqual(WORKER_JSON_BODY_LIMIT_BYTES);
    // Within the worker's limit, so the next limit, cloud sync's, is the one that refuses it.
    expect(() => planImport([{ ...row(), memory: fits }], mem0)).toThrow('too large to sync');
    expect(() => planImport([{ ...row(), memory: fits + 'a' }], mem0)).toThrow(`Source record m1 needs a ${size(fits.length + 1)}-byte save request; the worker accepts at most ${WORKER_JSON_BODY_LIMIT_BYTES} bytes`);
    expect(() => planImport([{ ...row(), memory: fits }], { ...mem0, cwd: '/a-folder' })).toThrow('Source record m1 needs a');
  });
  test('a record cloud sync would refuse stops the import before any write, at the exact byte', () => {
    // Each pad character adds one byte to the synced record: it is ASCII and kept once, in the source record.
    const padded = (length: number) => ({ ...row('padded'), pad: 'x'.repeat(length) });
    const bytesWith = (length: number) => syncBodyBytes(planImport([padded(length)], mem0).notes[0]);
    const atLimit = CONTENT_BODY_MAX_BYTES - bytesWith(0);
    expect(bytesWith(atLimit)).toBe(CONTENT_BODY_MAX_BYTES);
    // Cloud sync refuses a body over CONTENT_BODY_MAX_BYTES, so one of exactly that size still syncs.
    expect(planImport([padded(atLimit - 1)], mem0).notes).toHaveLength(1);
    expect(planImport([padded(atLimit)], mem0).notes).toHaveLength(1);
    const refused = () => planImport([row('first'), padded(atLimit + 1)], mem0);
    expect(refused).toThrow(`Source record padded is too large to sync: as a synced record it can take up to ${CONTENT_BODY_MAX_BYTES + 1} bytes, and cloud sync refuses any record over ${CONTENT_BODY_MAX_BYTES} bytes`);
    expect(refused).toThrow('no memories were written');
    // 15.19.0 took 100,000 characters of any text; three-byte characters, counted twice, cannot sync at that length.
    expect(() => planImport([{ ...row(), memory: '日'.repeat(50_000) }], mem0)).toThrow('too large to sync');
  });
  test('every page asks for the vendor maximum, and a page over the largest parseable response stops the import', async () => {
    const urls: URL[] = [];
    const capture = (...responses: unknown[]) => (async (url: string | URL | Request) => { urls.push(new URL(String(url))); return Response.json(responses.shift()); }) as typeof fetch;
    const totals: number[] = [];
    await collectImportRows(mem0, 'x', capture({ count: 2, next: 'more', results: [row()] }, { count: 2, next: null, results: [row('m2')] }), total => totals.push(total));
    await collectImportRows(supermemory, 'x', capture({ memories: [smRow()], pagination: { totalItems: 2, hasMore: true, nextCursor: 'c' } }, { memories: [smRow('s2')], pagination: { totalItems: 0, hasMore: false, nextCursor: null } }));
    expect(urls.map(url => url.searchParams.get(url.hostname === 'api.mem0.ai' ? 'page_size' : 'limit'))).toEqual(['200', '200', '100', '100']);
    expect(totals).toEqual([2]);
    // A page streamed past the largest string the runtime can hold: refused while reading, before
    // any later page or write. The same cap for both vendors; no per-vendor page formula remains.
    const chunk = new Uint8Array(8 * 1024 * 1024);
    for (const options of [mem0, supermemory, { ...supermemory, documents: true }]) {
      let reads = 0; let cancelled = false; let pageRequests = 0;
      const endless = { ok: true, status: 200, body: { getReader: () => ({
        read: async () => { reads++; return { done: false, value: chunk }; },
        cancel: async () => { cancelled = true; }, releaseLock: () => {},
      }) } } as unknown as Response;
      const oversized = collectImportRows(options, 'x', (async () => { pageRequests++; return endless; }) as typeof fetch);
      await expect(oversized).rejects.toThrow(`Response exceeds ${bufferConstants.MAX_STRING_LENGTH} bytes`);
      expect(cancelled).toBe(true);
      expect(reads).toBe(Math.floor(bufferConstants.MAX_STRING_LENGTH / chunk.byteLength) + 1);
      expect(pageRequests).toBe(1);
    }
  });
  test('timeout and count limits come from Node and the source total', async () => {
    await expect(requestJson('https://example.invalid', {}, 100, (async () => Response.json([1, 2, 3, 4, 5])) as typeof fetch, 8)).rejects.toThrow('Response exceeds 8 bytes');
    expect(() => validateImportOptions({ ...mem0, timeoutMs: 2_147_483_648 })).toThrow('--timeout-ms');
    expect(() => validateImportOptions({ ...mem0, timeoutMs: 2_147_483_647, maxRecords: 250_000 })).not.toThrow();
    expect(() => validateImportOptions({ ...mem0, maxRecords: 0 })).toThrow('--max-records');
    await expect(collectImportRows(supermemory, 'x', pages({ memories: [smRow(), smRow('s2')], pagination: { totalItems: 1, hasMore: false, nextCursor: null } }))).rejects.toThrow('more records than its total');
  });
  test('--timeout-ms also sets the deadline of each save to the worker', async () => {
    let saveSignal: AbortSignal | null | undefined;
    const started = performance.now();
    // The worker never answers; only the save's own deadline can end the request.
    const run = await runCommand([...mem0Args, '--timeout-ms', '50'], mem0Page(row()), (_body, request) => new Promise((_, reject) => {
      saveSignal = request.signal;
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
    }));
    expect(run.error).toStartWith('Import stopped after 0 new and 0 existing memories. Request failed or timed out.');
    expect((saveSignal!.reason as Error).name).toBe('TimeoutError');
    // The worker API deadline it would otherwise wait for is 30 seconds.
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(run.vendorRequests).toHaveLength(1);
    expect(run.workerRequests).toHaveLength(1);
  });
  test('dry-run previews the source without reading the worker API deadline', async () => {
    const preview = await runCommand([...mem0Args, '--dry-run'], mem0Page(row()), undefined, { CLAUDE_MEM_API_TIMEOUT_MS: 'soon' });
    expect(preview.error).toBe('');
    expect(preview.lines).toContain('1 read; 0 skipped; 1 ready to import.');
    expect(preview.lines).toContain('Dry run complete. No memories were written.');
    expect(preview.vendorRequests).toHaveLength(1);
    expect(preview.workerRequests).toHaveLength(0);
  });
  test('dry-run still rejects an explicitly invalid source deadline before any request', async () => {
    const invalid = await runCommand([...mem0Args, '--dry-run', '--timeout-ms', 'soon'], mem0Page(row()));
    expect(invalid.error).toContain('--timeout-ms must be between');
    expect(invalid.vendorRequests).toHaveLength(0);
    expect(invalid.workerRequests).toHaveLength(0);
  });
  test('an invalid worker API deadline stops the import before any request, instead of a logged warning', async () => {
    const invalid = await runCommand(mem0Args, mem0Page(row()), undefined, { CLAUDE_MEM_API_TIMEOUT_MS: 'soon' });
    expect(invalid.error).toBe('CLAUDE_MEM_API_TIMEOUT_MS in the environment must be a whole number of milliseconds from 500 to 300000.');
    expect(invalid.vendorRequests).toHaveLength(0);
    // With --timeout-ms the setting is not needed, so it is not read.
    const overridden = await runCommand([...mem0Args, '--timeout-ms', '5000'], mem0Page(row()), undefined, { CLAUDE_MEM_API_TIMEOUT_MS: 'soon' });
    expect(overridden.error).toBe('');
    expect(overridden.lines).toContain('Import complete: 1 new, 0 already imported, 0 skipped.');
  });
  test('the source API key reaches the vendor and never the worker', async () => {
    const runs = [
      await runCommand(mem0Args, mem0Page(row(), row('m2'))),
      await runCommand(supermemoryArgs, () => ({ memories: [smRow()], pagination: { totalItems: 1, hasMore: false, nextCursor: null } })),
      await runCommand([...supermemoryArgs, '--documents'], () => ({ documents: [doc()], pagination: { totalItems: 1, hasMore: false, nextCursor: null } })),
    ];
    for (const run of runs) {
      expect(run.error).toBe('');
      expect(run.vendorRequests.length).toBeGreaterThan(0);
      for (const request of run.vendorRequests) expect(request.headers.authorization).toEndWith(` ${SYNTHETIC_SOURCE_KEY}`);
      expect(run.workerRequests.length).toBeGreaterThan(0);
      for (const request of run.workerRequests) {
        expect(request.url.pathname).toBe('/api/memory/save');
        expect(JSON.stringify(request.headers)).not.toContain(SYNTHETIC_SOURCE_KEY);
        expect(request.body).not.toContain(SYNTHETIC_SOURCE_KEY);
      }
    }
  });
  test('the import writes nothing in the data folder: no settings.json, settings migration marker or log', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-import-data-'));
    const home = mkdtempSync(join(tmpdir(), 'claude-mem-import-home-'));
    try {
      // A fresh process, so every path the import could write resolves inside the empty folder.
      const run = Bun.spawnSync([process.execPath, join(import.meta.dir, '../fixtures/import-memory-empty-data-folder.ts'), ...mem0Args], {
        cwd: join(import.meta.dir, '../..'),
        env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MEM_DATA_DIR: dataDir, MEM0_API_KEY: SYNTHETIC_SOURCE_KEY,
          CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: '9', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: 'false', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(run.stdout.toString()).toContain('Import complete: 1 new, 0 already imported, 0 skipped.');
      expect(run.exitCode).toBe(0);
      expect(readdirSync(dataDir, { recursive: true })).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  });
  test('unready, blank and duplicate source records reject', () => {
    expect(() => planImport([{ ...row(), memory: '' }], mem0)).toThrow('Source text');
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
  test('keeps an absolute --project path for worker exclusion checks while matching the normalized confirmation', async () => {
    const plan = planImport([row('m1'), row('m2')], { ...mem0, project: '/tmp/my-app' });
    expect(plan.notes.map(note => note.project)).toEqual(['/tmp/my-app', '/tmp/my-app']);
    let nextId = 1;
    const first = await applyImport(plan, async () => ({ success: true, id: nextId++, project: 'my-app' }));
    expect(first).toEqual({ imported: 2, existing: 0 });
    const replay = await applyImport(plan, async () => ({ success: true, duplicate: true, id: 1, project: 'my-app' }));
    expect(replay).toEqual({ imported: 0, existing: 2 });
  });
  test('a worker refusal is reported plainly, without promising that a rerun resumes', async () => {
    const plan = planImport([row(), row('m2')], mem0);
    const words: string[] = [];
    for (const reason of MEMORY_SAVE_REFUSAL_REASONS) {
      let calls = 0;
      const refused = await failure(applyImport(plan, async () => { calls++; return { success: false, skipped: true, reason }; }));
      expect(calls).toBe(1);
      expect(refused).toStartWith('Import stopped after 0 new and 0 existing memories. The worker refused');
      expect(refused).not.toContain(reason);
      expect(refused).not.toContain('Run the same command again');
      words.push(refused);
    }
    expect(words.join('\n')).toContain('CLAUDE_MEM_EXCLUDED_PROJECTS');
    // project_excluded has two causes; the words cover both, each with a way out that is not refused again.
    expect(words.join('\n')).toContain('If this folder matches, run the command from a folder that is not excluded');
    expect(words.join('\n')).toContain('If the --project path matches, name a project that is not excluded');
    for (const retryable of [async () => { throw new Error('synthetic outage'); }, async () => ({ success: false, skipped: true }), async () => ({ success: false, skipped: true, reason: 'a_reason_this_version_does_not_know' })]) {
      expect(await failure(applyImport(plan, retryable))).toContain('Run the same command again to resume');
    }
  });
  test('an HTTP 413 from the worker is named as a refusal a rerun meets again; other failures still say a rerun resumes', async () => {
    const plan = planImport([row()], mem0);
    const answer = (status: number) => (note: unknown) => requestJson('http://127.0.0.1:9/api/memory/save', { body: JSON.stringify(note) }, 100, (async () => new Response('', { status })) as typeof fetch);
    const tooLarge = await failure(applyImport(plan, answer(413)));
    expect(tooLarge).toStartWith('Import stopped after 0 new and 0 existing memories. The worker refused a save as too large (HTTP 413)');
    expect(tooLarge).toContain('Running the same command again will be refused the same way');
    expect(tooLarge).not.toContain('to resume');
    for (const status of [500, 503]) expect(await failure(applyImport(plan, answer(status)))).toBe(`Import stopped after 0 new and 0 existing memories. HTTP ${status} Run the same command again to resume; confirmed records will not duplicate.`);
  });
  test('network errors, response bodies and authorization redirects do not leak secrets', async () => {
    for (const response of [new Response('synthetic-secret', { status: 401 }), new Response('synthetic-secret')]) {
      try { await requestJson('https://example.invalid', {}, 100, (async () => response) as typeof fetch); throw new Error('must fail'); }
      catch (error) { expect((error as Error).message).not.toContain('synthetic-secret'); }
    }
    await expect(requestJson('https://example.invalid', {}, 100, (async () => { throw new Error('synthetic-secret'); }) as typeof fetch)).rejects.toThrow('Request failed');
  });
});
