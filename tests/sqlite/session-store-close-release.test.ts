import { expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { logger } from '../../src/utils/logger.js';
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

it('falls back to a lazy close, with a warning, when this Bun refuses a strict close', () => {
  const store = new SessionStore(':memory:');
  const db = store.db;
  const realClose = db.close.bind(db);
  const closeCalls: Array<boolean | undefined> = [];
  db.close = (throwOnError?: boolean) => {
    closeCalls.push(throwOnError);
    // Bun before 1.4 throws this when statements are still outstanding.
    if (throwOnError === true) throw new Error('database is locked');
    realClose(throwOnError);
  };
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    expect(() => store.close()).not.toThrow();
    expect(closeCalls).toEqual([true, false]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('falling back to lazy close');
  } finally {
    warn.mockRestore();
  }
});
