import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, type CloudSyncOptions, type CloudSyncSettingKeys } from '../../../src/services/sync/CloudSync.js';
import { buildContentOperation, sha256Base64Url, type CanonicalContentBody, type CanonicalMutation, type CanonicalWireOp } from '../../../src/services/sync/CanonicalContent.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';

const ISO = '2026-07-09T00:00:00.000Z';
const EPOCH = Date.parse(ISO);
const DEVICE = 'device-fixture';
const KINDS = ['observation', 'summary', 'prompt', 'work_state'];
type Page = { raw: string; ops: CanonicalWireOp[]; bodies: CanonicalContentBody[] };

/** A protocol-v2 hub: every accepted tuple is acknowledged exactly as sent. */
function hub(onPage?: (page: Page, index: number) => Promise<Response | void> | Response | void) {
  const pages: Page[] = [];
  let seq = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/sync/status')) {
      return Response.json({ protocol_version: 2, epoch: '1', head_seq: String(seq), projected_seq: String(seq), content_kinds: KINDS });
    }
    const raw = String(init?.body);
    const { ops } = JSON.parse(raw) as { ops: CanonicalWireOp[] };
    const page = { raw, ops, bodies: ops.map(op => JSON.parse(op.body) as CanonicalContentBody) };
    pages.push(page);
    const response = await onPage?.(page, pages.length - 1);
    if (response) return response;
    return Response.json({
      acked: ops.map((op, index) => ({
        id: page.bodies[index].id,
        kind: page.bodies[index].kind,
        origin_local_id: page.bodies[index].origin_local_id,
        entity_rev: page.bodies[index].entity_rev,
        operation_sha256: op.operation_sha256,
        seq: String(++seq),
      })),
      head_seq: String(seq), projected_seq: String(seq),
    });
  }) as typeof fetch;
  return { fetchImpl, pages };
}

describe('CloudSync page fairness', () => {
  let db: Database;
  let store: SessionStore;
  let dir: string;
  let observationNumber: number;
  const syncs: CloudSync[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-sync-fairness-'));
    db = new Database(':memory:');
    store = new SessionStore(db);
    observationNumber = 0;
    db.prepare(`INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('session', 'memory', 'project', ?, ?, 'active')`).run(ISO, EPOCH);
  });

  afterEach(() => {
    syncs.forEach(sync => sync.stop());
    syncs.length = 0;
    db.close();
    rmSync(dir, { force: true, recursive: true });
  });

  function syncFor(fetchImpl: typeof fetch, overrides: Partial<CloudSyncOptions> = {}, settings: Partial<CloudSyncSettingKeys> = {}) {
    const sync = new CloudSync(db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'fixture-token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'fixture-user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://fixture.invalid',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEVICE,
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'fixture',
      ...settings,
    }, {
      fetchImpl, settingsPath: join(dir, 'settings.json'), contentBatchSize: 2,
      backoffInitialMs: 600_000, backoffMaxMs: 600_000, ...overrides,
    });
    syncs.push(sync);
    return sync;
  }

  function observation(title = `observation-${++observationNumber}`): number {
    return store.storeObservation('memory', 'project', {
      type: 'discovery', title, subtitle: null, facts: [], narrative: 'body',
      concepts: [], files_read: [], files_modified: [],
    }, 1, 0).id;
  }

  function otherKinds() {
    db.prepare(`INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed, next_steps,
       notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES ('memory', 'project', 'request', 'investigated', 'learned', 'completed',
              'next', NULL, 1, 0, ?, ?)`).run(ISO, EPOCH);
    db.prepare(`INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (1, 'session', 1, 'prompt', ?, ?)`).run(ISO, EPOCH);
    store.appendWorkStateEntry({ project: 'project', listName: 'release', fields: { task: 'publish', status: 'todo' }, createdAtEpoch: EPOCH });
  }

  function freezeObservation(id: number, project = 'project', memory = 'memory'): CanonicalWireOp {
    // The native row still exists: otherwise the correct acknowledgement
    // reconciliation queues a tombstone for an already-deleted local row.
    db.prepare(`INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')`).run(`session-${memory}`, memory, project, ISO, EPOCH);
    db.prepare(`INSERT INTO observations
      (id, memory_session_id, project, type, title, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, 'discovery', ?, '[]', 'body', '[]', '[]', '[]', 1, 0, ?, ?)`)
      .run(id, memory, project, `frozen-${id}`, ISO, EPOCH);
    const op = buildContentOperation({
      kind: 'observation', originDeviceId: DEVICE, originLocalId: String(id), entityRev: '1',
      payload: {
        memory_session_id: memory, project, text: null, type: 'discovery',
        title: `frozen-${id}`, subtitle: null, facts: [], narrative: 'body', concepts: [],
        files_read: [], files_modified: [], prompt_number: '1', discovery_tokens: '0',
        content_hash: null, generated_by_model: null, agent_type: null, agent_id: null,
        metadata: null, merged_into_project: null, created_at: ISO, created_at_epoch: String(EPOCH),
      },
    });
    freeze(op);
    return op;
  }

  function freeze(op: CanonicalWireOp): void {
    const body = JSON.parse(op.body) as CanonicalContentBody;
    db.prepare(`INSERT INTO sync_content_outbox
      (entity_id, kind, origin_local_id, entity_rev, body, operation_sha256, deleted, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(body.id, body.kind, body.origin_local_id,
      body.entity_rev, op.body, op.operation_sha256, Number(body.deleted), EPOCH);
  }

  function assertFirstRotation(pages: Page[]): void {
    const contentPages = pages.filter(page => page.bodies[0].kind !== 'mutation');
    for (const kind of KINDS) {
      const firstPage = contentPages.findIndex(page => page.bodies.some(body => body.kind === kind));
      expect(firstPage).toBeGreaterThanOrEqual(0);
      expect(firstPage).toBeLessThan(4);
    }
    expect(pages.every(page => page.ops.length <= 2)).toBe(true);
  }

  function mutation(number: number, body: CanonicalMutation, rev = '1'): void {
    db.prepare('INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch) VALUES (?, ?, ?, ?)')
      .run(`00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, rev, JSON.stringify(body), EPOCH);
  }

  function replica(ops: CanonicalWireOp[]): unknown {
    const replicaDb = new Database(':memory:');
    try {
      new SessionStore(replicaDb);
      const result = new SyncApply(replicaDb, { deviceId: 'receiver', now: () => EPOCH })
        .applyOps(decodeChanges(ops.map((op, index) => ({ ...op, seq: String(index + 1) }))), { epoch: '1' });
      expect(result.quarantined).toBe(0);
      return {
        sessions: replicaDb.query('SELECT memory_session_id, project, custom_title FROM sdk_sessions ORDER BY memory_session_id').all(),
        observations: replicaDb.query('SELECT origin_local_id, project, merged_into_project, sync_rev FROM observations ORDER BY origin_local_id').all(),
        summaries: replicaDb.query('SELECT origin_local_id, project, merged_into_project, sync_rev FROM session_summaries ORDER BY origin_local_id').all(),
        prompts: replicaDb.query(`SELECT up.origin_local_id, up.sync_rev, s.memory_session_id
          FROM user_prompts up LEFT JOIN sdk_sessions s ON up.session_db_id = s.id ORDER BY up.origin_local_id`).all(),
        work: replicaDb.query('SELECT origin_local_id, project, list_name, fields, sync_rev FROM work_state_entries ORDER BY origin_local_id').all(),
      };
    } finally { replicaDb.close(); }
  }

  it('serves new kinds within one rotation despite a dense frozen observation backlog, retaining frozen bytes', async () => {
    const frozen = Array.from({ length: 32 }, (_, index) => freezeObservation(1_000 + index));
    otherKinds();
    const endpoint = hub();
    const sync = syncFor(endpoint.fetchImpl);
    sync.queueDelete('observation', '2000', ISO);

    await sync.flush();

    assertFirstRotation(endpoint.pages);
    expect(endpoint.pages.find(page => page.bodies[0].kind === 'observation')?.bodies[0].deleted).toBe(true);
    const sent = endpoint.pages.flatMap(page => page.ops);
    for (const op of frozen) expect(sent.filter(candidate => candidate.operation_sha256 === op.operation_sha256)).toEqual([op]);
    expect(db.query('SELECT COUNT(*) AS n FROM sync_content_outbox').get()).toEqual({ n: 0 });
    expect(sync.status().lastError).toBeNull();
  });

  it('serves every eligible kind and a delete while observation writes continue on each observation page', async () => {
    const ids = Array.from({ length: 24 }, (_, index) => observation(`initial-${index}`));
    otherKinds();
    let producedPages = 0;
    let sync!: CloudSync;
    const endpoint = hub(page => {
      if (page.bodies.some(body => body.kind === 'observation') && producedPages++ < 12) {
        if (producedPages === 1) sync.queueDelete('observation', String(ids.at(-1)), ISO);
        observation(`during-${producedPages}-a`);
        observation(`during-${producedPages}-b`);
      }
    });
    sync = syncFor(endpoint.fetchImpl);
    sync.queueDelete('observation', '2000', ISO);

    await sync.flush();

    assertFirstRotation(endpoint.pages);
    expect(endpoint.pages[0].bodies.some(body => body.deleted)).toBe(true);
    const arrivingDeletePage = endpoint.pages.findIndex(page => page.bodies.some(body => body.deleted && body.origin_local_id === String(ids.at(-1))));
    expect(arrivingDeletePage).toBeGreaterThan(0);
    expect(arrivingDeletePage).toBeLessThanOrEqual(4);
    expect(producedPages).toBeGreaterThan(12);
    expect(sync.status().pending).toMatchObject({ observations: 0, summaries: 0, prompts: 0, workState: 0, tombstones: 0 });
  });

  it('holds reserved native and frozen work state by default while ordinary work state progresses', async () => {
    const reserved = store.appendWorkStateEntry({ project: 'project', listName: '__my_work_v1:request', fields: { task: 'held' }, createdAtEpoch: EPOCH });
    const held = buildContentOperation({
      kind: 'work_state', originDeviceId: DEVICE, originLocalId: String(reserved), entityRev: '1',
      payload: { project: 'project', list_name: '__my_work_v1:request', fields: { task: 'held' }, created_at: ISO, created_at_epoch: String(EPOCH) },
    });
    freeze(held);
    otherKinds();
    const endpoint = hub();
    const sync = syncFor(endpoint.fetchImpl);

    await sync.flush();

    const workState = endpoint.pages.flatMap(page => page.bodies).filter(body => body.kind === 'work_state');
    expect(workState.map(body => body.payload?.list_name)).toEqual(['release']);
    expect(db.query('SELECT body, operation_sha256 FROM sync_content_outbox').all()).toEqual([held]);
    expect(db.query('SELECT synced_at FROM work_state_entries WHERE id = ?').get(reserved)).toEqual({ synced_at: null });
    expect(sync.status().lastError).toBeNull();
  });

  it('does not make a title prerequisite wait for unrelated frozen observations', async () => {
    const frozen = Array.from({ length: 12 }, (_, index) => freezeObservation(1_000 + index, 'elsewhere', 'other-memory'));
    mutation(1, { op: 'set_title', target: { memory_session_id: 'memory' }, fields: { custom_title: 'title prerequisite' } });
    const id = observation('title dependent');
    otherKinds();
    const endpoint = hub();
    const sync = syncFor(endpoint.fetchImpl);
    await sync.flush();
    const bodies = endpoint.pages.flatMap(page => page.bodies);
    const titleIndex = bodies.findIndex(body => body.kind === 'mutation');
    expect(titleIndex).toBeLessThan(bodies.findIndex(body => body.origin_local_id === '1011'));
    expect(titleIndex).toBeLessThan(bodies.findIndex(body => body.kind === 'observation' && body.origin_local_id === String(id)));
    for (const op of frozen) expect(endpoint.pages.flatMap(page => page.ops)).toContainEqual(op);
    assertFirstRotation(endpoint.pages);
    expect(sync.status().lastError).toBeNull();
  });

  it('waits only for the targeted frozen prompt before its session repair, retaining mutation FIFO', async () => {
    Array.from({ length: 12 }, (_, index) => freezeObservation(1_000 + index, 'elsewhere', 'other-memory'));
    db.prepare(`INSERT INTO user_prompts
      (id, session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, sync_rev)
      VALUES (10, 1, 'early-session', 1, 'early prompt', ?, ?, '2')`).run(ISO, EPOCH);
    const old = buildContentOperation({
      kind: 'prompt', originDeviceId: DEVICE, originLocalId: '10', entityRev: '1',
      payload: { content_session_id: 'early-session', prompt_number: '1', prompt_text: 'early prompt',
        created_at: ISO, created_at_epoch: String(EPOCH), memory_session_id: null, project: 'unknown', platform_source: null },
    });
    freeze(old);
    mutation(1, { op: 'set_prompt_session', target: { origin_device_id: null, origin_local_id: '10' }, fields: { memory_session_id: 'memory', project: 'project' } }, '2');
    mutation(2, { op: 'set_title', target: { memory_session_id: 'memory' }, fields: { custom_title: 'after repair' } });
    otherKinds();
    const endpoint = hub();
    const sync = syncFor(endpoint.fetchImpl);
    await sync.flush();
    expect(sync.status().lastError).toBeNull();
    const ops = endpoint.pages.flatMap(page => page.ops);
    const bodies = ops.map(op => JSON.parse(op.body) as CanonicalContentBody);
    const oldIndex = ops.findIndex(op => op.operation_sha256 === old.operation_sha256);
    const repairIndex = bodies.findIndex(body => body.mutation?.op === 'set_prompt_session');
    const titleIndex = bodies.findIndex(body => body.mutation?.op === 'set_title');
    const currentIndex = bodies.findIndex(body => body.kind === 'prompt' && body.origin_local_id === '10' && body.entity_rev === '2');
    const mutations = ops.filter((_, index) => bodies[index].kind === 'mutation');
    const rest = ops.filter((op, index) => bodies[index].kind !== 'mutation' && op.operation_sha256 !== old.operation_sha256);
    expect(replica(ops)).toEqual(replica([old, ...mutations, ...rest]));
    expect(oldIndex).toBeLessThan(repairIndex);
    expect(repairIndex).toBeLessThan(titleIndex);
    expect(titleIndex).toBeLessThan(currentIndex);
    expect(titleIndex).toBeLessThan(bodies.findIndex(body => body.origin_local_id === '1011'));
  });

  it('lets unrelated kinds advance while a remap waits for matching old snapshots, matching sequential replay', async () => {
    const unrelated = Array.from({ length: 12 }, (_, index) => freezeObservation(1_000 + index, 'unrelated', 'other-memory'));
    const matching = Array.from({ length: 6 }, (_, index) => freezeObservation(2_000 + index, 'old', 'remapped-memory'));
    db.prepare("UPDATE observations SET project = 'new', sync_rev = '2' WHERE project = 'old'").run();
    mutation(1, { op: 'remap_project', where: { project: 'old', merged_into_project_is_null: true }, fields: { project: 'new' } }, '2');
    mutation(2, { op: 'set_title', target: { memory_session_id: 'remapped-memory' }, fields: { custom_title: 'after remap' } });
    otherKinds();
    const blocked: Array<NonNullable<ReturnType<CloudSync['status']>['queue']['blockedMutation']>> = [];
    let sync!: CloudSync;
    const endpoint = hub(() => {
      const blockage = sync.status().queue.blockedMutation;
      if (blockage) blocked.push(blockage);
    });
    sync = syncFor(endpoint.fetchImpl);
    await sync.flush();
    expect(sync.status().lastError).toBeNull();
    const ops = endpoint.pages.flatMap(page => page.ops);
    const bodies = ops.map(op => JSON.parse(op.body) as CanonicalContentBody);
    const remapIndex = bodies.findIndex(body => body.mutation?.op === 'remap_project');
    const titleIndex = bodies.findIndex(body => body.mutation?.op === 'set_title');
    const oldHashes = new Set(matching.map(op => op.operation_sha256));
    const mutations = ops.filter((_, index) => bodies[index].kind === 'mutation');
    const frozenHashes = new Set([...oldHashes, ...unrelated.map(op => op.operation_sha256)]);
    const fresh = ops.filter((op, index) => !frozenHashes.has(op.operation_sha256) && bodies[index].kind !== 'mutation');
    expect(replica(ops)).toEqual(replica([...unrelated, ...matching, ...mutations, ...fresh]));
    for (const old of matching) expect(ops.findIndex(op => op.operation_sha256 === old.operation_sha256)).toBeLessThan(remapIndex);
    for (const [index, body] of bodies.entries()) {
      if (body.kind === 'observation' && body.payload?.project === 'new') expect(index).toBeGreaterThan(titleIndex);
    }
    expect(titleIndex).toBeGreaterThan(remapIndex);
    expect(bodies.findIndex(body => body.kind === 'prompt')).toBeLessThan(remapIndex);
    expect(bodies.findIndex(body => body.kind === 'work_state')).toBeLessThan(remapIndex);
    assertFirstRotation(endpoint.pages);
    expect(blocked[0]).toMatchObject({ op: 'remap_project', pendingPrerequisites: 6, oldestPrerequisiteQueuedAt: EPOCH, queuedAt: EPOCH, observedAt: expect.any(Number) });
    expect(sync.status().queue.blockedMutation).toBeNull();
  });

  it('preserves older related prompts before a session project remap and matches sequential replay', async () => {
    const unrelated = Array.from({ length: 8 }, (_, index) => freezeObservation(1_000 + index, 'unrelated', 'other-memory'));
    const oldObservation = freezeObservation(2_000, 'old', 'memory');
    db.prepare("UPDATE sdk_sessions SET project = 'new' WHERE memory_session_id = 'memory'").run();
    db.prepare("UPDATE observations SET project = 'new', sync_rev = '2' WHERE id = 2000").run();
    db.prepare(`INSERT INTO user_prompts
      (id, session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (10, 1, 'session', 1, 'old session prompt', ?, ?)`).run(ISO, EPOCH);
    const oldPrompt = buildContentOperation({
      kind: 'prompt', originDeviceId: DEVICE, originLocalId: '10', entityRev: '1',
      payload: { content_session_id: 'session', prompt_number: '1', prompt_text: 'old session prompt',
        created_at: ISO, created_at_epoch: String(EPOCH), memory_session_id: 'memory', project: 'old', platform_source: null },
    });
    freeze(oldPrompt);
    mutation(1, { op: 'remap_project', where: { memory_session_id: 'memory' }, fields: { project: 'new' } }, '2');
    otherKinds();
    const endpoint = hub();
    const sync = syncFor(endpoint.fetchImpl);
    await sync.flush();
    expect(sync.status().lastError).toBeNull();
    const ops = endpoint.pages.flatMap(page => page.ops);
    const bodies = ops.map(op => JSON.parse(op.body) as CanonicalContentBody);
    const remapIndex = bodies.findIndex(body => body.kind === 'mutation');
    expect(ops.findIndex(op => op.operation_sha256 === oldObservation.operation_sha256)).toBeLessThan(remapIndex);
    expect(ops.findIndex(op => op.operation_sha256 === oldPrompt.operation_sha256)).toBeLessThan(remapIndex);
    expect(remapIndex).toBeLessThan(bodies.findIndex(body => body.kind === 'prompt' && body.origin_local_id === '10' && body.entity_rev === '2'));
    const frozen = [...unrelated, oldObservation, oldPrompt];
    const frozenHashes = new Set(frozen.map(op => op.operation_sha256));
    const mutations = ops.filter((_, index) => bodies[index].kind === 'mutation');
    const fresh = ops.filter((op, index) => !frozenHashes.has(op.operation_sha256) && bodies[index].kind !== 'mutation');
    expect(replica(ops)).toEqual(replica([...frozen, ...mutations, ...fresh]));
  });

  it('uses at most one injected backfill page per flush after live work, retaining live headroom next flush', async () => {
    const historical = Array.from({ length: 3 }, (_, index) => observation(`history-${index}`));
    db.prepare('UPDATE observations SET synced_at = 1').run();
    otherKinds();
    const selections: Array<{ limit: number; pagesBefore: number; pending: ReturnType<CloudSync['status']>['pending'] }> = [];
    const endpoint = hub();
    let sync!: CloudSync;
    sync = syncFor(endpoint.fetchImpl, {
      selectBackfillPage: limit => {
        selections.push({ limit, pagesBefore: endpoint.pages.length, pending: sync.status().pending });
        return historical.splice(0, limit).map(id => ({ kind: 'observation', originLocalId: String(id) }));
      },
    });
    await sync.flush();
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ limit: 2, pagesBefore: 3, pending: { observations: 0, summaries: 0, prompts: 0, workState: 0 } });
    expect(endpoint.pages.slice(selections[0].pagesBefore).flatMap(page => page.bodies).map(body => body.payload?.title)).toEqual(['history-0', 'history-1']);
    const nextStart = endpoint.pages.length;
    const live = observation('new live observation');
    await sync.flush();
    expect(selections).toHaveLength(2);
    expect(selections[1].pagesBefore).toBe(nextStart + 1);
    expect(endpoint.pages[nextStart].bodies[0]).toMatchObject({ kind: 'observation', origin_local_id: String(live), payload: { title: 'new live observation' } });
    expect(endpoint.pages[selections[1].pagesBefore].bodies[0].payload?.title).toBe('history-2');
    expect(sync.status().queue.backfill).toMatchObject({ configured: true, pageBudget: 2, selected: 3 });
    expect(sync.status().lastError).toBeNull();
  });

  const malformedMutations: Array<{ label: string; value: unknown }> = [
    { label: 'mutation string', value: 'bad-json' },
    ...['target', 'where', 'fields'].map(key => ({
      label: `${key} string`,
      value: key === 'target'
        ? { op: 'set_title', target: 'bad-json', fields: { custom_title: 'invalid target' } }
        : { op: 'remap_project', where: { project: 'project' }, fields: { project: 'bogus' }, [key]: 'bad-json' },
    })),
  ];

  for (const malformed of malformedMutations) {
    it(`quarantines tail ${malformed.label} without poisoning scoped frozen/native selection`, async () => {
      const prerequisites = [freezeObservation(2_000, 'old', 'remapped-memory'), freezeObservation(2_001, 'old', 'remapped-memory')];
      db.prepare("UPDATE observations SET project = 'new', sync_rev = '2' WHERE project = 'old'").run();
      freezeObservation(1_000, 'unrelated', 'other-memory');
      mutation(1, { op: 'remap_project', where: { project: 'old' }, fields: { project: 'new' } }, '2');
      // Valid outer JSON is deliberately not a valid canonical operation.
      // It stays beyond the one-row mutation page while scheduler SQL scans
      // the pending tail to decide which content is safe to send.
      const badCanonical = JSON.stringify({ mutation: malformed.value });
      db.prepare(`INSERT INTO sync_outbox
        (op_uuid, rev, body, canonical_body, operation_sha256, created_at_epoch)
        VALUES (?, '1', ?, ?, ?, ?)`).run('00000000-0000-4000-8000-000000000002',
        JSON.stringify(malformed.value), badCanonical, sha256Base64Url(badCanonical), EPOCH);
      mutation(3, { op: 'set_title', target: { memory_session_id: 'future-session' }, fields: { custom_title: 'valid after malformed tail' } });
      otherKinds();
      const endpoint = hub();
      const sync = syncFor(endpoint.fetchImpl, { contentBatchSize: 1 });

      await sync.flush();

      expect(sync.status().lastError).toBeNull();
      const ops = endpoint.pages.flatMap(page => page.ops);
      const bodies = endpoint.pages.flatMap(page => page.bodies);
      const remapIndex = bodies.findIndex(body => body.mutation?.op === 'remap_project');
      for (const op of prerequisites) expect(ops.findIndex(sent => sent.operation_sha256 === op.operation_sha256)).toBeLessThan(remapIndex);
      for (const kind of ['summary', 'prompt', 'work_state']) {
        const index = bodies.findIndex(body => body.kind === kind);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(remapIndex);
      }
      expect(bodies.filter(body => body.kind === 'mutation').map(body => body.mutation?.op)).toEqual(['remap_project', 'set_title']);
      expect(sync.status().quarantine.count).toBe(1);
      expect(db.query('SELECT COUNT(*) AS n FROM sync_outbox').get()).toEqual({ n: 0 });
      expect(db.query('SELECT COUNT(*) AS n FROM sync_content_outbox').get()).toEqual({ n: 0 });
    });
  }

  it('runs forty title mutations without prerequisite inventory scans', async () => {
    db.transaction(() => {
      for (let index = 0; index < 40; index++) {
        mutation(index + 1, { op: 'set_title', target: { memory_session_id: `title-memory-${index}` }, fields: { custom_title: `title-${index}` } });
      }
    })();
    const endpoint = hub();
    const sync = syncFor(endpoint.fetchImpl, { contentBatchSize: 40 });
    const prepare = spyOn(db, 'prepare');
    try {
      await sync.flush();
      const prerequisiteQueries = prepare.mock.calls.filter(([sql]) =>
        /COUNT\(\*\) AS count,\s*MIN\(o\.created_at_epoch\) AS oldest/.test(String(sql)));
      expect(prerequisiteQueries).toHaveLength(0);
      expect(endpoint.pages.flatMap(page => page.bodies).filter(body => body.mutation?.op === 'set_title')).toHaveLength(40);
      expect(sync.status().lastError).toBeNull();
    } finally { prepare.mockRestore(); }
  });

  it('retains exact frozen wrappers on failure while newly queued kinds wait for the next rotation', async () => {
    const frozen = [freezeObservation(1000), freezeObservation(1001)];
    let reject = true;
    const endpoint = hub(() => reject ? new Response('unavailable', { status: 503 }) : undefined);
    const sync = syncFor(endpoint.fetchImpl);
    await sync.flush();
    expect(endpoint.pages).toHaveLength(1);
    expect(endpoint.pages[0].ops).toEqual(frozen);
    otherKinds();
    reject = false;

    await sync.flush();

    const retried = endpoint.pages.slice(1).find(page => page.bodies[0].kind === 'observation');
    expect(retried?.raw).toBe(endpoint.pages[0].raw);
    assertFirstRotation(endpoint.pages.slice(1));
  });

  it('keeps one flush owner and uploads an in-flight edit at a higher revision', async () => {
    const id = observation('before');
    otherKinds();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstRequest = new Promise<void>(resolve => { entered = resolve; });
    let active = 0;
    let maxActive = 0;
    const endpoint = hub(async (_page, index) => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (index === 0) { entered(); await gate; }
      active--;
    });
    const sync = syncFor(endpoint.fetchImpl);
    const flushing = sync.flush();
    await firstRequest;
    expect(endpoint.pages[0].bodies[0]).toMatchObject({ entity_rev: '1', payload: { title: 'before' } });
    db.prepare('UPDATE observations SET title = ?, synced_at = NULL WHERE id = ?').run('after', id);
    const frozen = db.prepare(
      'SELECT body FROM sync_content_outbox WHERE entity_rev = ?'
    ).get('1') as { body: string };
    expect(JSON.parse(frozen.body).payload.title).toBe('before');
    await sync.flush();
    sync.notify();
    expect(endpoint.pages).toHaveLength(1);
    release();
    await flushing;

    const versions = endpoint.pages.flatMap(page => page.bodies).filter(body => body.kind === 'observation');
    expect(versions.map(body => [body.entity_rev, body.payload?.title])).toEqual([['1', 'before'], ['2', 'after']]);
    expect(maxActive).toBe(1);
    expect(db.query('SELECT sync_rev, synced_at FROM observations WHERE id = ?').get(id)).toMatchObject({ sync_rev: '2', synced_at: expect.any(Number) });
  });

  it('never resurrects an observation deleted during its in-flight snapshot', async () => {
    const id = observation();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstRequest = new Promise<void>(resolve => { entered = resolve; });
    const endpoint = hub(async (_page, index) => { if (index === 0) { entered(); await gate; } });
    const sync = syncFor(endpoint.fetchImpl);
    const flushing = sync.flush();
    await firstRequest;
    expect(sync.queueDelete('observation', String(id), ISO)).toBe('2');
    release();
    await flushing;

    expect(endpoint.pages.flatMap(page => page.bodies).map(body => [body.entity_rev, body.deleted])).toEqual([['1', false], ['2', true]]);
    expect(db.query('SELECT COUNT(*) AS n FROM observations WHERE id = ?').get(id)).toEqual({ n: 0 });
    expect(db.query('SELECT entity_rev, deleted FROM sync_entity_heads').get()).toEqual({ entity_rev: '2', deleted: 1 });
  });

  it('stops after the in-flight response without stamping it or starting another page', async () => {
    for (let index = 0; index < 6; index++) observation();
    otherKinds();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstRequest = new Promise<void>(resolve => { entered = resolve; });
    const endpoint = hub(async () => { entered(); await gate; });
    const sync = syncFor(endpoint.fetchImpl);
    const flushing = sync.flush();
    await firstRequest;
    sync.stop();
    release();
    await flushing;

    expect(endpoint.pages).toHaveLength(1);
    expect(db.query('SELECT COUNT(*) AS n FROM observations WHERE synced_at IS NULL').get()).toEqual({ n: 6 });
    expect(db.query('SELECT COUNT(*) AS n FROM sync_content_outbox').get()).toEqual({ n: 2 });
  });
});
