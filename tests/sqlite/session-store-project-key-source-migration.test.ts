// Gate P1-2: sdk_sessions.project_key_source records how a session's project
// key was derived (folder path, git-remote slug, environment), beside its
// recorded checkout, so worktree adoption can tell a deleted worktree from a
// deleted clone of a slug-named repository.
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function open(): { store: SessionStore; dbPath: string } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-key-source-migration-'));
  const dbPath = path.join(tempRoot, 'claude-mem.db');
  return { store: new SessionStore(dbPath), dbPath };
}

describe('sdk_sessions.project_key_source migration (gate P1-2)', () => {
  it('records the key source with the checkout, first write wins for both', () => {
    const { store } = open();
    const sessionDbId = store.createSDKSession('content-a', 'acme/api', 'prompt');
    store.setSessionCwd(sessionDbId, '/work/api', 'git-remote');
    store.setSessionCwd(sessionDbId, '/work/api/sub', 'path');
    const row = store.db
      .prepare('SELECT cwd, project_key_source FROM sdk_sessions WHERE id = ?')
      .get(sessionDbId) as { cwd: string; project_key_source: string | null };
    store.close();
    expect(row).toEqual({ cwd: '/work/api', project_key_source: 'git-remote' });
  });
});
