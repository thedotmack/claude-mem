import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, TRUNC_MARK, type CloudSyncSettingKeys, type CloudSyncOptions } from '../../../src/services/sync/CloudSync.js';

const ISO = '2026-07-09T00:00:00.000Z';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  hasSignal: boolean;
  body: string;
  parsed: any;
}

/**
 * Mock fetch: records every request; `handler(callNumber)` may return a
 * Response to send or an Error to throw (network failure). Defaults to 200.
 */
function makeFetchMock(handler?: (call: number) => Response | Error | undefined) {
  const calls: RecordedRequest[] = [];
  const impl = (async (input: any, init?: any) => {
    const body = String(init?.body ?? '');
    calls.push({
      url: String(input),
      headers: { ...(init?.headers ?? {}) },
      hasSignal: init?.signal != null,
      body,
      parsed: body ? JSON.parse(body) : null,
    });
    const result = handler?.(calls.length);
    if (result instanceof Error) throw result;
    return result ?? new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('CloudSync', () => {
  let tempDir: string;
  let db: Database;
  let settingsPath: string;
  let missingLegacyPath: string;

  function makeSettings(overrides: Partial<CloudSyncSettingKeys> = {}): CloudSyncSettingKeys {
    return {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token-1234',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-42',
      CLAUDE_MEM_CLOUD_SYNC_URL: 'https://cmem.test/api/pro/sync',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-fixture',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test-host',
      ...overrides,
    };
  }

  function makeCloudSync(
    fetchImpl: typeof fetch,
    settingsOverrides: Partial<CloudSyncSettingKeys> = {},
    options: Partial<CloudSyncOptions> = {}
  ): CloudSync {
    return new CloudSync(db, makeSettings(settingsOverrides), {
      fetchImpl,
      settingsPath,
      legacyStatePath: missingLegacyPath,
      debounceMs: 25,
      backoffInitialMs: 20,
      backoffMaxMs: 200,
      ...options,
    });
  }

  function seedObservation(overrides: Record<string, unknown> = {}): void {
    const row = {
      memory_session_id: 'mem-1',
      project: 'proj-x',
      type: 'discovery',
      title: 'Title A',
      subtitle: 'Sub A',
      facts: '["fact one","fact two"]',
      narrative: 'The narrative',
      concepts: '["concept-a"]',
      files_read: '["/a.ts"]',
      files_modified: '[]',
      prompt_number: 3,
      discovery_tokens: 42,
      created_at: ISO,
      created_at_epoch: 1751234567890,
      ...overrides,
    };
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, subtitle, facts, narrative,
        concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.memory_session_id as string, row.project as string, row.type as string,
      row.title as string | null, row.subtitle as string | null, row.facts as string | null,
      row.narrative as string | null, row.concepts as string | null, row.files_read as string | null,
      row.files_modified as string | null, row.prompt_number as number, row.discovery_tokens as number,
      row.created_at as string, row.created_at_epoch as number
    );
  }

  function seedSummary(): void {
    db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned,
        completed, next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES ('mem-1', 'proj-x', 'Req', 'Inv', 'Lrn', 'Done', 'Next', NULL, 2, 0, ?, 1751234567891)
    `).run(ISO);
  }

  function seedPrompt(promptText: string, promptNumber = 5, sessionDbId: number | null = null): void {
    db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, 'sess-abc', ?, ?, ?, 1751234567892)
    `).run(sessionDbId, promptNumber, promptText, ISO);
  }

  function pendingCount(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE synced_at IS NULL`).get() as { n: number }).n;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-cloud-sync-'));
    settingsPath = join(tempDir, 'settings.json');
    missingLegacyPath = join(tempDir, 'no-such-cloud-sync-state.json');
    db = new Database(':memory:');
    new SessionStore(db, { cloudSyncStatePath: missingLegacyPath });
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-abc', 'mem-1', 'proj-x', ?, 1751234567000, 'active')
    `).run(ISO);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Golden wire-contract: mapper output must deep-equal the standalone client's
  // toCloud output for the same rows. Expected literals hand-ported from
  // ~/.claude-mem/cloud-sync.mjs — observations toCloud at :141-156, summaries
  // at :188-201, prompts at :238-250, endpoints/bodyKeys at :136-137/:183-184/
  // :224-225, headers at :288-296. Guards the fixed cmem.ai wire format.
  // ---------------------------------------------------------------------------
  it('sends the exact wire format of the standalone client (golden contract)', async () => {
    seedObservation();
    seedSummary();
    seedPrompt('hello world');

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl);
    await sync.flush();

    expect(calls.length).toBe(3);
    expect(calls.map(c => c.url)).toEqual([
      'https://cmem.test/api/pro/sync/observations/batch',
      'https://cmem.test/api/pro/sync/summaries/batch',
      'https://cmem.test/api/pro/sync/prompts/batch',
    ]);
    for (const call of calls) {
      expect(call.headers['Content-Type']).toBe('application/json');
      expect(call.headers['Authorization']).toBe('Bearer test-token-1234');
      expect(call.headers['X-User-Id']).toBe('user-42');
      expect(call.headers['X-Device-Id']).toBe('device-fixture');
      expect(call.headers['X-Device-Name']).toBe('test-host');
      expect(call.hasSignal).toBe(true); // AbortSignal.timeout — fixes the standalone client's no-timeout hang
    }

    // cloud-sync.mjs:141-156 (facts/concepts/files are PARSED — mjs:120-125)
    expect(calls[0].parsed).toEqual({
      observations: [{
        localId: '1',
        memorySessionId: 'mem-1',
        project: 'proj-x',
        type: 'discovery',
        title: 'Title A',
        subtitle: 'Sub A',
        facts: ['fact one', 'fact two'],
        narrative: 'The narrative',
        concepts: ['concept-a'],
        filesRead: ['/a.ts'],
        filesModified: [],
        promptNumber: 3,
        discoveryTokens: 42,
        createdAtEpoch: 1751234567890,
      }],
    });

    // cloud-sync.mjs:188-201
    expect(calls[1].parsed).toEqual({
      summaries: [{
        localId: '1',
        memorySessionId: 'mem-1',
        project: 'proj-x',
        request: 'Req',
        investigated: 'Inv',
        learned: 'Lrn',
        completed: 'Done',
        nextSteps: 'Next',
        notes: null,
        promptNumber: 2,
        discoveryTokens: 0,
        createdAtEpoch: 1751234567891,
      }],
    });

    // cloud-sync.mjs:238-250 (memorySessionId reuses the content session id,
    // project is the fixed 'unknown' bucket — mjs:241-244)
    expect(calls[2].parsed).toEqual({
      prompts: [{
        localId: '1',
        contentSessionId: 'sess-abc',
        memorySessionId: 'sess-abc',
        project: 'unknown',
        promptText: 'hello world',
        promptNumber: 5,
        createdAtEpoch: 1751234567892,
      }],
    });
  });

  it('maps SQL NULLs to JSON nulls like the standalone client', async () => {
    seedObservation({
      title: null, subtitle: null, facts: null, narrative: null,
      concepts: null, files_read: null, files_modified: null,
    });

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    // cloud-sync.mjs:141-156 — `?? null` fallbacks and parseJson(null) → null
    expect(calls[0].parsed.observations[0]).toEqual({
      localId: '1',
      memorySessionId: 'mem-1',
      project: 'proj-x',
      type: 'discovery',
      title: null,
      subtitle: null,
      facts: null,
      narrative: null,
      concepts: null,
      filesRead: null,
      filesModified: null,
      promptNumber: 3,
      discoveryTokens: 42,
      createdAtEpoch: 1751234567890,
    });
  });

  it('coalesces a burst of notify() calls into exactly one flush', async () => {
    seedObservation();

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl);

    for (let i = 0; i < 6; i++) sync.notify();
    await sleep(200);

    expect(calls.length).toBe(1);
    expect(pendingCount('observations')).toBe(0);
  });

  it('loops 200-row pages until fully drained and stamps every batch', async () => {
    for (let i = 0; i < 450; i++) seedObservation({ title: `obs ${i}` });

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl);
    await sync.flush();

    expect(calls.length).toBe(3);
    expect(calls.map(c => c.parsed.observations.length)).toEqual([200, 200, 50]);
    expect(pendingCount('observations')).toBe(0);

    const status = sync.status();
    expect(status.pending).toEqual({ observations: 0, summaries: 0, prompts: 0 });
    expect(status.lastFlushAt).not.toBeNull();
    expect(status.lastError).toBeNull();
  });

  it('packs oversized pages into multiple bodies, each under 2MB', async () => {
    // 12 rows × ~190KB narrative: each mapped row stays under the 200KB field
    // clamp, but one 2MB body only fits 10 of them → two POSTs.
    for (let i = 0; i < 12; i++) seedObservation({ narrative: 'n'.repeat(190_000) });

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    expect(calls.length).toBe(2);
    const batchSizes = calls.map(c => c.parsed.observations.length);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(12);
    expect(batchSizes[0]).toBeLessThan(12);
    for (const call of calls) {
      expect(call.body.length).toBeLessThanOrEqual(2_000_000);
    }
    expect(pendingCount('observations')).toBe(0);
  });

  it('clamps giant prompts in SQL and appends the truncation marker', async () => {
    seedPrompt('x'.repeat(300_000));

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    expect(calls.length).toBe(1);
    const sent = calls[0].parsed.prompts[0];
    // Identical to the standalone client: substr(prompt_text,1,200000) in SQL
    // (cloud-sync.mjs:234-237), marker appended because prompt_text_len >
    // 200000 (mjs:245-247), then clampRow re-clamps the marked string back to
    // 200000 chars + marker (mjs:273-281). Net: original 200KB prefix + marker.
    expect(sent.promptText).toBe('x'.repeat(200_000) + TRUNC_MARK);
    expect(sent.promptText.length).toBe(200_000 + TRUNC_MARK.length);
    // The SQL-side helper column must not leak onto the wire.
    expect(Object.keys(sent).sort()).toEqual([
      'contentSessionId', 'createdAtEpoch', 'localId', 'memorySessionId',
      'project', 'promptNumber', 'promptText',
    ]);
    expect(pendingCount('user_prompts')).toBe(0);
  });

  describe('prompt session mapping (joined drain)', () => {
    it('pushes the real memory_session_id and project when the sdk_sessions mapping exists', async () => {
      seedPrompt('mapped prompt', 7, 1); // session_db_id 1 = sess-abc → mem-1/proj-x (beforeEach)

      const { impl, calls } = makeFetchMock();
      await makeCloudSync(impl).flush();

      expect(calls.length).toBe(1);
      expect(calls[0].parsed.prompts[0]).toEqual({
        localId: '1',
        contentSessionId: 'sess-abc',
        memorySessionId: 'mem-1',
        project: 'proj-x',
        promptText: 'mapped prompt',
        promptNumber: 7,
        createdAtEpoch: 1751234567892,
      });
      // rowAlias qualifies synced_at/id in the joined SELECT while stampSynced
      // targets bare user_prompts — the drained row must still come back stamped.
      expect(pendingCount('user_prompts')).toBe(0);
    });

    it('falls back per row within one batch when the mapping is missing or unregistered', async () => {
      // A session that exists but never registered a memory id.
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('sess-no-mem', NULL, 'proj-y', ?, 1751234568000, 'active')
      `).run(ISO);

      seedPrompt('mapped', 1, 1);           // joins mem-1/proj-x
      seedPrompt('never-registered', 2, 2); // joins a NULL memory_session_id session
      seedPrompt('orphan', 3, null);        // no session_db_id at all

      const { impl, calls } = makeFetchMock();
      await makeCloudSync(impl).flush();

      expect(calls.length).toBe(1);
      const sent = calls[0].parsed.prompts.map((p: any) => [p.memorySessionId, p.project]);
      expect(sent).toEqual([
        ['mem-1', 'proj-x'],   // resolved through the join
        ['sess-abc', 'proj-y'], // memory id falls back to the content session; project still real
        ['sess-abc', 'unknown'], // LEFT JOIN miss → full legacy fallback
      ]);
      expect(pendingCount('user_prompts')).toBe(0);
    });

    it('re-pushes instead of stamping a prompt whose memory id registered while its POST was in flight', async () => {
      // A session that has not yet registered a memory id at SELECT time.
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('sess-late', NULL, 'proj-late', ?, 1751234568000, 'active')
      `).run(ISO);
      seedPrompt('racy prompt', 1, 2);

      // Hold the first POST in flight so the registration can land mid-push.
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const bodies: any[] = [];
      const impl = (async (_input: any, init?: any) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) await gate;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      const sync = makeCloudSync(impl);
      const flushPromise = sync.flush();
      for (let i = 0; i < 100 && bodies.length === 0; i++) await sleep(2);
      expect(bodies.length).toBe(1);
      expect(bodies[0].prompts[0].memorySessionId).toBe('sess-abc'); // fallback shape in flight

      // The memory id lands now — exactly what ensureMemorySessionIdRegistered
      // does: sdk_sessions gains the id, and its requeue is a NO-OP because
      // synced_at is still NULL on the in-flight row.
      db.prepare(`UPDATE sdk_sessions SET memory_session_id = 'mem-late' WHERE id = 2`).run();
      db.prepare(`UPDATE user_prompts SET synced_at = NULL WHERE session_db_id = 2 AND synced_at IS NOT NULL`).run();

      release();
      await flushPromise;

      // The stamp guard must reject the stale upload and the SAME flush loop
      // re-pushes it with the registered mapping before stamping.
      expect(bodies.length).toBe(2);
      expect(bodies[1].prompts[0].memorySessionId).toBe('mem-late');
      expect(bodies[1].prompts[0].project).toBe('proj-late');
      expect(pendingCount('user_prompts')).toBe(0);
    });
  });

  describe('sync lane selection', () => {
    it('sends X-Sync-Lane: backfill on every page when a kind has more than 200 pending', async () => {
      seedObservation(); // 1 pending observation stays on the live lane
      for (let i = 0; i < 201; i++) seedPrompt(`p${i}`, i + 1);

      const { impl, calls } = makeFetchMock();
      await makeCloudSync(impl).flush();

      const obsCalls = calls.filter(c => c.url.endsWith('/observations/batch'));
      const promptCalls = calls.filter(c => c.url.endsWith('/prompts/batch'));
      expect(obsCalls.length).toBe(1);
      expect(promptCalls.length).toBe(2); // 200 + 1

      // Lane is picked per kind-drain: the small observation increment must
      // broadcast live while the prompt backlog rides the suppressed lane —
      // including its final sub-200 page.
      expect(obsCalls[0].headers['X-Sync-Lane']).toBeUndefined();
      for (const call of promptCalls) {
        expect(call.headers['X-Sync-Lane']).toBe('backfill');
      }
      expect(pendingCount('user_prompts')).toBe(0);
    });

    it('keeps exactly 200 pending rows on the live lane (threshold is strictly greater-than)', async () => {
      for (let i = 0; i < 200; i++) seedPrompt(`p${i}`, i + 1);

      const { impl, calls } = makeFetchMock();
      await makeCloudSync(impl).flush();

      expect(calls.length).toBe(1);
      expect(calls[0].parsed.prompts.length).toBe(200);
      expect(calls[0].headers['X-Sync-Lane']).toBeUndefined();
      expect(pendingCount('user_prompts')).toBe(0);
    });
  });

  it('leaves rows unsynced and records lastError on HTTP failure, then retries via backoff', async () => {
    seedObservation();

    const { impl, calls } = makeFetchMock(call =>
      call === 1 ? new Response('server sad', { status: 500 }) : undefined
    );
    const sync = makeCloudSync(impl);

    await sync.flush();
    expect(pendingCount('observations')).toBe(1);
    expect(sync.status().lastError).toContain('cloud sync 500');
    expect(sync.status().lastFlushAt).toBeNull();

    // backoffInitialMs is 20ms — the retry timer must re-flush and drain.
    await sleep(200);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(pendingCount('observations')).toBe(0);
    expect(sync.status().lastError).toBeNull();
    expect(sync.status().lastFlushAt).not.toBeNull();

    sync.stop();
  });

  it('handles network errors (fetch rejection) without stamping rows', async () => {
    seedObservation();

    let failing = true;
    const { impl, calls } = makeFetchMock(() =>
      failing ? new Error('connect ECONNREFUSED') : undefined
    );
    const sync = makeCloudSync(impl, {}, { backoffInitialMs: 600_000 });

    await sync.flush();
    expect(calls.length).toBe(1);
    expect(pendingCount('observations')).toBe(1);
    expect(sync.status().lastError).toContain('ECONNREFUSED');

    // A later notify() also retries (independent of the backoff timer).
    failing = false;
    sync.notify();
    await sleep(200);
    expect(pendingCount('observations')).toBe(0);

    sync.stop();
  });

  it('stop() mid-flight halts stamping, further DB access, and retry re-arming', async () => {
    // 250 rows = two SELECT pages, so a completed flush would need 2 POSTs.
    for (let i = 0; i < 250; i++) seedObservation({ title: `obs ${i}` });

    // Gate the first fetch so stop() can land while the POST is in flight.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const impl = (async (input: any) => {
      calls.push(String(input));
      await gate;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const sync = makeCloudSync(impl, {}, { backoffInitialMs: 20 });

    const flushPromise = sync.flush();
    // Wait until the first POST is actually in flight.
    for (let i = 0; i < 100 && calls.length === 0; i++) await sleep(2);
    expect(calls.length).toBe(1);

    sync.stop();     // worker shutdown: DatabaseManager.close() calls this, then db.close()
    release();       // the in-flight fetch now resolves AFTER stop
    await flushPromise; // must resolve without throwing

    // No stamp after stop (the DB could already be closed) and no second page.
    expect(calls.length).toBe(1);
    expect(pendingCount('observations')).toBe(250);

    // Nothing re-arms after stop: notify() is inert and no retry timer fires.
    sync.notify();
    await sleep(200); // > debounceMs (25) and > backoffInitialMs (20)
    expect(calls.length).toBe(1);
    expect(pendingCount('observations')).toBe(250);
  });

  it('start() no-ops and status reports configured:false when the token is blank', async () => {
    seedObservation();

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_TOKEN: '' });

    sync.start();
    sync.notify();
    await sleep(120);

    expect(calls.length).toBe(0);
    const status = sync.status();
    expect(status.configured).toBe(false);
    expect(status.deviceId).toBe('');
    expect(status.pending.observations).toBe(1);
    expect(pendingCount('observations')).toBe(1);
  });

  describe('device id resolution', () => {
    it('adopts the legacy cloud-sync-state.json deviceId and never mints a new one', () => {
      const legacyPath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(legacyPath, JSON.stringify({
        deviceId: 'legacy-dev-123',
        lastId: 10,
        lastSummaryId: 2,
        lastPromptId: 3,
      }));

      const { impl } = makeFetchMock();
      const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '' }, { legacyStatePath: legacyPath });
      expect(sync.status().deviceId).toBe('legacy-dev-123');

      // Persisted back to settings so future starts skip legacy resolution.
      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID).toBe('legacy-dev-123');

      // A second instance resolving from scratch adopts the SAME id.
      const again = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '' }, { legacyStatePath: legacyPath });
      expect(again.status().deviceId).toBe('legacy-dev-123');
    });

    it('prefers the settings-configured device id over the legacy file', () => {
      const legacyPath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(legacyPath, JSON.stringify({ deviceId: 'legacy-dev-123' }));

      const { impl } = makeFetchMock();
      const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'settings-dev-9' }, { legacyStatePath: legacyPath });
      expect(sync.status().deviceId).toBe('settings-dev-9');
      // No resolution ran, so nothing was persisted.
      expect(existsSync(settingsPath)).toBe(false);
    });

    it('mints a UUID and persists it when neither settings nor legacy state exist', () => {
      const { impl } = makeFetchMock();
      const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '' });

      const deviceId = sync.status().deviceId;
      expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID).toBe(deviceId);
    });

    it('fails closed (no uploads, no minting) when the legacy state file is corrupt', async () => {
      seedObservation();
      const legacyPath = join(tempDir, 'cloud-sync-state.json');
      writeFileSync(legacyPath, 'not json{');

      const { impl, calls } = makeFetchMock();
      const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '' }, { legacyStatePath: legacyPath });

      sync.start();
      sync.notify();
      await sleep(120);

      expect(calls.length).toBe(0);
      expect(sync.status().deviceId).toBe('');
      expect(sync.status().lastError).toContain('legacy cloud-sync state unreadable');
      expect(pendingCount('observations')).toBe(1);
      // Nothing persisted — a new id here would fork every cloud row.
      expect(existsSync(settingsPath)).toBe(false);
    });
  });
});
