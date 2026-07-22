// Phase 3 verification (plan 2026-07-17): the push drain retargeted at the
// sync hub. One endpoint (POST /v1/sync/ops), op bodies per the SyncApply
// BODY FIELD MAPPING, rev-matched stamping on ack (which replaced the old
// stampGuard machinery — see the mid-flight-bump test), and the sync_outbox
// mutation lane drained ahead of row kinds. Harness style unchanged:
// in-temp-dir SessionStore over an in-memory DB, injected fetchImpl, fast
// debounce/backoff.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, type CloudSyncSettingKeys, type CloudSyncOptions } from '../../../src/services/sync/CloudSync.js';
import { buildContentOperation, stableDocumentId } from '../../../src/services/sync/CanonicalContent.js';

const ISO = '2026-07-09T00:00:00.000Z';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  hasSignal: boolean;
  body: string;
  parsed: any;
  wireParsed: any;
}

function localPayloadView(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (payload === null) return null;
  const result: Record<string, unknown> = { ...payload };
  for (const key of ['created_at_epoch', 'discovery_tokens', 'prompt_number']) {
    if (typeof result[key] === 'string') result[key] = Number(result[key]);
  }
  for (const key of ['concepts', 'facts', 'files_edited', 'files_modified', 'files_read']) {
    if (Array.isArray(result[key])) result[key] = JSON.stringify(result[key]);
  }
  if (result.metadata && typeof result.metadata === 'object') result.metadata = JSON.stringify(result.metadata);
  return result;
}

function legacyOpView(op: { body: string; operation_sha256: string }): Record<string, unknown> {
  const envelope = JSON.parse(op.body) as Record<string, unknown>;
  return {
    kind: envelope.kind,
    origin_id: envelope.origin_local_id ?? String(envelope.id).slice('mutation:'.length),
    rev: envelope.entity_rev,
    body: envelope.kind === 'mutation'
      ? envelope.mutation
      : localPayloadView(envelope.payload as Record<string, unknown> | null),
  };
}

function canonicalAck(op: { body: string; operation_sha256: string }, seq: number | string): Record<string, unknown> {
  const envelope = JSON.parse(op.body) as Record<string, unknown>;
  return {
    id: envelope.id,
    kind: envelope.kind,
    origin_local_id: envelope.origin_local_id,
    entity_rev: envelope.entity_rev,
    operation_sha256: op.operation_sha256,
    seq: String(seq),
  };
}

function canonicalSuccess(
  acked: unknown[],
  headSeq: number | string,
  headers?: HeadersInit,
  projectedSeq: number | string = headSeq,
): Response {
  return new Response(JSON.stringify({
    acked,
    head_seq: String(headSeq),
    projected_seq: String(projectedSeq),
  }), { status: 200, headers });
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
    const wireParsed = body ? JSON.parse(body) : null;
    const parsed = wireParsed ? { ops: (wireParsed.ops ?? []).map(legacyOpView) } : null;
    calls.push({
      url: String(input),
      headers: { ...(init?.headers ?? {}) },
      hasSignal: init?.signal != null,
      body,
      parsed,
      wireParsed,
    });
    const result = handler?.(calls.length);
    if (result instanceof Error) throw result;
    if (result) return result;
    const ops: any[] = wireParsed?.ops ?? [];
    const acked = ops.map((op) => {
      const envelope = JSON.parse(op.body);
      return {
        id: envelope.id,
        kind: envelope.kind,
        origin_local_id: envelope.origin_local_id,
        entity_rev: envelope.entity_rev,
        operation_sha256: op.operation_sha256,
        seq: String(++seq),
      };
    });
    return new Response(JSON.stringify({
      acked,
      head_seq: String(seq),
      projected_seq: String(seq),
    }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe('CloudSync', () => {
  let tempDir: string;
  let db: Database;
  let store: SessionStore;
  let settingsPath: string;

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

  function outboxRows(): Array<{ op_uuid: string; rev: string; body: any }> {
    return (db.prepare('SELECT op_uuid, CAST(rev AS TEXT) AS rev, body FROM sync_outbox ORDER BY id').all() as Array<{ op_uuid: string; rev: string; body: string }>)
      .map(r => ({ op_uuid: r.op_uuid, rev: r.rev, body: JSON.parse(r.body) }));
  }

  function observationPayload(title: string): Record<string, unknown> {
    return {
      memory_session_id: 'mem-1',
      project: 'proj-x',
      text: null,
      type: 'discovery',
      title,
      subtitle: 'Sub A',
      facts: ['fact one', 'fact two'],
      narrative: 'The narrative',
      concepts: ['concept-a'],
      files_read: ['/a.ts'],
      files_modified: [],
      prompt_number: '3',
      discovery_tokens: '42',
      content_hash: null,
      generated_by_model: null,
      agent_type: null,
      agent_id: null,
      metadata: null,
      merged_into_project: null,
      created_at: ISO,
      created_at_epoch: '1751234567890',
    };
  }

  function seedFrozenAckState(): void {
    seedObservation({ title: 'first' });
    seedObservation({ title: 'second' });
    db.prepare('UPDATE observations SET sync_rev = ?').run('2');
    for (const [originLocalId, title] of [['1', 'first'], ['2', 'second']] as const) {
      const op = buildContentOperation({
        kind: 'observation',
        originDeviceId: 'device-fixture',
        originLocalId,
        entityRev: '2',
        payload: observationPayload(title),
      });
      const body = JSON.parse(op.body);
      db.prepare(`
        INSERT INTO sync_content_outbox
          (entity_id, kind, origin_local_id, entity_rev, body,
           operation_sha256, deleted, created_at_epoch)
        VALUES (?, 'observation', ?, '2', ?, ?, 0, 1)
      `).run(body.id, originLocalId, op.body, op.operation_sha256);
    }

    const prior = buildContentOperation({
      kind: 'observation',
      originDeviceId: 'device-fixture',
      originLocalId: '1',
      entityRev: '1',
      payload: observationPayload('prior'),
    });
    const priorBody = JSON.parse(prior.body);
    db.prepare(`
      INSERT INTO sync_entity_heads
        (entity_id, kind, origin_device_id, origin_local_id, entity_rev,
         operation_sha256, deleted, updated_at_epoch)
      VALUES (?, 'observation', 'device-fixture', '1', '1', ?, 0, 1)
    `).run(priorBody.id, prior.operation_sha256);

    // Content snapshots drain first, so this mutation is also provably
    // untouched when the content response fails validation.
    store.createSDKSession('ack-proof-session', 'proj-x', 'prompt', 'queued title', 'claude');
  }

  function ackDurabilityState(): Record<string, unknown> {
    return {
      contentOutbox: db.prepare(`
        SELECT entity_id, kind, origin_local_id, entity_rev, body,
               operation_sha256, deleted, created_at_epoch
        FROM sync_content_outbox ORDER BY id
      `).all(),
      mutationOutbox: db.prepare(`
        SELECT CAST(id AS TEXT) AS id, op_uuid, CAST(rev AS TEXT) AS rev,
               body, canonical_body, operation_sha256, created_at_epoch
        FROM sync_outbox ORDER BY id
      `).all(),
      heads: db.prepare(`
        SELECT entity_id, kind, origin_device_id, origin_local_id, entity_rev,
               operation_sha256, deleted, updated_at_epoch
        FROM sync_entity_heads ORDER BY entity_id
      `).all(),
      rows: db.prepare(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev, synced_at
        FROM observations ORDER BY id
      `).all(),
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-cloud-sync-'));
    settingsPath = join(tempDir, 'settings.json');
    db = new Database(':memory:');
    store = new SessionStore(db);
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
        rev: '1',
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
        rev: '1',
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
        rev: '1',
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
    // The canonical payload requires project; orphan prompts use the explicit
    // sentinel while set_prompt_session repairs the missing memory link.
    expect(body.memory_session_id).toBeNull();
    expect(body.project).toBe('unknown');
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
    expect(status.pending).toEqual({ observations: 0, summaries: 0, prompts: 0, mutations: 0, tombstones: 0 });
    expect(status.lastFlushAt).not.toBeNull();
    expect(status.lastError).toBeNull();
  });

  it('authenticates a read-only Hub status probe even when the local queue is empty', async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: unknown; hasSignal: boolean }> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
        hasSignal: init?.signal != null,
      });
      return Response.json({
        protocol_version: 2,
        epoch: '18446744073709551615',
        head_seq: '9007199254740993',
        projected_seq: '9007199254740993',
        op_count: 7,
        device_count: 2,
      });
    }) as typeof fetch;
    const sync = makeCloudSync(impl);

    // An empty drain performs no write request and therefore proves nothing
    // about connectivity. The status route's probe must still hit the Hub.
    await sync.flush();
    expect(calls).toHaveLength(0);
    const status = await sync.statusWithHubProbe();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hub.test/v1/sync/status');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].hasSignal).toBe(true);
    expect(calls[0].headers.get('Authorization')).toBe('Bearer test-token-1234');
    expect(calls[0].headers.get('X-User-Id')).toBe('user-42');
    expect(calls[0].headers.get('X-Device-Id')).toBe('device-fixture');
    expect(calls[0].headers.get('X-Device-Name')).toBe('test-host');
    expect(status.pending).toEqual({ observations: 0, summaries: 0, prompts: 0, mutations: 0, tombstones: 0 });
    expect(status.hub).toMatchObject({
      reachable: true,
      epoch: '18446744073709551615',
      headSeq: '9007199254740993',
      projectedSeq: '9007199254740993',
      error: null,
    });
    expect(status.hub.checkedAt).toBeNumber();
  });

  it('surfaces Hub authentication, network, and malformed-status failures without leaking the token', async () => {
    const scenarios: Array<{ response: Response | Error; error: RegExp }> = [
      {
        response: new Response('denied test-token-1234', { status: 401 }),
        error: /sync hub status 401: denied \[REDACTED\]/,
      },
      { response: new Error('connect ECONNREFUSED'), error: /ECONNREFUSED/ },
      {
        response: Response.json({ protocol_version: 2, epoch: '1', head_seq: '2', projected_seq: '3' }),
        error: /projected_seq exceeds head_seq/,
      },
    ];
    for (const scenario of scenarios) {
      const impl = (async () => {
        if (scenario.response instanceof Error) throw scenario.response;
        return scenario.response.clone();
      }) as typeof fetch;
      const sync = makeCloudSync(impl);
      const status = await sync.statusWithHubProbe();
      expect(status.hub).toMatchObject({
        reachable: false,
        epoch: null,
        headSeq: null,
        projectedSeq: null,
      });
      expect(status.hub.error).toMatch(scenario.error);
      expect(JSON.stringify(status)).not.toContain('test-token-1234');
      expect(status.lastError).toBeNull();
      sync.stop();
    }
  });

  it('packs oversized pages into multiple bodies, each under the request cap', async () => {
    // Each operation stays under the 256KB canonical-body cap while the
    // combined page crosses the 4MB request packing budget.
    for (let i = 0; i < 20; i++) seedObservation({ narrative: 'n'.repeat(220_000) });

    const { impl, calls } = makeFetchMock();
    await makeCloudSync(impl).flush();

    expect(calls.length).toBe(2);
    const batchSizes = calls.map(c => c.parsed.ops.length);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(20);
    expect(batchSizes[0]).toBeLessThan(20);
    for (const call of calls) {
      expect(Buffer.byteLength(call.body, 'utf8')).toBeLessThanOrEqual(4_000_000);
    }
    expect(pendingCount('observations')).toBe(0);
  });

  it('rejects a prompt whose canonical body exceeds the 256KB bound without stamping it', async () => {
    seedPrompt('x'.repeat(300_000));
    seedPrompt('following row', 6);

    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl);
    await sync.flush();

    expect(calls.length).toBe(1);
    expect(pendingCount('user_prompts')).toBe(0);
    expect(db.prepare('SELECT synced_at FROM user_prompts WHERE id = 1').get())
      .toEqual({ synced_at: -1 });
    expect(sync.status().quarantine.count).toBe(1);
    expect(sync.status().quarantine.latestReason).toMatch(/256000 UTF-8 bytes/);
    expect(db.prepare('SELECT synced_at FROM user_prompts WHERE id = 2').get() as { synced_at: number })
      .toMatchObject({ synced_at: expect.any(Number) });
  });

  it('queues a durable tombstone and revives the same stable entity at a higher revision', async () => {
    seedObservation();
    const { impl, calls } = makeFetchMock();
    const sync = makeCloudSync(impl);
    await sync.flush();

    expect(sync.queueDelete('observation', '1', '2026-07-20T13:00:00.000Z')).toBe('2');
    expect((db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n).toBe(0);
    expect(sync.status().pending.tombstones).toBe(1);
    await sync.flush();

    const tombstone = JSON.parse(calls.at(-1)!.wireParsed.ops[0].body);
    expect(tombstone).toMatchObject({ deleted: true, entity_rev: '2', payload: null });
    expect(sync.status().pending.tombstones).toBe(0);
    expect(db.prepare('SELECT entity_rev, deleted FROM sync_entity_heads').get())
      .toEqual({ entity_rev: '2', deleted: 1 });

    db.prepare(`
      INSERT INTO observations
        (id, memory_session_id, project, type, title, subtitle, facts, narrative,
         concepts, files_read, files_modified, prompt_number, discovery_tokens,
         created_at, created_at_epoch)
      VALUES (1, 'mem-1', 'proj-x', 'discovery', 'Revived', 'Sub A',
        '["fact one","fact two"]', 'The narrative', '["concept-a"]',
        '["/a.ts"]', '[]', 3, 42, ?, 1751234567890)
    `).run(ISO);
    await sync.flush();
    const revive = JSON.parse(calls.at(-1)!.wireParsed.ops[0].body);
    expect(revive).toMatchObject({ deleted: false, entity_rev: '3' });
    expect(revive.payload.title).toBe('Revived');
    expect(db.prepare('SELECT sync_rev FROM observations WHERE id = 1').get())
      .toEqual({ sync_rev: '3' });
    expect(db.prepare('SELECT entity_rev, deleted FROM sync_entity_heads').get())
      .toEqual({ entity_rev: '3', deleted: 0 });
  });

  it('mints delete rev=max(local,pending,head)+1 and supersedes pending live bytes', () => {
    seedObservation();
    db.prepare('UPDATE observations SET sync_rev = 3 WHERE id = 1').run();
    const entityId = stableDocumentId('observation', 'device-fixture', '1');
    const headOp = buildContentOperation({
      kind: 'observation', originDeviceId: 'device-fixture', originLocalId: '1', entityRev: '5',
      payload: {
        memory_session_id: 'mem-1', project: 'proj-x', text: null, type: 'discovery', title: 'old',
        subtitle: null, facts: null, narrative: null, concepts: null, files_read: null,
        files_modified: null, prompt_number: null, discovery_tokens: '0', content_hash: null,
        generated_by_model: null, agent_type: null, agent_id: null, metadata: null,
        merged_into_project: null, created_at: ISO, created_at_epoch: '1751234567890',
      },
    });
    db.prepare(`
      INSERT INTO sync_entity_heads
        (entity_id, kind, origin_device_id, origin_local_id, entity_rev,
         operation_sha256, deleted, updated_at_epoch)
      VALUES (?, 'observation', 'device-fixture', '1', '5', ?, 0, 1)
    `).run(entityId, headOp.operation_sha256);
    const pending = buildContentOperation({
      kind: 'observation', originDeviceId: 'device-fixture', originLocalId: '1', entityRev: '7',
      payload: JSON.parse(headOp.body).payload,
    });
    db.prepare(`
      INSERT INTO sync_content_outbox
        (entity_id, kind, origin_local_id, entity_rev, body, operation_sha256, deleted, created_at_epoch)
      VALUES (?, 'observation', '1', '7', ?, ?, 0, 1)
    `).run(entityId, pending.body, pending.operation_sha256);

    const sync = makeCloudSync(makeFetchMock().impl);
    expect(sync.queueDelete('observation', '1', '2026-07-20T13:00:00.000Z')).toBe('8');
    expect(db.prepare('SELECT entity_rev, deleted FROM sync_content_outbox').all())
      .toEqual([{ entity_rev: '8', deleted: 1 }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 0 });
  });

  it('retries live, mutation, tombstone, and revive operations with byte-identical frozen wrappers', async () => {
    const calls: RecordedRequest[] = [];
    let seq = 0;
    let failNext = false;
    const impl = (async (input: any, init?: any) => {
      const body = String(init?.body ?? '');
      const wireParsed = JSON.parse(body);
      calls.push({
        url: String(input), headers: { ...(init?.headers ?? {}) }, hasSignal: !!init?.signal,
        body, wireParsed, parsed: { ops: wireParsed.ops.map(legacyOpView) },
      });
      if (failNext) {
        failNext = false;
        return new Response('retry', { status: 500 });
      }
      const acked = wireParsed.ops.map((op: any) => canonicalAck(op, ++seq));
      return canonicalSuccess(acked, seq);
    }) as typeof fetch;
    const sync = makeCloudSync(impl, {}, { backoffInitialMs: 60_000, backoffMaxMs: 60_000 });

    const assertNextRetryExact = async (): Promise<any> => {
      const start = calls.length;
      failNext = true;
      await sync.flush();
      expect(calls.length).toBe(start + 1);
      const persisted = calls[start].wireParsed.ops[0];
      await sync.flush();
      expect(calls.length).toBe(start + 2);
      expect(calls[start + 1].wireParsed.ops[0]).toEqual(persisted);
      expect(calls[start + 1].body).toBe(calls[start].body);
      return JSON.parse(persisted.body);
    };

    seedObservation();
    expect((await assertNextRetryExact()).deleted).toBe(false); // live

    store.createSDKSession('sess-retry-mutation', 'proj-x', 'p', 'title', 'claude');
    expect((await assertNextRetryExact()).kind).toBe('mutation');

    expect(sync.queueDelete('observation', '1')).toBe('2');
    expect((await assertNextRetryExact()).deleted).toBe(true); // tombstone

    seedObservation({ title: 'revived' });
    db.prepare('UPDATE observations SET id = 1 WHERE id = 2').run();
    const revived = await assertNextRetryExact();
    expect(revived).toMatchObject({ deleted: false, entity_rev: '3' });
  });

  it('keeps an in-flight snapshot immutable and queues a higher rev for same-rev local drift', async () => {
    seedObservation();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent: any[] = [];
    let seq = 0;
    const impl = (async (_input: any, init?: any) => {
      const parsed = JSON.parse(String(init?.body));
      sent.push(parsed);
      if (sent.length === 1) await gate;
      return canonicalSuccess(parsed.ops.map((op: any) => canonicalAck(op, ++seq)), seq);
    }) as typeof fetch;
    const sync = makeCloudSync(impl);
    const flushing = sync.flush();
    for (let i = 0; i < 100 && sent.length === 0; i++) await sleep(2);

    const first = JSON.parse(sent[0].ops[0].body);
    expect(first).toMatchObject({ entity_rev: '1', payload: { title: 'Title A' } });
    db.prepare("UPDATE observations SET title = 'changed without rev bump', synced_at = NULL WHERE id = 1").run();
    const frozen = db.prepare(
      'SELECT body FROM sync_content_outbox WHERE entity_rev = ?'
    ).get('1') as { body: string };
    expect(JSON.parse(frozen.body).payload.title).toBe('Title A');

    release();
    await flushing;
    const rowOps = sent.flatMap(page => page.ops).map((op: any) => JSON.parse(op.body))
      .filter((body: any) => body.kind === 'observation');
    expect(rowOps.map((body: any) => [body.entity_rev, body.payload.title])).toEqual([
      ['1', 'Title A'],
      ['2', 'changed without rev bump'],
    ]);
    expect(db.prepare('SELECT sync_rev, synced_at FROM observations WHERE id = 1').get())
      .toMatchObject({ sync_rev: '2', synced_at: expect.any(Number) });
  });

  it('keeps an acked snapshot committed when in-flight local drift becomes invalid', async () => {
    seedObservation();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent: any[] = [];
    let seq = 0;
    const impl = (async (_input: any, init?: any) => {
      const parsed = JSON.parse(String(init?.body));
      sent.push(parsed);
      if (sent.length === 1) await gate;
      const acked = parsed.ops.map((op: any) => canonicalAck(op, ++seq));
      return canonicalSuccess(acked, seq);
    }) as typeof fetch;
    const sync = makeCloudSync(impl, {}, { backoffInitialMs: 60_000 });
    const flushing = sync.flush();
    for (let i = 0; i < 100 && sent.length === 0; i++) await sleep(2);

    const frozen = sent[0].ops[0];
    const frozenBody = JSON.parse(frozen.body);
    expect(frozenBody).toMatchObject({
      origin_local_id: '1',
      entity_rev: '1',
      payload: { narrative: 'The narrative' },
    });

    // An out-of-band same-rev edit lands while rev 1 is in flight. It cannot
    // be serialized under the canonical 256 KB cap. A later valid row lands
    // too, proving this poison row does not stop same-flush progress.
    db.prepare("UPDATE observations SET narrative = ?, synced_at = NULL WHERE id = 1")
      .run('X'.repeat(300_000));
    seedObservation({ title: 'valid following row' });

    release();
    await flushing;

    const bodies = sent.flatMap(page => page.ops).map((op: any) => JSON.parse(op.body));
    expect(bodies.map((body: any) => [body.origin_local_id, body.payload.title])).toEqual([
      ['1', 'Title A'],
      ['2', 'valid following row'],
    ]);
    expect(db.prepare(
      'SELECT CAST(sync_rev AS TEXT) AS sync_rev, synced_at FROM observations WHERE id = 1'
    ).get()).toEqual({ sync_rev: '1', synced_at: -1 });
    expect(db.prepare(
      'SELECT CAST(sync_rev AS TEXT) AS sync_rev, synced_at FROM observations WHERE id = 2'
    ).get()).toMatchObject({ sync_rev: '1', synced_at: expect.any(Number) });

    const head = db.prepare(`
      SELECT entity_rev, operation_sha256, deleted
      FROM sync_entity_heads WHERE entity_id = ?
    `).get(frozenBody.id);
    expect(head).toEqual({
      entity_rev: '1',
      operation_sha256: frozen.operation_sha256,
      deleted: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_content_outbox').get()).toEqual({ n: 0 });

    const dead = db.prepare(`
      SELECT lane, queue_key, origin_local_id, entity_rev, reason, raw_body
      FROM sync_dead_letter
    `).get() as {
      lane: string;
      queue_key: string;
      origin_local_id: string;
      entity_rev: string;
      reason: string;
      raw_body: string;
    };
    expect(dead).toMatchObject({
      lane: 'content',
      queue_key: frozenBody.id,
      origin_local_id: '1',
      entity_rev: '1',
    });
    expect(dead.reason).toContain('body exceeds 256000 UTF-8 bytes');
    expect(JSON.parse(dead.raw_body).narrative).toBe('X'.repeat(300_000));
    expect(sync.status()).toMatchObject({
      pending: { observations: 0 },
      quarantine: { count: 1 },
      lastError: null,
    });

    // Neither the successful flush nor a later explicit pass retries the
    // acknowledged frozen bytes or the quarantined current row.
    await sync.flush();
    await sleep(50);
    expect(sent.length).toBe(2);
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
      expect(first.rev).toBe('1');
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
      expect(mutationOps[0].rev).toBe('2'); // post-bump sync_rev per the REV MINTING RULES
      expect(outboxRows().length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Size invariant for ALL kinds: no op that leaves the client can be
  // size-refused by the hub — a refused mutation would 400 the whole batch
  // and (mutations draining first) wedge the entire push lane at backoff
  // forever.
  // ---------------------------------------------------------------------------
  describe('mutation UTF-8 validation and quarantine', () => {
    it('rejects an oversized custom title before enqueue without rewriting semantics', () => {
      expect(() => store.createSDKSession(
        'sess-big', 'proj-x', 'p', '🐡'.repeat(1_024) + 'a', 'claude'
      )).toThrow(/4096 UTF-8 bytes/);

      expect(outboxRows()).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM sdk_sessions WHERE content_session_id = 'sess-big'").get())
        .toEqual({ n: 0 });
    });

    it('dead-letters a historical oversized mutation unchanged and lets the following mutation progress', async () => {
      db.prepare(`
        INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
        VALUES ('77777777-7777-4777-8777-777777777777', 1, ?, 1)
      `).run(JSON.stringify({
        op: 'set_title',
        target: { content_session_id: 'sess-raw', platform_source: 'claude' },
        fields: { custom_title: 'X'.repeat(2_100_000) },
      }));
      store.createSDKSession('sess-good', 'proj-x', 'p', 'exact title', 'claude');

      const { impl, calls } = makeFetchMock();
      const sync = makeCloudSync(impl);
      await sync.flush();

      expect(calls.length).toBe(1);
      const op = calls[0].parsed.ops[0];
      expect(op.kind).toBe('mutation');
      expect(op.body.fields.custom_title).toBe('exact title');
      expect(outboxRows().length).toBe(0);
      expect(sync.status().lastError).toBeNull();
      expect(sync.status().quarantine.count).toBe(1);
      expect(sync.status().quarantine.latestReason).toMatch(/4096 UTF-8 bytes/);
      const dead = db.prepare(
        "SELECT raw_body FROM sync_dead_letter WHERE lane = 'mutation'"
      ).get() as { raw_body: string };
      expect(JSON.parse(dead.raw_body).fields.custom_title).toBe('X'.repeat(2_100_000));
    });
  });

  // ---------------------------------------------------------------------------
  // stampAcked contract + the ack-driven-progress livelock guard.
  // ---------------------------------------------------------------------------
  describe('ack handling', () => {
    const invalidTupleScenarios: Array<{
      name: string;
      mutate: (acks: any[], ops: any[]) => any[];
      error: RegExp;
    }> = [
      {
        name: 'missing acknowledgment',
        mutate: acks => acks.slice(0, 1),
        error: /multiplicity mismatch/,
      },
      {
        name: 'duplicate acknowledgment',
        mutate: acks => [...acks, { ...acks[0] }],
        error: /multiplicity mismatch/,
      },
      {
        name: 'extra acknowledgment',
        mutate: acks => [...acks, { ...acks[0], id: 'observation:extra' }],
        error: /extra or mismatched/,
      },
      {
        name: 'wrong kind',
        mutate: acks => [{ ...acks[0], kind: 'summary' }, acks[1]],
        error: /extra or mismatched/,
      },
      {
        name: 'wrong id',
        mutate: acks => [{ ...acks[0], id: 'observation:wrong' }, acks[1]],
        error: /extra or mismatched/,
      },
      {
        name: 'wrong entity revision',
        mutate: acks => [{ ...acks[0], entity_rev: '3' }, acks[1]],
        error: /extra or mismatched/,
      },
      {
        name: 'wrong operation hash',
        mutate: acks => [{ ...acks[0], operation_sha256: 'A'.repeat(43) }, acks[1]],
        error: /extra or mismatched/,
      },
      {
        name: 'distinct tuples reusing one sequence',
        mutate: acks => [acks[0], { ...acks[1], seq: acks[0].seq }],
        error: /distinct operation tuples claimed the same sequence/,
      },
    ];

    for (const scenario of invalidTupleScenarios) {
      it(`rejects a 200 with ${scenario.name} before any acknowledgment state changes`, async () => {
        seedFrozenAckState();
        const before = ackDurabilityState();
        const calls: any[] = [];
        const impl = (async (_input: any, init?: any) => {
          const parsed = JSON.parse(String(init?.body));
          calls.push(parsed);
          const acked = parsed.ops.map((op: any, index: number) => canonicalAck(op, index + 1));
          return canonicalSuccess(scenario.mutate(acked, parsed.ops), 3);
        }) as typeof fetch;

        const sync = makeCloudSync(impl, {}, { backoffInitialMs: 600_000 });
        const seenHeads: string[] = [];
        sync.setHeadSeqListener(head => seenHeads.push(head));
        await sync.flush();

        expect(calls).toHaveLength(1);
        expect(sync.status().lastError).toMatch(scenario.error);
        expect(ackDurabilityState()).toEqual(before);
        expect(seenHeads).toEqual([]);
        await sleep(50);
        expect(calls).toHaveLength(1); // invalid 200 entered backoff, never line-rate retry
        sync.stop();
      });
    }

    const invalidSequenceScenarios: Array<{
      name: string;
      change: (acks: any[]) => { acks: any[]; head: string; projected: string };
      error: RegExp;
    }> = [
      {
        name: 'zero ack seq',
        change: acks => ({ acks: [{ ...acks[0], seq: '0' }, acks[1]], head: '2', projected: '2' }),
        error: /decimal value must be positive/,
      },
      {
        name: 'noncanonical ack seq',
        change: acks => ({ acks: [{ ...acks[0], seq: '01' }, acks[1]], head: '2', projected: '2' }),
        error: /without leading zeroes/,
      },
      {
        name: 'ack seq beyond head',
        change: acks => ({ acks: [{ ...acks[0], seq: '3' }, acks[1]], head: '2', projected: '3' }),
        error: /seq exceeds head_seq/,
      },
      {
        name: 'head beyond projected checkpoint',
        change: acks => ({ acks, head: '3', projected: '2' }),
        error: /head_seq <= projected_seq/,
      },
      {
        name: 'noncanonical head checkpoint',
        change: acks => ({ acks, head: '03', projected: '3' }),
        error: /without leading zeroes/,
      },
      {
        name: 'noncanonical projected checkpoint',
        change: acks => ({ acks, head: '2', projected: '02' }),
        error: /without leading zeroes/,
      },
    ];

    for (const scenario of invalidSequenceScenarios) {
      it(`rejects a 200 with ${scenario.name} before any acknowledgment state changes`, async () => {
        seedFrozenAckState();
        const before = ackDurabilityState();
        const impl = (async (_input: any, init?: any) => {
          const parsed = JSON.parse(String(init?.body));
          const base = parsed.ops.map((op: any, index: number) => canonicalAck(op, index + 1));
          const changed = scenario.change(base);
          return canonicalSuccess(changed.acks, changed.head, undefined, changed.projected);
        }) as typeof fetch;

        const sync = makeCloudSync(impl, {}, { backoffInitialMs: 600_000 });
        const seenHeads: string[] = [];
        sync.setHeadSeqListener(head => seenHeads.push(head));
        await sync.flush();

        expect(sync.status().lastError).toMatch(scenario.error);
        expect(ackDurabilityState()).toEqual(before);
        expect(seenHeads).toEqual([]);
        sync.stop();
      });
    }

    it('preserves a mutation outbox entry when its own 200 ack has a wrong hash', async () => {
      store.createSDKSession('bad-mutation-ack', 'proj-x', 'prompt', 'title', 'claude');
      let atResponse: unknown;
      const impl = (async (_input: any, init?: any) => {
        const parsed = JSON.parse(String(init?.body));
        atResponse = ackDurabilityState();
        const ack = canonicalAck(parsed.ops[0], 1);
        return canonicalSuccess([{ ...ack, operation_sha256: 'A'.repeat(43) }], 1);
      }) as typeof fetch;
      const sync = makeCloudSync(impl, {}, { backoffInitialMs: 600_000 });
      const seenHeads: string[] = [];
      sync.setHeadSeqListener(head => seenHeads.push(head));

      await sync.flush();

      expect(sync.status().lastError).toMatch(/extra or mismatched/);
      expect(ackDurabilityState()).toEqual(atResponse);
      expect(outboxRows()).toHaveLength(1);
      expect(seenHeads).toEqual([]);
      sync.stop();
    });

    it('accepts identical sent tuple multiplicity only when every duplicate ack owns the same seq', () => {
      const op = buildContentOperation({
        kind: 'observation', originDeviceId: 'device-fixture', originLocalId: '1', entityRev: '1',
        payload: observationPayload('same tuple'),
      });
      const ack = canonicalAck(op, 7);
      const sync = makeCloudSync(makeFetchMock().impl);
      const validate = (sync as unknown as {
        validatePushResponse: (response: any, pushed: any[]) => void;
      }).validatePushResponse.bind(sync);

      expect(() => validate({ acked: [ack, { ...ack }], head_seq: '7', projected_seq: '7' }, [op, op]))
        .not.toThrow();
      expect(() => validate({
        acked: [ack, { ...ack, seq: '8' }], head_seq: '8', projected_seq: '8',
      }, [op, op])).toThrow(/duplicate operation tuple claimed different sequences/);
    });

    it('stamps correctly when acks come back reordered', async () => {
      seedObservation({ title: 'a' });
      seedObservation({ title: 'b' });
      seedObservation({ title: 'c' });

      let seq = 0;
      const impl = (async (_input: any, init?: any) => {
        const parsed = JSON.parse(String(init?.body));
        const acked = (parsed.ops as any[]).map((op) => canonicalAck(op, ++seq)).reverse();
        return canonicalSuccess(acked, seq);
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
      const acked = (parsed.ops as any[]).map((op) => canonicalAck(op, ++seq));
      return canonicalSuccess(acked, seq);
    }) as typeof fetch;

    const sync = makeCloudSync(impl);
    const flushPromise = sync.flush();
    for (let i = 0; i < 100 && bodies.length === 0; i++) await sleep(2);
    expect(bodies.length).toBe(1);
    expect(JSON.parse(bodies[0].ops[0].body).entity_rev).toBe('1');
    expect(JSON.parse(bodies[0].ops[0].body).payload.memory_session_id).toBeNull(); // unregistered at SELECT time

    // The memory id lands now — the REAL mutation site: bumps sync_rev to 2,
    // re-nulls synced_at (already NULL), and enqueues set_prompt_session@2.
    store.updateMemorySessionId(2, 'mem-late');

    release();
    await flushPromise;

    // The rev-1 ack must NOT stamp the now-rev-2 row; the same flush loop
    // re-pushes it with the registered mapping at rev 2 and stamps that.
    const rowPushes = bodies.filter(b => b.ops.some((o: any) => JSON.parse(o.body).kind === 'prompt'));
    expect(rowPushes.length).toBe(2);
    const second = rowPushes[1].ops.find((o: any) => JSON.parse(o.body).kind === 'prompt');
    const secondBody = JSON.parse(second.body);
    expect(secondBody.entity_rev).toBe('2');
    expect(secondBody.payload.memory_session_id).toBe('mem-late');
    expect(secondBody.payload.project).toBe('proj-late');
    expect(pendingCount('user_prompts')).toBe(0);
  });

  it('reports head_seq to the registered listener after every successful push', async () => {
    seedObservation();
    seedSummary();

    const { impl } = makeFetchMock();
    const sync = makeCloudSync(impl);
    const seen: string[] = [];
    sync.setHeadSeqListener(seq => seen.push(seq));

    await sync.flush();
    expect(seen.length).toBe(2); // one per POST (observation page, summary page)
    expect(seen[seen.length - 1]).toBe('2');
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
    it('uses the settings-configured device id without rewriting settings', () => {
      const { impl } = makeFetchMock();
      const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'settings-dev-9' });
      expect(sync.status().deviceId).toBe('settings-dev-9');
      expect(existsSync(settingsPath)).toBe(false);
    });

    it('mints a UUID and persists it when settings have no device id', () => {
      const { impl } = makeFetchMock();
      const sync = makeCloudSync(impl, { CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '' });

      const deviceId = sync.status().deviceId;
      expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID).toBe(deviceId);
    });
  });

  describe('sync-mode piggyback (kill switch, plan Phase 5 task 2)', () => {
    /** Hub that acks properly AND stamps X-Sync-Mode when `mode` is set. */
    function makeModeFetch(mode: string | null) {
      let seq = 0;
      const impl = (async (_input: any, init?: any) => {
        const parsed = JSON.parse(String(init?.body ?? '{}'));
        const acked = (parsed.ops ?? []).map((op: any) => canonicalAck(op, ++seq));
        const headers: Record<string, string> = {};
        if (mode !== null) headers['X-Sync-Mode'] = mode;
        return canonicalSuccess(acked, seq, headers);
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
