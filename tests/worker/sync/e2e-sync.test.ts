// End-to-end encryption for cloud sync (CLAUDE_MEM_CLOUD_SYNC_E2E): the codec,
// sealed canonical ops, and a full device A → hub → device B round trip in
// which the hub only ever holds ciphertext.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../../src/services/sync/CloudSync.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { SyncClient } from '../../../src/services/sync/SyncClient.js';
import {
  buildContentOperation,
  buildMutationOperation,
  canonicalJson,
  configureSyncE2E,
  decodeHubChange,
  parseCanonicalOperation,
  sha256Base64Url,
} from '../../../src/services/sync/CanonicalContent.js';
import {
  decodeE2EKey,
  E2ECodec,
  encodeE2EKey,
  generateE2EKey,
  isSealedPayload,
  readE2EKey,
  writeE2EKey,
} from '../../../src/services/sync/E2ECodec.js';
import { configureSyncE2EFromSettings } from '../../../src/services/sync/e2e-setup.js';

const ISO = '2026-07-09T00:00:00.000Z';
const MARKER = 'PLAINTEXT-MARKER-7f3a';

function payload(title: string): Record<string, unknown> {
  return {
    memory_session_id: 'mem-1', project: 'proj-secret', text: null, type: 'discovery', title,
    subtitle: 'Sub', facts: ['fact'], narrative: `narrative ${MARKER}`, concepts: null, files_read: null,
    files_modified: null, prompt_number: '1', discovery_tokens: '0', content_hash: null,
    generated_by_model: null, agent_type: null, agent_id: null, metadata: null,
    merged_into_project: null, created_at: ISO, created_at_epoch: '1751234567890',
  };
}

afterEach(() => configureSyncE2E(null));

describe('E2ECodec', () => {
  it('seals deterministically and rejects tampering, a different envelope, and a different key', () => {
    const codec = new E2ECodec(generateE2EKey());
    const a = codec.seal('{"x":1}', 'aad');
    expect(codec.seal('{"x":1}', 'aad')).toEqual(a);
    expect(isSealedPayload(a)).toBe(true);
    expect(codec.open(a, 'aad')).toBe('{"x":1}');
    expect(() => codec.open(a, 'other-aad')).toThrow();
    const flipped = a.ct[0] === 'A' ? 'B' : 'A';
    expect(() => codec.open({ ...a, ct: flipped + a.ct.slice(1) }, 'aad')).toThrow();
    expect(() => new E2ECodec(generateE2EKey()).open(a, 'aad')).toThrow(/different key/);
  });

  it('round-trips the portable key string and writes the key file 0600 without overwriting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-e2e-key-'));
    try {
      const key = generateE2EKey();
      expect(decodeE2EKey(encodeE2EKey(key)).equals(key)).toBe(true);
      expect(() => decodeE2EKey('cmem-e2e-v1:short')).toThrow();
      const path = join(dir, 'sync-e2e.key');
      expect(readE2EKey(path)).toBeNull();
      writeE2EKey(key, path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readE2EKey(path)!.equals(key)).toBe(true);
      expect(() => writeE2EKey(generateE2EKey(), path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('configureSyncE2EFromSettings refuses to enable sync when the key is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-e2e-setup-'));
    try {
      const path = join(dir, 'sync-e2e.key');
      expect(configureSyncE2EFromSettings({ CLAUDE_MEM_CLOUD_SYNC_E2E: 'false' }, path)).toBe(true);
      expect(configureSyncE2EFromSettings({ CLAUDE_MEM_CLOUD_SYNC_E2E: 'true' }, path)).toBe(false);
      writeE2EKey(generateE2EKey(), path);
      expect(configureSyncE2EFromSettings({ CLAUDE_MEM_CLOUD_SYNC_E2E: 'true' }, path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns E2E on from CLAUDE_MEM_CLOUD_SYNC_E2E_KEY alone, without a key file or setting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-e2e-envkey-'));
    const previous = process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY;
    try {
      process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY = encodeE2EKey(generateE2EKey());
      expect(configureSyncE2EFromSettings({}, join(dir, 'missing.key'))).toBe(true);
      const op = buildContentOperation({ kind: 'observation', originDeviceId: 'dev-a', originLocalId: '1', entityRev: '1', payload: payload('t') });
      expect(op.body).not.toContain(MARKER);
      process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY = 'not-a-key';
      expect(configureSyncE2EFromSettings({}, join(dir, 'missing.key'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY;
      else process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sealed canonical operations', () => {
  it('seals content and mutation ops, and decodes them back to plaintext', () => {
    const codec = new E2ECodec(generateE2EKey());
    configureSyncE2E(codec);
    const op = buildContentOperation({ kind: 'observation', originDeviceId: 'dev-a', originLocalId: '7', entityRev: '1', payload: payload('t') });
    expect(op.body).not.toContain(MARKER);
    expect(op.body).not.toContain('proj-secret');
    expect(buildContentOperation({ kind: 'observation', originDeviceId: 'dev-a', originLocalId: '7', entityRev: '1', payload: payload('t') })).toEqual(op);
    expect(isSealedPayload(parseCanonicalOperation(op).payload)).toBe(true);
    expect(decodeHubChange({ ...op, seq: '1' }).body.payload).toEqual(payload('t'));

    const mutation = { op: 'set_title' as const, target: { memory_session_id: 'mem-1' }, fields: { custom_title: `title ${MARKER}` } };
    const mop = buildMutationOperation({ originDeviceId: 'dev-a', entityRev: '1', mutation, mutationId: '3b241101-e2bb-4255-8caf-4136c566a962' });
    expect(mop.body).not.toContain(MARKER);
    expect(decodeHubChange({ ...mop, seq: '2' }).body.mutation).toEqual(mutation);
  });

  it('never mixes modes: plaintext ops are rejected under E2E and sealed ops without it', () => {
    const plain = buildContentOperation({ kind: 'observation', originDeviceId: 'dev-a', originLocalId: '7', entityRev: '1', payload: payload('t') });
    configureSyncE2E(new E2ECodec(generateE2EKey()));
    expect(() => parseCanonicalOperation(plain)).toThrow(/sealed/);
    const sealed = buildContentOperation({ kind: 'observation', originDeviceId: 'dev-a', originLocalId: '7', entityRev: '1', payload: payload('t') });
    configureSyncE2E(null);
    expect(() => parseCanonicalOperation(sealed)).toThrow();
  });

  it('refuses a sealed payload replayed under another revision', () => {
    const codec = new E2ECodec(generateE2EKey());
    configureSyncE2E(codec);
    const op = buildContentOperation({ kind: 'observation', originDeviceId: 'dev-a', originLocalId: '7', entityRev: '1', payload: payload('t') });
    const body = JSON.parse(op.body);
    const replay = buildContentOperation({ kind: 'observation', originDeviceId: 'dev-a', originLocalId: '7', entityRev: '2', payload: payload('other') });
    const replayBody = JSON.parse(replay.body);
    // Keep revision 2's envelope but splice in revision 1's ciphertext.
    const forged = { ...replayBody, payload: body.payload, payload_sha256: body.payload_sha256 };
    const forgedBody = canonicalJson(forged);
    expect(() => decodeHubChange({ body: forgedBody, operation_sha256: sha256Base64Url(forgedBody), seq: '3' })).toThrow();
  });
});

describe('E2E round trip: device A → hub → device B', () => {
  let tempDir: string;
  let dbA: Database;
  let dbB: Database;
  let hubLog: Array<{ body: string; operation_sha256: string; seq: string; server_ts: string }>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cmem-e2e-roundtrip-'));
    dbA = new Database(':memory:');
    dbB = new Database(':memory:');
    const storeA = new SessionStore(dbA);
    new SessionStore(dbB);
    hubLog = [];
    dbA.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-abc', 'mem-1', 'proj-secret', ?, 1751234567000, 'active')`).run(ISO);
    dbA.prepare(`INSERT INTO observations (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
      files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES ('mem-1', 'proj-secret', 'discovery', 'Title A', 'Sub', '["fact"]', ?, NULL, NULL, NULL, 1, 0, ?, 1751234567890)`)
      .run(`narrative ${MARKER}`, ISO);
    dbA.prepare(`INSERT INTO session_summaries (memory_session_id, project, request, investigated, learned, completed,
      next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES ('mem-1', 'proj-secret', ?, 'Inv', 'Lrn', 'Done', 'Next', NULL, 1, 0, ?, 1751234567891)`).run(`request ${MARKER}`, ISO);
    storeA.createSDKSession('sess-titled', 'proj-secret', 'prompt', `custom ${MARKER}`, 'claude');
  });

  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function hubFetch(): { impl: typeof fetch; pushes: number } {
    const state = { pushes: 0 };
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/sync/ops') {
        state.pushes++;
        const ops = (JSON.parse(String(init?.body)).ops ?? []) as Array<{ body: string; operation_sha256: string }>;
        const acked = ops.map((op) => {
          const env = JSON.parse(op.body);
          const seq = String(hubLog.length + 1);
          hubLog.push({ ...op, seq, server_ts: '1751234568000' });
          return { id: env.id, kind: env.kind, origin_local_id: env.origin_local_id, entity_rev: env.entity_rev, operation_sha256: op.operation_sha256, seq };
        });
        const head = String(hubLog.length);
        return new Response(JSON.stringify({ acked, head_seq: head, projected_seq: head }), { status: 200 });
      }
      const since = Number(url.searchParams.get('since') ?? '0');
      const ops = hubLog.filter((op) => Number(op.seq) > since);
      return new Response(JSON.stringify({ protocol_version: 2, epoch: '1', ops, head_seq: String(hubLog.length), more: false }), { status: 200 });
    }) as typeof fetch;
    return {
      impl,
      get pushes() { return state.pushes; },
    };
  }

  function makeCloudSync(fetchImpl: typeof fetch): CloudSync {
    return new CloudSync(dbA, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 't', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'u', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-a', CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'a',
    }, { fetchImpl, settingsPath: join(tempDir, 'settings.json'), debounceMs: 25, backoffInitialMs: 20, backoffMaxMs: 200 });
  }

  async function pullIntoB(fetchImpl: typeof fetch): Promise<SyncApply> {
    const apply = new SyncApply(dbB, { deviceId: 'device-b' });
    const client = new SyncClient(apply, {
      hubUrl: 'https://hub.test', token: 't', userId: 'u', deviceId: 'device-b', deviceName: 'b', fetchImpl,
      wsEnabled: false, activePollMs: 20, idlePollMs: 10_000, suspendAfterMs: 3_600_000,
      backoffInitialMs: 10, backoffMaxMs: 40, minPullGapMs: 0,
    });
    try {
      await client.pullOnce({ timeoutMs: 5_000 });
    } finally {
      client.stop();
    }
    return apply;
  }

  it('rebuilds snapshots frozen in plaintext before E2E was turned on, instead of quarantining them', async () => {
    // E2E off, hub down: each failed flush freezes (in plaintext) what it was
    // about to send. Mutations drain first, so park the frozen mutation to
    // let a second flush freeze a content snapshot too.
    configureSyncE2E(null);
    const down = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    const failedFlush = async () => {
      const cloud = makeCloudSync(down);
      await cloud.flush();
      cloud.stop();
    };
    await failedFlush();
    dbA.exec('CREATE TEMP TABLE parked AS SELECT * FROM sync_outbox; DELETE FROM sync_outbox;');
    await failedFlush();
    dbA.exec('INSERT INTO sync_outbox SELECT * FROM parked;');
    const content = dbA.prepare('SELECT body FROM sync_content_outbox').all() as Array<{ body: string }>;
    const mutations = dbA.prepare('SELECT canonical_body AS body FROM sync_outbox WHERE canonical_body IS NOT NULL').all() as Array<{ body: string }>;
    expect(content.length).toBeGreaterThan(0);
    expect(mutations.length).toBeGreaterThan(0);
    for (const row of [...content, ...mutations]) expect(row.body).toContain(MARKER);

    // E2E on, opaque hub: everything goes out sealed, nothing is dead-lettered.
    configureSyncE2E(new E2ECodec(generateE2EKey()));
    const hub = hubFetch();
    const second = makeCloudSync(hub.impl);
    await second.flush();
    second.stop();
    expect(hubLog.length).toBeGreaterThanOrEqual(3);
    for (const op of hubLog) expect(op.body).not.toContain(MARKER);
    const count = (sql: string) => (dbA.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM sync_dead_letter')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM sync_content_outbox')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM sync_outbox')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM observations WHERE synced_at IS NULL OR synced_at < 0')).toBe(0);
  });

  it('syncs sealed ops the hub cannot read, stamps them once, and device B reads them', async () => {
    const key = generateE2EKey();
    configureSyncE2E(new E2ECodec(key));
    const hub = hubFetch();
    const cloud = makeCloudSync(hub.impl);
    await cloud.flush();

    expect(hubLog.length).toBeGreaterThanOrEqual(3);
    for (const op of hubLog) {
      expect(op.body).not.toContain(MARKER);
      expect(op.body).not.toContain('proj-secret');
    }
    // Acked rows are stamped at their original revision: no re-push loop.
    const pending = (t: string) => (dbA.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE synced_at IS NULL`).get() as { n: number }).n;
    expect(pending('observations')).toBe(0);
    expect(pending('session_summaries')).toBe(0);
    const pushesAfterFirst = hub.pushes;
    await cloud.flush();
    expect(hub.pushes).toBe(pushesAfterFirst);
    cloud.stop();

    // Device B, same key: decrypts and applies.
    configureSyncE2E(new E2ECodec(key));
    await pullIntoB(hub.impl);
    const obs = dbB.prepare('SELECT title, narrative, project FROM observations').all() as Array<Record<string, string>>;
    expect(obs).toEqual([{ title: 'Title A', narrative: `narrative ${MARKER}`, project: 'proj-secret' }]);
    const sum = dbB.prepare('SELECT request FROM session_summaries').all() as Array<Record<string, string>>;
    expect(sum).toEqual([{ request: `request ${MARKER}` }]);
  });

  it('applies nothing on a device holding a different key', async () => {
    configureSyncE2E(new E2ECodec(generateE2EKey()));
    const hub = hubFetch();
    const cloud = makeCloudSync(hub.impl);
    await cloud.flush();
    cloud.stop();

    configureSyncE2E(new E2ECodec(generateE2EKey()));
    const apply = await pullIntoB(hub.impl);
    expect((dbB.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n).toBe(0);
    expect(apply.getCursor()).toBe('0');
  });
});
