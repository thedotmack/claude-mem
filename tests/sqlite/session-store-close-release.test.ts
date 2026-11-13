import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { removeTempDir } from '../helpers/temp-dir.js';

it('closing a store releases the database file its cached statements were holding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-close-release-'));
  try {
    const path = join(root, 'memory.db');
    const store = new SessionStore(path);
    // updateMemorySessionId queues a sync op, which prepares and caches statements on this store.
    const session = store.createSDKSession('close-release', 'project', 'prompt');
    store.updateMemorySessionId(session, 'close-release-memory');

    expect(() => store.close()).not.toThrow();
    expect(existsSync(path)).toBe(true);

    // The directory holds the database, its WAL index and this file, so it only comes away once
    // close() has released the connection. On Windows that removal is the user-visible symptom.
    await removeTempDir(root);
    expect(existsSync(root)).toBe(false);
  } finally {
    if (existsSync(root)) await removeTempDir(root);
  }
});
