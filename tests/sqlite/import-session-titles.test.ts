import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../src/services/sync/SyncApply.js';

it('retains custom session titles when importing an exported session', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  try {
    const id = source.createSDKSession('content', 'app', 'prompt', 'Release readiness');
    source.updateMemorySessionId(id, 'memory');
    const [exported] = source.getSdkSessionsBySessionIds(['memory']);
    expect(exported.custom_title).toBe('Release readiness');
    const imported = target.importSdkSession(exported);
    expect(target.getSessionById(imported.id)?.custom_title).toBe('Release readiness');
    expect(target.importSdkSession({ ...exported, custom_title: 'Do not overwrite' })).toEqual({
      imported: false,
      id: imported.id,
    });
    expect(target.getSessionById(imported.id)?.custom_title).toBe('Release readiness');
  } finally {
    source.close();
    target.close();
  }
});

it('keeps legacy omitted and explicit null titles nullable', () => {
  const target = new SessionStore(':memory:');
  try {
    const session = {
      content_session_id: 'legacy',
      memory_session_id: 'memory-legacy',
      project: 'app',
      platform_source: 'claude',
      user_prompt: 'prompt',
      started_at: new Date(1000).toISOString(),
      started_at_epoch: 1000,
      completed_at: null,
      completed_at_epoch: null,
      status: 'active',
    };
    const legacy = target.importSdkSession(session);
    const nullable = target.importSdkSession({
      ...session,
      content_session_id: 'nullable',
      memory_session_id: 'memory-null',
      custom_title: null,
    });
    expect(target.getSessionById(legacy.id)?.custom_title).toBeNull();
    expect(target.getSessionById(nullable.id)?.custom_title).toBeNull();
  } finally {
    target.close();
  }
});

it('restores historical titles locally without overwriting newer replica titles', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  const replica = new SessionStore(':memory:');
  try {
    const id = source.createSDKSession('content', 'app', 'prompt', 'Older backup name', 'cursor');
    source.updateMemorySessionId(id, 'memory');
    const [exported] = source.getSdkSessionsBySessionIds(['memory']);
    const remoteId = replica.createSDKSession('content', 'app', 'prompt', 'Newer replica name', 'cursor');
    const imported = target.importSdkSession(exported);
    target.importSdkSession(exported);
    const queued = target.db.query('SELECT op_uuid, rev, body FROM sync_outbox').all() as Array<{
      op_uuid: string;
      rev: string;
      body: string;
    }>;
    new SyncApply(replica.db, { deviceId: 'replica' }).applyOps(
      queued.map((operation, index) => ({
        seq: String(index + 1),
        kind: 'mutation' as const,
        origin_device: 'restore-device',
        origin_id: operation.op_uuid,
        rev: String(operation.rev),
        body: operation.body,
        server_ts: 1000,
      })),
      { epoch: 'test-epoch' }
    );
    expect(target.getSessionById(imported.id)?.custom_title).toBe('Older backup name');
    expect(replica.getSessionById(remoteId)?.custom_title).toBe('Newer replica name');
    expect(queued).toHaveLength(0);
    // Explicitly creating a titled session remains a current sync mutation.
    target.createSDKSession('new-content', 'app', 'prompt', 'New chosen name', 'cursor');
    expect(target.db.query('SELECT count(*) AS n FROM sync_outbox').get()).toEqual({ n: 1 });
  } finally {
    source.close();
    target.close();
    replica.close();
  }
});

it('restores legacy SQLite title strings exactly, including blank and oversized values', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  try {
    for (const [index, title] of ['', '   ', 'é'.repeat(2049), 'Current valid title'].entries()) {
      const id = source.createSDKSession(`content-${index}`, 'app', 'prompt');
      source.updateMemorySessionId(id, `memory-${index}`);
      source.db.query('UPDATE sdk_sessions SET custom_title = ? WHERE id = ?').run(title, id);
      const [exported] = source.getSdkSessionsBySessionIds([`memory-${index}`]);
      const imported = target.importSdkSession(exported);
      expect(imported.imported).toBe(true);
      expect(target.getSessionById(imported.id)?.custom_title).toBe(title);
    }
    expect(target.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 4 });
    expect(target.db.query('SELECT count(*) AS n FROM sync_outbox').get()).toEqual({ n: 0 });
  } finally {
    source.close();
    target.close();
  }
});

it('rejects non-string title JSON values before inserting a session', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  try {
    const id = source.createSDKSession('content', 'app', 'prompt');
    source.updateMemorySessionId(id, 'memory');
    const [exported] = source.getSdkSessionsBySessionIds(['memory']);
    for (const title of [123, false, {}, []]) {
      expect(() => target.importSdkSession({ ...exported, custom_title: title as any })).toThrow();
    }
    expect(target.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
  } finally {
    source.close();
    target.close();
  }
});
it('keeps unconfigured restore out of the sync outbox', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const id = source.createSDKSession('content', 'app', 'prompt', 'Local title');
    source.updateMemorySessionId(id, 'memory');
    const [session] = source.getSdkSessionsBySessionIds(['memory']);
    target.importSdkSession(session);
    expect(target.db.query('SELECT count(*) AS n FROM sync_outbox').get()).toEqual({ n: 0 });
    expect(target.getSessionById(1)?.custom_title).toBe('Local title');
  } finally {
    source.close();
    target.close();
  }
});
