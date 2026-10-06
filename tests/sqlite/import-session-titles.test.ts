import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

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
