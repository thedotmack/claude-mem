#!/usr/bin/env bun
// Kill-switch e2e (plan Phase 5 verification) — the Phase 4 two-device e2e
// variant with a kill-switch trip in the middle.
//
// REQUIRES a running local hub:
//   cd workers/sync-hub && bunx wrangler dev --var KILL_SWITCH_CACHE_MS:0
// Authentication always uses TOKEN_VERIFY_URL; supply CANARY_USER_ID and
// CANARY_TOKEN for a verifier-backed test account. KILL_SWITCH_CACHE_MS:0 makes
// flag flips visible per request.
//
// Flow (all assertions fatal):
//   1. Device A = CloudSync (push drain), device B = SyncClient (pull loop +
//      real Bun WebSocket) — separate in-memory SessionStores, one hub user.
//   2. B's advisory socket connects; A writes obs-1 → B converges (WS fast
//      path).
//   3. TRIP the kill switch (`wrangler kv key put --local` against the same
//      .wrangler state the dev server reads) → B's next pull sees
//      X-Sync-Mode: poll → socket closed, reconnects suppressed; a raw
//      upgrade probe answers 503/poll; A writes obs-2 → B STILL converges
//      (the structural guarantee: HTTP sync unaffected).
//   4. CLEAR the flag → header disappears → B's socket resumes; A writes
//      obs-3 → B converges again.
//
// Output: one JSON line per checkpoint; exit 0 on PASS.

import { Database } from 'bun:sqlite';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../src/services/sync/SyncApply.js';
import { SyncClient } from '../src/services/sync/SyncClient.js';
import { CloudSync } from '../src/services/sync/CloudSync.js';

const HUB = process.env.CANARY_HUB_URL ?? 'http://localhost:8787';
const SYNC_HUB_DIR = resolve(import.meta.dir, '../workers/sync-hub');
const USER = process.env.CANARY_USER_ID ?? '';
const TOKEN = process.env.CANARY_TOKEN ?? '';
const DEV_A = 'e2e-dev-a';
const DEV_B = 'e2e-dev-b';
const KILL_KEY = 'control:kill-switch';

function log(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...record }));
}

function fail(message: string): never {
  log({ event: 'FAIL', message });
  process.exit(1);
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  fail(`timed out waiting for ${what}`);
}

function kv(args: string[]): void {
  const result = spawnSync('bunx', ['wrangler', 'kv', 'key', ...args, '--binding', 'AUTH_CACHE', '--local'], {
    cwd: SYNC_HUB_DIR,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    fail(`wrangler kv ${args[0]} failed: ${result.stderr?.slice(0, 300)}`);
  }
}

function seedSession(db: Database): void {
  // observations.memory_session_id has an FK to sdk_sessions — the parent
  // row must exist (same fixture shape as cloud-sync.test.ts beforeEach).
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES ('sess-e2e', 'mem-e2e', 'proj-e2e', ?, ?, 'active')
  `).run(new Date().toISOString(), Date.now());
}

function seedObservation(db: Database, title: string): void {
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, title, narrative, prompt_number, discovery_tokens, created_at, created_at_epoch)
    VALUES ('mem-e2e', 'proj-e2e', 'discovery', ?, 'kill-switch e2e', 1, 0, ?, ?)
  `).run(title, new Date().toISOString(), Date.now());
}

async function main(): Promise<void> {
	if (!USER || !TOKEN) {
		fail('CANARY_USER_ID and CANARY_TOKEN are required');
	}
  // 0. Hub reachable?
  const probe = await fetch(`${HUB}/v1/sync/status`, {
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'X-User-Id': USER, 'X-Device-Id': DEV_A },
  }).catch(() => null);
  if (!probe || !probe.ok) {
    fail(`hub not reachable at ${HUB} — start it with: cd workers/sync-hub && bunx wrangler dev --var KILL_SWITCH_CACHE_MS:0`);
  }
  // Stale flag from an earlier run would poison phase 1.
  kv(['delete', KILL_KEY]);
  log({ event: 'start', hub: HUB, user: USER });

  const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-kill-e2e-'));
  const dbA = new Database(':memory:');
  const dbB = new Database(':memory:');
  new SessionStore(dbA);
  new SessionStore(dbB);
  seedSession(dbA);

  // Device A: the push drain.
  const cloudSync = new CloudSync(dbA, {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: USER,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: HUB,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEV_A,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'e2e-a',
  }, {
    settingsPath: join(tempDir, 'settings-a.json'),
    debounceMs: 100,
  });

  // Device B: pull loop + real Bun WebSocket (the advisory lane under test).
  const apply = new SyncApply(dbB, { deviceId: DEV_B });
  const client = new SyncClient(apply, {
    hubUrl: HUB,
    token: TOKEN,
    userId: USER,
    deviceId: DEV_B,
    deviceName: 'e2e-b',
    activePollMs: 1_000,
    idlePollMs: 1_000, // fast re-probe while the socket is live
    minPullGapMs: 0,
    isSessionActive: () => true,
  });
  cloudSync.setSyncModeListener((mode) => client.onSyncModeHint(mode));
  cloudSync.setHeadSeqListener((headSeq) => client.onHeadSeq(headSeq));

  const obsCount = (): number =>
    (dbB.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;

  try {
    // ---- Phase 1: socket up, WS-lane convergence --------------------------
    client.start();
    await waitFor(() => client.isSocketLive(), 'advisory socket to connect');
    log({ event: 'socket_live', pollModeOnly: client.isPollModeOnly() });

    seedObservation(dbA, 'obs-1 (socket lane)');
    await cloudSync.flush();
    await waitFor(() => obsCount() >= 1, 'obs-1 to converge on device B');
    log({ event: 'converged', phase: 'socket', observations: obsCount() });

    // ---- Phase 2: TRIP — poll mode, still converging ----------------------
    kv(['put', KILL_KEY, JSON.stringify({ source: 'e2e', tripped_at: new Date().toISOString() })]);
    log({ event: 'kill_switch_tripped' });

    await waitFor(() => client.isPollModeOnly(), 'client to enter poll mode');
    await waitFor(() => !client.isSocketLive(), 'socket to close');
    log({ event: 'poll_mode_entered', socketLive: client.isSocketLive() });

    // A raw upgrade probe must be refused 503 with the recognizable body.
    const wsProbe = await fetch(`${HUB}/v1/sync/ws`, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`, 'X-User-Id': USER, 'X-Device-Id': DEV_B,
        'Upgrade': 'websocket',
      },
    });
    const wsBody = await wsProbe.json().catch(() => null) as { mode?: string } | null;
    if (wsProbe.status !== 503 || wsBody?.mode !== 'poll') {
      fail(`expected 503/poll upgrade refusal, got ${wsProbe.status} ${JSON.stringify(wsBody)}`);
    }
    log({ event: 'ws_refused', status: wsProbe.status, mode: wsBody?.mode, header: wsProbe.headers.get('X-Sync-Mode') });

    seedObservation(dbA, 'obs-2 (poll lane)');
    await cloudSync.flush(); // pushes still work while tripped
    await waitFor(() => obsCount() >= 2, 'obs-2 to converge over HTTP during poll mode');
    if (client.isSocketLive()) fail('socket resurrected during poll mode');
    log({ event: 'converged', phase: 'poll_mode', observations: obsCount(), pollModeOnly: client.isPollModeOnly() });

    // ---- Phase 3: CLEAR — socket resumes, WS-lane convergence again -------
    kv(['delete', KILL_KEY]);
    log({ event: 'kill_switch_cleared' });

    await waitFor(() => !client.isPollModeOnly(), 'client to leave poll mode');
    await waitFor(() => client.isSocketLive(), 'socket to resume');
    log({ event: 'socket_resumed' });

    seedObservation(dbA, 'obs-3 (recovered socket lane)');
    await cloudSync.flush();
    await waitFor(() => obsCount() >= 3, 'obs-3 to converge after recovery');
    log({ event: 'converged', phase: 'recovered', observations: obsCount() });

    log({ event: 'PASS' });
  } finally {
    client.stop();
    cloudSync.stop();
    dbA.close();
    dbB.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
  process.exit(0);
}

void main();
