/**
 * Tests for SessionStore.markSessionCompleted (fix for #1532)
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' - tests actual SQL and schema
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionStore.markSessionCompleted', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('sets status to completed and records completed_at timestamps', () => {
    const before = Date.now();
    const id = store.createSDKSession('session-1', 'project', 'prompt');

    store.markSessionCompleted(id);

    const row = store.db.prepare(
      'SELECT status, completed_at, completed_at_epoch FROM sdk_sessions WHERE id = ?'
    ).get(id) as { status: string; completed_at: string; completed_at_epoch: number };

    expect(row.status).toBe('completed');
    expect(row.completed_at).toBeTruthy();
    expect(row.completed_at_epoch).toBeGreaterThanOrEqual(before);
    expect(row.completed_at_epoch).toBeLessThanOrEqual(Date.now());
  });

  it('leaves other sessions unaffected', () => {
    const id1 = store.createSDKSession('session-a', 'project', 'prompt');
    const id2 = store.createSDKSession('session-b', 'project', 'prompt');

    store.markSessionCompleted(id1);

    const row2 = store.db.prepare(
      'SELECT status, completed_at FROM sdk_sessions WHERE id = ?'
    ).get(id2) as { status: string; completed_at: string | null };

    expect(row2.status).toBe('active');
    expect(row2.completed_at).toBeNull();
  });

  it('does not throw when called on a non-existent session id', () => {
    expect(() => store.markSessionCompleted(99999)).not.toThrow();
  });

  it('completed_at is a valid ISO timestamp', () => {
    const id = store.createSDKSession('session-iso', 'project', 'prompt');
    store.markSessionCompleted(id);

    const row = store.db.prepare(
      'SELECT completed_at FROM sdk_sessions WHERE id = ?'
    ).get(id) as { completed_at: string };

    expect(() => new Date(row.completed_at).toISOString()).not.toThrow();
    expect(new Date(row.completed_at).getTime()).toBeGreaterThan(0);
  });
});
