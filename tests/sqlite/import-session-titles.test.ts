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

it('queues exactly one validated restored-title mutation for a remote replica', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  const replica = new SessionStore(':memory:');
  try {
    const id = source.createSDKSession('content', 'app', 'prompt', 'Restored name', 'cursor');
    source.updateMemorySessionId(id, 'memory');
    const [exported] = source.getSdkSessionsBySessionIds(['memory']);
    target.importSdkSession(exported);
    target.importSdkSession(exported);
    const queued = target.db.query('SELECT op_uuid, rev, body FROM sync_outbox').all() as Array<{
      op_uuid: string;
      rev: string;
      body: string;
    }>;
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].body)).toEqual({
      op: 'set_title',
      target: { content_session_id: 'content', platform_source: 'cursor' },
      fields: { custom_title: 'Restored name' },
    });
    const remoteId = replica.createSDKSession('content', 'app', 'prompt', undefined, 'cursor');
    new SyncApply(replica.db, { deviceId: 'replica' }).applyOps(
      [
        {
          seq: '1',
          kind: 'mutation',
          origin_device: 'restore-device',
          origin_id: queued[0].op_uuid,
          rev: String(queued[0].rev),
          body: queued[0].body,
          server_ts: 1000,
        },
      ],
      { epoch: 'test-epoch' }
    );
    expect(replica.getSessionById(remoteId)?.custom_title).toBe('Restored name');
  } finally {
    source.close();
    target.close();
    replica.close();
  }
});
it('rejects invalid imported titles before inserting a session', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  try {
    const id = source.createSDKSession('content', 'app', 'prompt');
    source.updateMemorySessionId(id, 'memory');
    const [session] = source.getSdkSessionsBySessionIds(['memory']);
    for (const title of ['', '   ', 'é'.repeat(2049)]) {
      expect(() => target.importSdkSession({ ...session, custom_title: title })).toThrow(
        /non-blank string/
      );
    }
    expect(target.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
    target.importSdkSession({ ...session, custom_title: 'é'.repeat(2048) });
    expect(target.getSessionById(1)?.custom_title).toBe('é'.repeat(2048));
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
