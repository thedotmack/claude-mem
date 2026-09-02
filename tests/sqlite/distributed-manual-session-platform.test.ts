import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createRequire } from 'node:module';

const { SessionStore } = createRequire(import.meta.url)('../../plugin/sqlite/SessionStore.js') as {
  SessionStore: new (dbPath?: string) => {
    db: {
      prepare: (sql: string) => {
        all: (...params: unknown[]) => Array<{ memory_session_id: string; platform_source: string }>;
      };
    };
    getOrCreateManualSession: (project: string, platformSource?: string) => string;
    close: () => void;
  };
};

describe('distributed SessionStore manual session platform identity', () => {
  let store: InstanceType<typeof SessionStore>;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('keeps Cursor and Codex manual saves as separate sessions in the shipped worker module', () => {
    const project = 'shared-project';
    const cursorSession = store.getOrCreateManualSession(project, 'cursor');
    const codexSession = store.getOrCreateManualSession(project, 'codex');

    expect(cursorSession).toBe('manual-shared-project-cursor');
    expect(codexSession).toBe('manual-shared-project-codex');
    expect(codexSession).not.toBe(cursorSession);
    expect(store.getOrCreateManualSession(project, 'cursor')).toBe(cursorSession);

    const rows = store.db.prepare(
      'SELECT memory_session_id, platform_source FROM sdk_sessions ORDER BY platform_source',
    ).all() as Array<{ memory_session_id: string; platform_source: string }>;
    expect(rows).toEqual([
      { memory_session_id: 'manual-shared-project-codex', platform_source: 'codex' },
      { memory_session_id: 'manual-shared-project-cursor', platform_source: 'cursor' },
    ]);
  });
});
