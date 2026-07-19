// Phase 3 verification (plan 2026-07-17): the push drain retargeted at the
// sync hub. One endpoint (POST /v1/sync/ops), op bodies per the SyncApply
// BODY FIELD MAPPING, rev-matched stamping on ack (which replaced the old
// stampGuard machinery — see the mid-flight-bump test), and the sync_outbox
// mutation lane drained ahead of row kinds. Harness style unchanged:
// in-temp-dir SessionStore over an in-memory DB, injected fetchImpl, fast
// debounce/backoff.

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
 * Mock hub: records every request and, by default, acks every pushed op with
 * sequential seqs — the real hub acks all-or-refuses. `handler(callNumber)`
 * may return a Response to send instead, or an Error to throw (network
 * failure).
 */
function makeFetchMock(handler?: (call: number) => Response | Error | undefined) {
  const calls: RecordedRequest[] = [];
  let seq = 0;
  const impl = (async (input: any, init?: any) => {
    const body = String(init?.body ?? '');
    const parsed = body ? JSON.parse(body) : null;
    calls.push({
      url: String(input),
      headers: { ...(init?.headers ?? {}) },
      hasSignal: init?.signal != null,
      body,
      parsed,
    });
    const result = handler?.(calls.length);
    if (result instanceof Error) throw result;
    if (result) return result;
    const ops: any[] = parsed?.ops ?? [];
    const acked = ops.map((op) => ({
      kind: op.kind,
      origin_id: op.origin_id,
      rev: op.rev ?? 1,
      seq: ++seq,
    }));
    return new Response(JSON.stringify({ acked, head_seq: seq }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('CloudSync', () => {
  let tempDir: string;
  let db: Database;
  let store: SessionStore;
  let settingsPath: string;
  let missingLegacyPath: string;

  function makeSettings(overrides: Partial<CloudSyncSettingKeys> = {}): CloudSyncSettingKeys {
    return {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token-1234',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-42',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
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

  function outboxRows(): Array<{ op_uuid: string; rev: number; body: any }> {
    return (db.prepare('SELECT op_uuid, rev, body FROM sync_outbox ORDER BY id').all() as Array<{ op_uuid: string; rev: number; body: string }>)
      .map(r => ({ op_uuid: r.op_uuid, rev: r.rev, body: JSON.parse(r.body) }));
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-cloud-sync-'));
    settingsPath = join(tempDir, 'settings.json');
    missingLegacyPath = join(tempDir, 'no-such-cloud-sync-state.json');
    db = new Database(':memory:');
    store = new SessionStore(db, { cloudSyncStatePath: missingLegacyPath });
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
  // Wire contract: ops POST bodies must follow the SyncApply BODY FIELD
  // MAPPING verbatim — field names are the local column names, values exactly
  // as stored (JSON-string columns stay strings), exclusions as listed there.
  // ---------------------------------------------------------------------------
  it('pushes {kind, origin_id, rev, body} ops per the SyncApply body contract', async () => {
    seedObservation();
    seedSummary();
    seedPrompt('hello world', 5, 1);

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl);
    await sync.flush();

    // One page per kind (outbox empty): observations, summaries, prompts.
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.url).toBe('https://hub.test/v1/sync/ops');
      expect(call.headers['Content-Type']).toBe('application/json');
      expect(call.headers['Authorization']).toBe('Bearer test-token-1234');
      expect(call.headers['X-User-Id']).toBe('user-42');
      expect(call.headers['X-Device-Id']).toBe('device-fixture');
      expect(call.headers['X-Device-Name']).toBe('test-host');
      expect(call.hasSignal).toBe(true); // AbortSignal.timeout on every POST
    }

    expect(calls[0].parsed).toEqual({
      ops: [{
        kind: 'observation',
        origin_id: '1',
        rev: 1,
        body: {
          memory_session_id: 'mem-1',
          project: 'proj-x',
          text: null,
          type: 'discovery',
          title: 'Title A',
          subtitle: 'Sub A',
          facts: '["fact one","fact two"]',   // JSON-string columns stay JSON strings
          narrative: 'The narrative',
          concepts: '["concept-a"]',
          files_read: '["/a.ts"]',
          files_modified: '[]',
          prompt_number: 3,
          discovery_tokens: 42,
          content_hash: null,
          generated_by_model: null,
          agent_type: null,
          agent_id: null,
          metadata: null,
          merged_into_project: null,
          created_at: ISO,
          created_at_epoch: 1751234567890,
        },
      }],
    });

    expect(calls[1].parsed).toEqual({
      ops: [{
        kind: 'summary',
        origin_id: '1',
        rev: 1,
        body: {
          memory_session_id: 'mem-1',
          project: 'proj-x',
          request: 'Req',
          investigated: 'Inv',
          learned: 'Lrn',
          completed: 'Done',
          next_steps: 'Next',
          files_read: null,
          files_edited: null,
          notes: null,
          prompt_number: 2,
          discovery_tokens: 0,
          merged_into_project: null,
          created_at: ISO,
          created_at_epoch: 1751234567891,
        },
      }],
    });

    // Prompt join fields resolve through sdk_sessions; session_db_id NEVER
    // travels (device-local rowid, re-resolved on apply).
    expect(calls[2].parsed).toEqual({
      ops: [{
        kind: 'prompt',
        origin_id: '1',
        rev: 1,
        body: {
          content_session_id: 'sess-abc',
          prompt_number: 5,
          prompt_text: 'hello world',
          created_at: ISO,
          created_at_epoch: 1751234567892,
          memory_session_id: 'mem-1',
          project: 'proj-x',
          platform_source: 'claude', // sdk_sessions column default
        },
      }],
    });

    // Everything stamped on ack.
    expect(pendingCount('observations')).toBe(0);
    expect(pendingCount('session_summaries')).toBe(0);
    expect(pendingCount('user_prompts')).toBe(0);
  });

  it('keeps SQL NULLs as JSON nulls and never re-parses stored JSON strings', async () => {
    seedObservation({
      title: null, subtitle: null, facts: null, narrative: null,
      concepts: null, files_read: null, files_modified: null,
    });

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    const body = calls[0].parsed.ops[0].body;
    expect(body.title).toBeNull();
    expect(body.facts).toBeNull();
    expect(body.files_modified).toBeNull();
    expect(body.memory_session_id).toBe('mem-1');
  });

  it('leaves join fields null for unlinked prompts (no legacy fallbacks)', async () => {
    seedPrompt('orphan prompt', 3, null);

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    const body = calls[0].parsed.ops[0].body;
    // The old lane substituted content_session_id/'unknown'; the hub contract
    // sends nulls and lets set_prompt_session repair the link later.
    expect(body.memory_session_id).toBeNull();
    expect(body.project).toBeNull();
    expect(body.platform_source).toBeNull();
    expect(pendingCount('user_prompts')).toBe(0);
  });

  it('never pushes replica rows (origin_device_id set), even when unsynced', async () => {
    seedObservation();
    db.prepare(`
      UPDATE observations SET origin_device_id = 'device-other', origin_local_id = '99', synced_at = NULL
      WHERE id = 1
    `).run();

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    expect(calls.length).toBe(0); // nothing native to push
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

  it('setFastDebounce(true) drops notify() to the fast tier; false restores the slow one (plan Phase 4 task 3)', async () => {
    seedObservation();

    const { impl, calls } = makeFetchMock();
    // Slow tier deliberately huge so ONLY the fast tier can flush in-test.
    const sync = makeCloudSync(impl, {}, { debounceMs: 60_000, fastDebounceMs: 10 });

    // Slow tier: a notify() burst must NOT flush within the test window.
    sync.notify();
    await sleep(120);
    expect(calls.length).toBe(0);

    // Socket goes live → fast tier: the same nudge flushes almost at once.
    sync.setFastDebounce(true);
    sync.notify();
    await sleep(120);
    expect(calls.length).toBe(1);
    expect(pendingCount('observations')).toBe(0);

    // Socket drops → slow tier again.
    sync.setFastDebounce(false);
    seedObservation({ title: 'second row' });
    sync.notify();
    await sleep(120);
    expect(calls.length).toBe(1); // still pending — back on the 60 s debounce
    expect(pendingCount('observations')).toBe(1);
    sync.stop();
  });

  it('loops 200-row pages until fully drained and stamps every batch', async () => {
    for (let i = 0; i < 450; i++) seedObservation({ title: `obs ${i}` });

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl);
    await sync.flush();

    expect(calls.length).toBe(3);
    expect(calls.map(c => c.parsed.ops.length)).toEqual([200, 200, 50]);
    expect(pendingCount('observations')).toBe(0);

    const status = sync.status();
    expect(status.pending).toEqual({ observations: 0, summaries: 0, prompts: 0, mutations: 0 });
    expect(status.lastFlushAt).not.toBeNull();
    expect(status.lastError).toBeNull();
  });

  it('packs oversized pages into multiple bodies, each under the request cap', async () => {
    // 12 rows × ~190KB narrative: each op stays under the 200KB field clamp,
    // but one 2MB request only fits 10 of them → two POSTs.
    for (let i = 0; i < 12; i++) seedObservation({ narrative: 'n'.repeat(190_000) });

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    expect(calls.length).toBe(2);
    const batchSizes = calls.map(c => c.parsed.ops.length);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(12);
    expect(batchSizes[0]).toBeLessThan(12);
    for (const call of calls) {
      expect(call.body.length).toBeLessThanOrEqual(2_100_000); // body budget + envelope
    }
    expect(pendingCount('observations')).toBe(0);
  });

  it('clamps giant prompts in SQL and appends the truncation marker', async () => {
    seedPrompt('x'.repeat(300_000));

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    expect(calls.length).toBe(1);
    const body = calls[0].parsed.ops[0].body;
    // substr(prompt_text,1,200000) in SQL, marker appended because
    // prompt_text_len > 200000; clampFields re-clamps the marked string back
    // to 200000 chars + marker. Net: original 200KB prefix + marker.
    expect(body.prompt_text).toBe('x'.repeat(200_000) + TRUNC_MARK);
    // The SQL-side helper column must not leak onto the wire.
    expect(Object.keys(body).sort()).toEqual([
      'content_session_id', 'created_at', 'created_at_epoch', 'memory_session_id',
      'platform_source', 'project', 'prompt_number', 'prompt_text',
    ]);
    expect(pendingCount('user_prompts')).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Mutation lane: sync_outbox drains FIRST (hub-log ordering — SyncApply's
  // title parking relies on set_title preceding the session's row ops), acks
  // DELETE outbox rows, and set_prompt_session ops get the resolved device id
  // substituted at push time.
  // ---------------------------------------------------------------------------
  describe('mutation outbox drain', () => {
    it('drains mutation ops before row kinds and deletes them on ack', async () => {
      store.createSDKSession('sess-title', 'proj-x', 'prompt', 'My Custom Title', 'claude');
      seedObservation();
      expect(outboxRows().length).toBe(1);

      const { impl, calls } = makeFetchMock();
      await makeCloudSync(impl).flush();

      expect(calls.length).toBe(2);
      const first = calls[0].parsed.ops[0];
      expect(first.kind).toBe('mutation');
      expect(first.rev).toBe(1);
      expect(first.body).toEqual({
        op: 'set_title',
        target: { content_session_id: 'sess-title', platform_source: 'claude' },
        fields: { custom_title: 'My Custom Title' },
      });
      expect(calls[1].parsed.ops[0].kind).toBe('observation');

      // Acked mutations are DELETEd (queue entries, not data).
      expect(outboxRows().length).toBe(0);
      expect(pendingCount('observations')).toBe(0);
    });

    it('reuses the enqueue-time op UUID across push retries (stable origin_id)', async () => {
      store.createSDKSession('sess-title', 'proj-x', 'prompt', 'Title', 'claude');
      const queuedUuid = outboxRows()[0].op_uuid;

      const { impl, calls } = makeFetchMock(call =>
        call === 1 ? new Response('hub sad', { status: 500 }) : undefined
      );
      const sync = makeCloudSync(impl, {}, { backoffInitialMs: 600_000 });

      await sync.flush();
      expect(outboxRows().length).toBe(1); // still queued after failure

      await sync.flush();
      expect(outboxRows().length).toBe(0);

      expect(calls.length).toBe(2);
      expect(calls[0].parsed.ops[0].origin_id).toBe(queuedUuid);
      expect(calls[1].parsed.ops[0].origin_id).toBe(queuedUuid);
      sync.stop();
    });

    it('substitutes the resolved device id into set_prompt_session targets at push time', async () => {
      seedPrompt('early prompt', 1, 1);
      // Stamp it synced so only the repair lane runs in this test.
      db.prepare('UPDATE user_prompts SET synced_at = 1 WHERE id = 1').run();
      store.updateMemorySessionId(1, 'mem-repaired');

      const queued = outboxRows();
      expect(queued.length).toBe(1);
      expect(queued[0].body.target.origin_device_id).toBeNull(); // NULL = "this device" at rest

      const { impl, calls } = makeFetchMock();
      await makeCloudSync(impl).flush();

      const mutationOps = calls.flatMap(c => c.parsed.ops).filter((o: any) => o.kind === 'mutation');
      expect(mutationOps.length).toBe(1);
      expect(mutationOps[0].body.op).toBe('set_prompt_session');
      expect(mutationOps[0].body.target).toEqual({
        origin_device_id: 'device-fixture',
        origin_local_id: '1',
      });
      expect(mutationOps[0].rev).toBe(2); // post-bump sync_rev per the REV MINTING RULES
      expect(outboxRows().length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Size invariant for ALL kinds: no op that leaves the client can be
  // size-refused by the hub — a refused mutation would 400 the whole batch
  // and (mutations draining first) wedge the entire push lane at backoff
  // forever.
  // ---------------------------------------------------------------------------
  describe('mutation body size clamping', () => {
    it('clamps an oversized custom title at enqueue (outbox never holds a refusable op)', () => {
      store.createSDKSession('sess-big', 'proj-x', 'p', 'T'.repeat(2_100_000), 'claude');

      const queued = outboxRows();
      expect(queued.length).toBe(1);
      const title = queued[0].body.fields.custom_title as string;
      expect(title.length).toBe(200_000 + TRUNC_MARK.length);
      expect(title.endsWith(TRUNC_MARK)).toBe(true);
    });

    it('re-clamps at the wire as a belt (covers remap-outbox and pre-clamp rows) and drains without wedging', async () => {
      // Bypass the enqueue-side clamp entirely — simulate an op queued by an
      // older build or another producer.
      db.prepare(`
        INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
        VALUES ('raw-uuid-1', 1, ?, 1)
      `).run(JSON.stringify({
        op: 'set_title',
        target: { content_session_id: 'sess-raw', platform_source: 'claude' },
        fields: { custom_title: 'X'.repeat(2_100_000) },
      }));

      const { impl, calls } = makeFetchMock();
      const sync = makeCloudSync(impl);
      await sync.flush();

      expect(calls.length).toBe(1);
      const op = calls[0].parsed.ops[0];
      expect(op.kind).toBe('mutation');
      const title = op.body.fields.custom_title as string;
      expect(title.length).toBe(200_000 + TRUNC_MARK.length);
      // The serialized op sits under the hub's 1,990,000-byte per-op backstop.
      expect(JSON.stringify(op).length).toBeLessThan(1_990_000);
      // Acked and deleted — the lane did not wedge.
      expect(outboxRows().length).toBe(0);
      expect(sync.status().lastError).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // stampAcked contract + the ack-driven-progress livelock guard.
  // ---------------------------------------------------------------------------
  describe('ack handling', () => {
    it('fails into backoff when a 200 response does not ack every pushed op (no line-rate livelock)', async () => {
      seedObservation({ title: 'first' });
      seedObservation({ title: 'second' });

      let seq = 0;
      const calls: any[] = [];
      const impl = (async (_input: any, init?: any) => {
        const parsed = JSON.parse(String(init?.body));
        calls.push(parsed);
        // Hub regression: acks only the FIRST pushed op of each request.
        const first = parsed.ops[0];
        return new Response(JSON.stringify({
          acked: [{ kind: first.kind, origin_id: first.origin_id, rev: first.rev, seq: ++seq }],
          head_seq: seq,
        }), { status: 200 });
      }) as typeof fetch;

      const sync = makeCloudSync(impl, {}, { backoffInitialMs: 600_000 });
      await sync.flush();

      // Exactly one POST — the un-acked op threw into backoff instead of
      // re-SELECTing and re-POSTing the same row forever.
      expect(calls.length).toBe(1);
      expect(sync.status().lastError).toContain('did not ack');
      // Partial progress kept: the acked row IS stamped, the other is not.
      expect(pendingCount('observations')).toBe(1);

      await sleep(150); // no spin while backing off
      expect(calls.length).toBe(1);
      sync.stop();
    });

    it('stamps correctly when acks come back reordered', async () => {
      seedObservation({ title: 'a' });
      seedObservation({ title: 'b' });
      seedObservation({ title: 'c' });

      let seq = 0;
      const impl = (async (_input: any, init?: any) => {
        const parsed = JSON.parse(String(init?.body));
        const acked = (parsed.ops as any[]).map((op) => ({
          kind: op.kind, origin_id: op.origin_id, rev: op.rev ?? 1, seq: ++seq,
        })).reverse(); // the hub may return acks in any order
        return new Response(JSON.stringify({ acked, head_seq: seq }), { status: 200 });
      }) as typeof fetch;

      const sync = makeCloudSync(impl);
      await sync.flush();

      expect(pendingCount('observations')).toBe(0);
      expect(sync.status().lastError).toBeNull();
    });

    it('ignores unknown-kind acks (forward compat) as long as every pushed op is acked', async () => {
      seedObservation();

      let seq = 0;
      const impl = (async (_input: any, init?: any) => {
        const parsed = JSON.parse(String(init?.body));
        const acked = (parsed.ops as any[]).map((op) => ({
          kind: op.kind, origin_id: op.origin_id, rev: op.rev ?? 1, seq: ++seq,
        }));
        // A future hub speaking a newer protocol appends an ack kind we
        // don't know — ignored, never guessed at, never a crash.
        acked.push({ kind: 'wormhole', origin_id: '999', rev: 1, seq: ++seq });
        return new Response(JSON.stringify({ acked, head_seq: seq }), { status: 200 });
      }) as typeof fetch;

      const sync = makeCloudSync(impl);
      await sync.flush();

      expect(pendingCount('observations')).toBe(0);
      expect(sync.status().lastError).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Rev-matched stamping — the ordering that replaced stampGuard: a mutation
  // site bumping sync_rev while a POST is in flight makes the (kind,
  // origin_id, rev) ack miss, so the row stays unsynced and the SAME flush
  // loop re-pushes it corrected at the higher rev.
  // ---------------------------------------------------------------------------
  it('does not stamp a prompt whose sync_rev was bumped mid-flight; re-pushes corrected', async () => {
    // A session that has not yet registered a memory id at SELECT time.
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-late', NULL, 'proj-late', ?, 1751234568000, 'active')
    `).run(ISO);
    db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (2, 'sess-late', 1, 'racy prompt', ?, 1751234567892)
    `).run(ISO);

    // Hold the first POST in flight so the registration can land mid-push.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bodies: any[] = [];
    let seq = 0;
    const impl = (async (_input: any, init?: any) => {
      const parsed = JSON.parse(String(init?.body));
      bodies.push(parsed);
      if (bodies.length === 1) await gate;
      const acked = (parsed.ops as any[]).map((op) => ({
        kind: op.kind, origin_id: op.origin_id, rev: op.rev ?? 1, seq: ++seq,
      }));
      return new Response(JSON.stringify({ acked, head_seq: seq }), { status: 200 });
    }) as typeof fetch;

    const sync = makeCloudSync(impl);
    const flushPromise = sync.flush();
    for (let i = 0; i < 100 && bodies.length === 0; i++) await sleep(2);
    expect(bodies.length).toBe(1);
    expect(bodies[0].ops[0].rev).toBe(1);
    expect(bodies[0].ops[0].body.memory_session_id).toBeNull(); // unregistered at SELECT time

    // The memory id lands now — the REAL mutation site: bumps sync_rev to 2,
    // re-nulls synced_at (already NULL), and enqueues set_prompt_session@2.
    store.updateMemorySessionId(2, 'mem-late');

    release();
    await flushPromise;

    // The rev-1 ack must NOT stamp the now-rev-2 row; the same flush loop
    // re-pushes it with the registered mapping at rev 2 and stamps that.
    const rowPushes = bodies.filter(b => b.ops.some((o: any) => o.kind === 'prompt'));
    expect(rowPushes.length).toBe(2);
    const second = rowPushes[1].ops.find((o: any) => o.kind === 'prompt');
    expect(second.rev).toBe(2);
    expect(second.body.memory_session_id).toBe('mem-late');
    expect(second.body.project).toBe('proj-late');
    expect(pendingCount('user_prompts')).toBe(0);
  });

  it('reports head_seq to the registered listener after every successful push', async () => {
    seedObservation();
    seedSummary();

    const { impl } = makeFetchMock();
    const sync = makeCloudSync(impl);
    const seen: number[] = [];
    sync.setHeadSeqListener(seq => seen.push(seq));

    await sync.flush();
    expect(seen.length).toBe(2); // one per POST (observation page, summary page)
    expect(seen[seen.length - 1]).toBe(2);
  });

  it('leaves rows unsynced and records lastError on HTTP failure, then retries via backoff', async () => {
    seedObservation();

    const { impl, calls } = makeFetchMock(call =>
      call === 1 ? new Response('server sad', { status: 500 }) : undefined
    );
    const sync = makeCloudSync(impl);

    await sync.flush();
    expect(pendingCount('observations')).toBe(1);
    expect(sync.status().lastError).toContain('sync hub push 500');
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
      return new Response(JSON.stringify({ acked: [], head_seq: 0 }), { status: 200 });
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

  it('sync is OFF entirely when the hub URL is empty (hard cutover — no legacy lane)', async () => {
    seedObservation();

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '' });

    sync.start();
    sync.notify();
    await sync.flush();
    await sleep(120);

    expect(calls.length).toBe(0);
    expect(sync.status().configured).toBe(false);
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

  describe('sync-mode piggyback (kill switch, plan Phase 5 task 2)', () => {
    /** Hub that acks properly AND stamps X-Sync-Mode when `mode` is set. */
    function makeModeFetch(mode: string | null) {
      let seq = 0;
      const impl = (async (_input: any, init?: any) => {
        const parsed = JSON.parse(String(init?.body ?? '{}'));
        const acked = (parsed.ops ?? []).map((op: any) => ({
          kind: op.kind,
          origin_id: op.origin_id,
          rev: op.rev ?? 1,
          seq: ++seq,
        }));
        const headers: Record<string, string> = {};
        if (mode !== null) headers['X-Sync-Mode'] = mode;
        return new Response(JSON.stringify({ acked, head_seq: seq }), { status: 200, headers });
      }) as typeof fetch;
      return impl;
    }

    it("surfaces 'poll' to the sync-mode listener when the hub stamps the header (push still fully works)", async () => {
      seedObservation();
      const modes: Array<string | null> = [];
      const sync = makeCloudSync(makeModeFetch('poll'));
      sync.setSyncModeListener((mode) => modes.push(mode));

      await sync.flush();

      expect(modes).toEqual(['poll']);
      // The structural guarantee: a tripped kill switch never blocks the
      // durable push lane — the row was acked and stamped as usual.
      expect(pendingCount('observations')).toBe(0);
    });

    it('surfaces null when the header is absent (mode cleared)', async () => {
      seedObservation();
      const modes: Array<string | null> = [];
      const sync = makeCloudSync(makeModeFetch(null));
      sync.setSyncModeListener((mode) => modes.push(mode));

      await sync.flush();

      expect(modes).toEqual([null]);
      expect(pendingCount('observations')).toBe(0);
    });

    it('a throwing sync-mode listener never fails the flush', async () => {
      seedObservation();
      const sync = makeCloudSync(makeModeFetch('poll'));
      sync.setSyncModeListener(() => {
        throw new Error('listener bug');
      });

      await sync.flush();

      expect(pendingCount('observations')).toBe(0);
      expect(sync.status().lastError).toBeNull();
    });

    /** Hub that only ever errors, with or without the mode header. */
    function makeErrorFetch(mode: string | null, status = 503) {
      const impl = (async () => {
        const headers: Record<string, string> = {};
        if (mode !== null) headers['X-Sync-Mode'] = mode;
        return new Response('hub down', { status, headers });
      }) as typeof fetch;
      return impl;
    }

    it("emits 'poll' from an ERROR response that carries the header", async () => {
      seedObservation();
      const modes: Array<string | null> = [];
      const sync = makeCloudSync(makeErrorFetch('poll'));
      sync.setSyncModeListener((mode) => modes.push(mode));

      await sync.flush(); // push fails into backoff; the hint still lands

      expect(modes).toEqual(['poll']);
      expect(pendingCount('observations')).toBe(1); // queued for retry
    });

    it('emits NOTHING from an ERROR response without the header (absence is only authoritative on OK)', async () => {
      // Correlated incident: a 503ing auth upstream produces unstamped
      // errors — reporting null here would flap a poll-moded client back
      // into socket churn for the whole outage.
      seedObservation();
      const modes: Array<string | null> = [];
      const sync = makeCloudSync(makeErrorFetch(null));
      sync.setSyncModeListener((mode) => modes.push(mode));

      await sync.flush();

      expect(modes).toEqual([]);
      expect(pendingCount('observations')).toBe(1);
    });
  });
});
