#!/usr/bin/env bun
// Full-matrix sync e2e (plan Phase 6 task 1) — real SessionStore + CloudSync +
// SyncApply + SyncClient stacks against a real `wrangler dev` sync hub. The
// script starts (and restarts) its own hub on a private port with a private
// --persist-to dir, so it never collides with a dev hub on 8787 and an epoch
// reset is just "wipe the persist dir and restart".
//
// Matrix scenarios (plan: "fresh device bootstrap (since=0), week-offline
// catch-up, concurrent two-device writes, all four mutation types, epoch
// reset, kill-switch degradation"):
//   1. Row replication A→B: preserved created_at_epoch, origin attribution,
//      echo-guard stamp, FTS row, prompt linking, and the set_title PARK path
//      (in the hub log set_title precedes the session's row ops, so a device
//      that has never seen the session parks the title, then claims it when
//      the stub session materializes — all inside one applied batch).
//   2. set_prompt_session repair: a prompt pushed before its memory id
//      registers is re-linked on replicas by the repair mutation.
//   3. remap_project, BOTH shapes, emitted own-connection (the
//      WorktreeAdoption/ProcessManager shape — pure SQL + sync_outbox):
//      {project, merged_into_project_is_null} → {merged_into_project} and
//      {memory_session_id} → {project} (which also retargets sdk_sessions).
//   4. set_title DIRECT path (the other arrival order): a mutation pushed by
//      a third device targeting a session that ALREADY exists on A and B
//      applies as a direct UPDATE on both.
//   5. Concurrent two-device writes: A and B write + flush simultaneously;
//      both converge to the identical corpus — no echo, no loss, no dupes.
//   6. Week-offline catch-up: B stops pulling while A accumulates >500 ops
//      (more than one /changes page — hub cap 500), then B converges through
//      paginated pulls in one cycle.
//   7. Fresh device bootstrap: a brand-new device C (empty DB, cursor 0)
//      pulls since=0 and converges on the full corpus, titles included.
//   8. Epoch reset: hub storage wiped → fresh DO mints a new epoch → clients
//      detect the mismatch, reset cursors, requeue their NATIVE corpora for
//      re-push (the Phase 3 fix), and all devices reconverge without dupes.
//
// Kill-switch degradation (matrix scenario 9) lives in its own harness —
// scripts/sync-kill-switch-e2e.ts — because tripping the switch requires
// `wrangler kv --local` against the hub's DEFAULT persist dir. Run both:
//   bun scripts/sync-matrix-e2e.ts
//   (cd workers/sync-hub && bunx wrangler dev --var KILL_SWITCH_CACHE_MS:0 &)
//   bun scripts/sync-kill-switch-e2e.ts
//
// Env knobs: MATRIX_PORT (default 8794), MATRIX_KEEP_TMP=1 to keep temp dirs.

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';
import { openConfiguredSqliteDatabase } from '../src/services/sqlite/connection.js';
import { CloudSync } from '../src/services/sync/CloudSync.js';
import { SyncApply } from '../src/services/sync/SyncApply.js';
import { SyncClient } from '../src/services/sync/SyncClient.js';
import { emitRemapProject } from '../src/services/sync/remap-outbox.js';

const HUB_DIR = resolve(import.meta.dir, '../workers/sync-hub');
const PORT = Number(process.env.MATRIX_PORT ?? 8794);
const HUB_URL = `http://127.0.0.1:${PORT}`;
const USER_ID = `matrix-user-${Date.now().toString(36)}`;
const TOKEN = 'matrix-token';
/** >500 forces at least two /changes pages (hub page cap is 500). */
const OFFLINE_OPS = 520;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Hub lifecycle (private port + private persist dir)
// ---------------------------------------------------------------------------
let hubProc: ReturnType<typeof Bun.spawn> | null = null;
let persistDir = '';

function authHeaders(deviceId: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'X-User-Id': USER_ID,
    'X-Device-Id': deviceId,
  };
}

async function startHub(): Promise<void> {
  hubProc = Bun.spawn(
    ['bunx', 'wrangler', 'dev', '--port', String(PORT), '--persist-to', persistDir],
    { cwd: HUB_DIR, stdout: 'ignore', stderr: 'ignore', env: { ...process.env } },
  );
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${HUB_URL}/v1/sync/status`, {
        headers: authHeaders('probe'),
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('wrangler dev did not become ready');
}

async function stopHub(): Promise<void> {
  if (!hubProc) return;
  hubProc.kill(); // SIGTERM — a SIGKILLed workerd can wedge wrangler state
  await hubProc.exited.catch(() => {});
  hubProc = null;
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${HUB_URL}/v1/sync/status`, { headers: authHeaders('probe'), signal: AbortSignal.timeout(500) });
    } catch {
      return; // port refuses connections — actually down
    }
    await sleep(250);
  }
}

interface HubStatus { epoch: string; head_seq: number; op_count: number; device_count: number }
async function hubStatus(): Promise<HubStatus> {
  const res = await fetch(`${HUB_URL}/v1/sync/status`, { headers: authHeaders('probe') });
  if (!res.ok) throw new Error(`hub status ${res.status}`);
  return await res.json() as HubStatus;
}

/** Raw push as an arbitrary device (the synthetic third device of scenario 4). */
async function rawPush(deviceId: string, ops: Array<{ kind: string; origin_id: string; rev: number; body: string }>): Promise<void> {
  const res = await fetch(`${HUB_URL}/v1/sync/ops`, {
    method: 'POST',
    headers: { ...authHeaders(deviceId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ops }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`raw push ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Device harness — the real client stack, deterministic (no started loops)
// ---------------------------------------------------------------------------
interface Device {
  name: string;
  dir: string;
  store: SessionStore;
  search: SessionSearch;
  cloudSync: CloudSync;
  apply: SyncApply;
  client: SyncClient;
}

function makeDevice(name: string): Device {
  const dir = mkdtempSync(join(tmpdir(), `claude-mem-matrix-${name}-`));
  const dbPath = join(dir, 'claude-mem.db');
  const store = new SessionStore(dbPath, {
    cloudSyncStatePath: join(dir, 'no-legacy.json'),
    cloudSyncHubUrl: HUB_URL,
  });
  const search = new SessionSearch(store.db); // FTS tables + triggers
  const cloudSync = new CloudSync(store.db, {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: USER_ID,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: HUB_URL,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: `device-${name}`,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: `matrix-${name}`,
  }, {
    settingsPath: join(dir, 'settings.json'),
    legacyStatePath: join(dir, 'no-legacy.json'),
    debounceMs: 50,
    backoffInitialMs: 100,
    backoffMaxMs: 1000,
    requestTimeoutMs: 15_000,
  });
  const apply = new SyncApply(store.db, { deviceId: `device-${name}` });
  const client = new SyncClient(apply, {
    hubUrl: HUB_URL,
    token: TOKEN,
    userId: USER_ID,
    deviceId: `device-${name}`,
    minPullGapMs: 0,
    requestTimeoutMs: 15_000,
    wsEnabled: false, // deterministic HTTP-lane matrix; the WS lane has its own e2e
  });
  return { name, dir, store, search, cloudSync, apply, client };
}

function destroyDevice(dev: Device): void {
  dev.cloudSync.stop();
  dev.client.stop();
  dev.store.db.close();
  if (process.env.MATRIX_KEEP_TMP !== '1') {
    rmSync(dev.dir, { recursive: true, force: true });
  }
}

function q<T>(dev: Device, sql: string, ...params: unknown[]): T | undefined {
  return dev.store.db.prepare(sql).get(...params as never[]) as T | undefined;
}

function count(dev: Device, sql: string, ...params: unknown[]): number {
  return (q<{ n: number }>(dev, sql, ...params) ?? { n: -1 }).n;
}

function pendingTotal(dev: Device): number {
  const p = dev.cloudSync.status().pending;
  return p.observations + p.summaries + p.prompts + p.mutations;
}

function corpusCounts(dev: Device): { obs: number; sums: number; prompts: number } {
  return {
    obs: count(dev, 'SELECT COUNT(*) AS n FROM observations'),
    sums: count(dev, 'SELECT COUNT(*) AS n FROM session_summaries'),
    prompts: count(dev, 'SELECT COUNT(*) AS n FROM user_prompts'),
  };
}

function makeObs(title: string, narrative: string): Parameters<SessionStore['storeObservation']>[2] {
  return {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative,
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  persistDir = mkdtempSync(join(tmpdir(), 'claude-mem-matrix-hub-'));
  console.log(`Sync matrix e2e — hub ${HUB_URL}, user ${USER_ID}`);
  console.log('[hub] starting wrangler dev...');
  await startHub();
  console.log('[hub] ready');

  const A = makeDevice('a');
  const B = makeDevice('b');
  let C: Device | null = null;

  try {
    // === Scenario 1: row replication + set_title park path =================
    console.log('\nScenario 1: row replication A -> B (epoch, origin, FTS, parked title)');
    const sessA = A.store.createSDKSession('sess-matrix-1', 'proj-matrix', 'hello matrix', 'Matrix Title vA', 'claude');
    A.store.updateMemorySessionId(sessA, 'mem-matrix-1');
    A.store.saveUserPrompt('sess-matrix-1', 1, 'find the flux capacitor', sessA);
    const obsA = A.store.storeObservation('mem-matrix-1', 'proj-matrix', makeObs('Observation from A', 'the zeppelin narrative body'), 1, 7);
    A.store.storeSummary('mem-matrix-1', 'proj-matrix', {
      request: 'summarize matrix', investigated: 'inv', learned: 'lrn',
      completed: 'done', next_steps: 'next', notes: null,
    }, 1);
    await A.cloudSync.flush();
    check('A drain empty after flush', pendingTotal(A) === 0, A.cloudSync.status());

    await B.client.pullOnce({ timeoutMs: 15_000 });
    const obsB = q<{ title: string; created_at_epoch: number; origin_device_id: string; synced_at: number }>(
      B, `SELECT title, created_at_epoch, origin_device_id, synced_at FROM observations WHERE origin_local_id = ?`, String(obsA.id));
    check('observation replicated to B', obsB?.title === 'Observation from A');
    check('created_at_epoch preserved', obsB?.created_at_epoch === obsA.createdAtEpoch, { got: obsB?.created_at_epoch, want: obsA.createdAtEpoch });
    check('origin attribution recorded', obsB?.origin_device_id === 'device-a');
    check('applied row pre-stamped synced_at (echo guard)', obsB?.synced_at != null);
    check('FTS row present on B', count(B, `SELECT COUNT(*) AS n FROM observations_fts WHERE observations_fts MATCH 'zeppelin'`) >= 1);
    check('summary replicated to B', count(B, `SELECT COUNT(*) AS n FROM session_summaries WHERE origin_device_id = 'device-a'`) === 1);
    const promptB = q<{ session_db_id: number | null }>(B, `SELECT session_db_id FROM user_prompts WHERE prompt_text = 'find the flux capacitor'`);
    check('prompt replicated + linked on B', promptB?.session_db_id != null);
    const titleB = q<{ custom_title: string | null }>(B, `SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-matrix-1'`);
    check('set_title converged via park->claim (log order: title before rows)', titleB?.custom_title === 'Matrix Title vA', titleB);

    // === Scenario 2: set_prompt_session repair =============================
    console.log('\nScenario 2: set_prompt_session repair');
    const sess2 = A.store.createSDKSession('sess-matrix-2', 'proj-matrix', 'second session');
    A.store.saveUserPrompt('sess-matrix-2', 1, 'early unlinked prompt', sess2);
    await A.cloudSync.flush(); // prompt travels with NULL join fields
    A.store.updateMemorySessionId(sess2, 'mem-matrix-2'); // emits the repair op
    await A.cloudSync.flush();
    await B.client.pullOnce({ timeoutMs: 15_000 });
    const repaired = q<{ session_db_id: number | null }>(B, `SELECT session_db_id FROM user_prompts WHERE prompt_text = 'early unlinked prompt'`);
    const repairedSession = repaired?.session_db_id != null
      ? q<{ memory_session_id: string | null }>(B, `SELECT memory_session_id FROM sdk_sessions WHERE id = ?`, repaired.session_db_id)
      : undefined;
    check('repair re-linked the replica prompt to mem-matrix-2', repairedSession?.memory_session_id === 'mem-matrix-2', repaired);

    // === Scenario 3: remap_project, both shapes, own-connection ============
    console.log('\nScenario 3: remap_project (worktree shape + cwd shape)');
    // Worktree-adoption shape: separate connection to A's DB, inside a tx.
    let ownConn = openConfiguredSqliteDatabase(join(A.dir, 'claude-mem.db'));
    try {
      ownConn.transaction(() => {
        emitRemapProject(ownConn, { project: 'proj-matrix', merged_into_project_is_null: true }, { merged_into_project: 'proj-parent' });
      })();
    } finally {
      ownConn.close();
    }
    await A.cloudSync.flush(); // the startup-drain pickup of the outbox
    await B.client.pullOnce({ timeoutMs: 15_000 });
    check('worktree-shape remap converged on B (merged_into_project)',
      count(B, `SELECT COUNT(*) AS n FROM observations WHERE merged_into_project = 'proj-parent'`) >= 1);

    // Cwd-remap shape: {memory_session_id} -> {project}; also retargets the
    // owning sdk_sessions row on apply.
    ownConn = openConfiguredSqliteDatabase(join(A.dir, 'claude-mem.db'));
    try {
      ownConn.transaction(() => {
        emitRemapProject(ownConn, { memory_session_id: 'mem-matrix-1' }, { project: 'proj-moved' });
      })();
    } finally {
      ownConn.close();
    }
    await A.cloudSync.flush();
    await B.client.pullOnce({ timeoutMs: 15_000 });
    check('cwd-shape remap converged on B (observations.project)',
      count(B, `SELECT COUNT(*) AS n FROM observations WHERE memory_session_id = 'mem-matrix-1' AND project = 'proj-moved'`) >= 1);
    const remappedSession = q<{ project: string }>(B, `SELECT project FROM sdk_sessions WHERE memory_session_id = 'mem-matrix-1'`);
    check('cwd-shape remap retargeted the session row on B', remappedSession?.project === 'proj-moved', remappedSession);

    // === Scenario 4: set_title direct path (the other order) ===============
    console.log('\nScenario 4: set_title direct path (session already exists on both)');
    await rawPush('device-x', [{
      kind: 'mutation',
      origin_id: crypto.randomUUID(),
      rev: 1,
      body: JSON.stringify({
        op: 'set_title',
        target: { memory_session_id: 'mem-matrix-1' },
        fields: { custom_title: 'Retitled by X' },
      }),
    }]);
    await A.client.pullOnce({ timeoutMs: 15_000 });
    await B.client.pullOnce({ timeoutMs: 15_000 });
    check('direct set_title applied on A',
      q<{ custom_title: string }>(A, `SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-matrix-1'`)?.custom_title === 'Retitled by X');
    check('direct set_title applied on B',
      q<{ custom_title: string }>(B, `SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-matrix-1'`)?.custom_title === 'Retitled by X');

    // === Scenario 5: concurrent two-device writes ==========================
    console.log('\nScenario 5: concurrent two-device writes (30 + 30, overlapping flushes)');
    const sessCA = A.store.createSDKSession('sess-conc-a', 'proj-conc', 'conc a');
    A.store.updateMemorySessionId(sessCA, 'mem-conc-a');
    const sessCB = B.store.createSDKSession('sess-conc-b', 'proj-conc', 'conc b');
    B.store.updateMemorySessionId(sessCB, 'mem-conc-b');
    await Promise.all([A.cloudSync.flush(), B.cloudSync.flush()]); // session bootstrap ops
    const writer = async (dev: Device, memId: string, prefix: string): Promise<void> => {
      for (let i = 0; i < 30; i++) {
        dev.store.storeObservation(memId, 'proj-conc', makeObs(`${prefix}-${i}`, `${prefix} narrative ${i}`), 1, 0);
        if (i % 5 === 4) {
          await Promise.all([dev.cloudSync.flush(), sleep(10)]); // overlap pushes
        }
      }
      await dev.cloudSync.flush();
    };
    await Promise.all([writer(A, 'mem-conc-a', 'conc-a'), writer(B, 'mem-conc-b', 'conc-b')]);
    await A.client.pullOnce({ timeoutMs: 15_000 });
    await B.client.pullOnce({ timeoutMs: 15_000 });
    const concCountA = count(A, `SELECT COUNT(*) AS n FROM observations WHERE project = 'proj-conc'`);
    const concCountB = count(B, `SELECT COUNT(*) AS n FROM observations WHERE project = 'proj-conc'`);
    check('A holds all 60 concurrent rows exactly once', concCountA === 60, { concCountA });
    check('B holds all 60 concurrent rows exactly once', concCountB === 60, { concCountB });
    const distinctA = count(A, `SELECT COUNT(DISTINCT title) AS n FROM observations WHERE project = 'proj-conc'`);
    const distinctB = count(B, `SELECT COUNT(DISTINCT title) AS n FROM observations WHERE project = 'proj-conc'`);
    check('no loss, no dupes (60 distinct titles on both)', distinctA === 60 && distinctB === 60, { distinctA, distinctB });
    const opsBeforeEcho = (await hubStatus()).op_count;
    await Promise.all([A.cloudSync.flush(), B.cloudSync.flush()]);
    const opsAfterEcho = (await hubStatus()).op_count;
    check('no echo: hub op_count stable after both re-flush', opsBeforeEcho === opsAfterEcho, { opsBeforeEcho, opsAfterEcho });

    // === Scenario 6: week-offline catch-up (pagination) ====================
    console.log(`\nScenario 6: week-offline catch-up (B dark while A writes ${OFFLINE_OPS} ops)`);
    const sessBulk = A.store.createSDKSession('sess-bulk', 'proj-bulk', 'bulk');
    A.store.updateMemorySessionId(sessBulk, 'mem-bulk');
    for (let i = 0; i < OFFLINE_OPS; i++) {
      A.store.storeObservation('mem-bulk', 'proj-bulk', makeObs(`bulk-${i}`, `offline backlog item ${i}`), 1, 0);
    }
    await A.cloudSync.flush();
    check('A drained the backlog', pendingTotal(A) === 0, A.cloudSync.status());
    const cursorBefore = B.apply.getCursor();
    const headBefore = (await hubStatus()).head_seq;
    check(`B is >500 ops behind (multiple /changes pages)`, headBefore - cursorBefore > 500, { headBefore, cursorBefore });
    await B.client.pullOnce({ timeoutMs: 60_000 });
    check('B converged on the full backlog', count(B, `SELECT COUNT(*) AS n FROM observations WHERE project = 'proj-bulk'`) === OFFLINE_OPS);
    check('B cursor reached hub head', B.apply.getCursor() === headBefore, { cursor: B.apply.getCursor(), headBefore });

    // === Scenario 7: fresh device bootstrap (since=0) ======================
    console.log('\nScenario 7: fresh device bootstrap (empty DB, since=0)');
    C = makeDevice('c');
    check('C starts at cursor 0', C.apply.getCursor() === 0);
    await C.client.pullOnce({ timeoutMs: 60_000 });
    const bCounts = corpusCounts(B);
    const cCounts = corpusCounts(C);
    check('C converged on the full corpus (matches B)',
      cCounts.obs === bCounts.obs && cCounts.sums === bCounts.sums && cCounts.prompts === bCounts.prompts,
      { cCounts, bCounts });
    check('C sees the final title (full-log replay: park, claim, then overwrite)',
      q<{ custom_title: string }>(C, `SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-matrix-1'`)?.custom_title === 'Retitled by X');
    check('C sees the remap state',
      count(C, `SELECT COUNT(*) AS n FROM observations WHERE merged_into_project = 'proj-parent'`) >= 1
      && q<{ project: string }>(C, `SELECT project FROM sdk_sessions WHERE memory_session_id = 'mem-matrix-1'`)?.project === 'proj-moved');
    check('C adopted the hub epoch', C.apply.getEpoch() === (await hubStatus()).epoch);
    check('C pushed nothing (pure replica)', pendingTotal(C) === 0, C.cloudSync.status());

    // === Scenario 8: epoch reset ==========================================
    console.log('\nScenario 8: epoch reset (hub storage wiped -> reconverge, no dupes)');
    const epoch1 = (await hubStatus()).epoch;
    const before = { a: corpusCounts(A), b: corpusCounts(B), c: corpusCounts(C) };
    const nativeA = count(A, 'SELECT COUNT(*) AS n FROM observations WHERE origin_device_id IS NULL')
      + count(A, 'SELECT COUNT(*) AS n FROM session_summaries WHERE origin_device_id IS NULL')
      + count(A, 'SELECT COUNT(*) AS n FROM user_prompts WHERE origin_device_id IS NULL');

    await stopHub();
    rmSync(persistDir, { recursive: true, force: true });
    console.log('[hub] state wiped; restarting...');
    await startHub();
    const epoch2 = (await hubStatus()).epoch;
    check('fresh DO storage minted a new epoch', epoch2 !== epoch1 && epoch2.length > 0, { epoch1, epoch2 });

    await A.client.pullOnce({ timeoutMs: 15_000 });
    check('A adopted the new epoch', A.apply.getEpoch() === epoch2);
    const requeuedA = pendingTotal(A);
    check('A requeued its native corpus for re-push (the Phase 3 fix)', requeuedA === nativeA && requeuedA > 0, { requeuedA, nativeA });
    await A.cloudSync.flush();

    await B.client.pullOnce({ timeoutMs: 60_000 });
    check('B adopted the new epoch', B.apply.getEpoch() === epoch2);
    check('B requeued its native corpus', pendingTotal(B) > 0, B.cloudSync.status());
    await B.cloudSync.flush();

    await C.client.pullOnce({ timeoutMs: 60_000 });
    check('C requeued nothing (no native rows)', pendingTotal(C) === 0, C.cloudSync.status());

    // Settle: everyone pulls everyone's re-pushed corpus.
    await A.client.pullOnce({ timeoutMs: 60_000 });
    await B.client.pullOnce({ timeoutMs: 60_000 });
    await C.client.pullOnce({ timeoutMs: 60_000 });

    const after = { a: corpusCounts(A), b: corpusCounts(B), c: corpusCounts(C) };
    check('A reconverged with no loss and no dupes', JSON.stringify(after.a) === JSON.stringify(before.a), { before: before.a, after: after.a });
    check('B reconverged with no loss and no dupes', JSON.stringify(after.b) === JSON.stringify(before.b), { before: before.b, after: after.b });
    check('C reconverged with no loss and no dupes', JSON.stringify(after.c) === JSON.stringify(before.c), { before: before.c, after: after.c });
    check('all drains empty after reconvergence',
      pendingTotal(A) === 0 && pendingTotal(B) === 0 && pendingTotal(C) === 0,
      { a: A.cloudSync.status().pending, b: B.cloudSync.status().pending, c: C.cloudSync.status().pending });
    check('rebuilt hub carries the re-pushed log', (await hubStatus()).head_seq > 0);
  } finally {
    destroyDevice(A);
    destroyDevice(B);
    if (C) destroyDevice(C);
    await stopHub();
    if (process.env.MATRIX_KEEP_TMP !== '1') {
      rmSync(persistDir, { recursive: true, force: true });
    }
  }

  console.log(failures === 0 ? '\nMATRIX RESULT: ALL CHECKS PASSED' : `\nMATRIX RESULT: ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Matrix harness error:', err);
  await stopHub();
  process.exit(1);
});
