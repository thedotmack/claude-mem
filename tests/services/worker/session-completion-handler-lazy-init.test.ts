/**
 * Tests for SessionCompletionHandler lazy DB initialization (fix for #1553)
 *
 * Regression: SessionCompletionHandler previously called dbManager.getSessionStore()
 * in the constructor, which threw "Database not initialized" on Linux because
 * SessionRoutes is constructed before dbManager.initialize() runs in start().
 *
 * Mock Justification: MINIMAL — only DatabaseManager is mocked, with a controlled
 * flag to simulate uninitialized vs initialized state. All other behavior is tested
 * in session-store-mark-completed.test.ts using real SQLite.
 */
import { describe, it, expect } from 'bun:test';
import { SessionCompletionHandler } from '../../../src/services/worker/session/SessionCompletionHandler.js';

describe('SessionCompletionHandler lazy DB initialization', () => {
  it('can be instantiated before DB is initialized (no getSessionStore() at construction time)', () => {
    let storeAccessed = false;

    const mockDbManager = {
      getSessionStore: () => {
        storeAccessed = true;
        throw new Error('Database not initialized');
      }
    } as any;

    // Must not throw — previously this crashed on Linux (#1553)
    expect(() => new SessionCompletionHandler(
      {} as any,
      {} as any,
      mockDbManager
    )).not.toThrow();

    expect(storeAccessed).toBe(false);
  });
});
