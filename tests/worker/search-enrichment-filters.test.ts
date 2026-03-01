/**
 * Search API enrichment filter tests (Task 8)
 *
 * Tests that search filters correctly handle topics, entity, entityType, and pinned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let store: SessionStore;

beforeEach(() => {
  store = new SessionStore(':memory:');

  // Disable FK constraints for test isolation — observations table has FK to sdk_sessions
  store.db.run('PRAGMA foreign_keys = OFF');

  // Insert test observations with enrichment data
  const insert = store.db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, narrative, facts, concepts,
     files_read, files_modified, priority, topics, entities, event_date,
     pinned, access_count, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = Date.now();

  // Obs 1: auth topic, Alice entity, pinned
  insert.run('sess-1', 'proj', 'discovery', 'Auth migration', 'Auth narrative',
    '["fact-1"]', '["how-it-works"]', '[]', '[]', 'important',
    '["auth","migration"]',
    '[{"name":"Alice","type":"person"},{"name":"Backend","type":"team"}]',
    '2026-03-15', 1, 0, new Date(now).toISOString(), now);

  // Obs 2: deploy topic, Redis entity, not pinned
  insert.run('sess-1', 'proj', 'discovery', 'Deploy config', 'Deploy narrative',
    '["fact-2"]', '["how-it-works"]', '[]', '[]', 'informational',
    '["deployment","ci-cd"]',
    '[{"name":"Redis","type":"system"}]',
    null, 0, 0, new Date(now - 1000).toISOString(), now - 1000);

  // Obs 3: auth topic, no entities, not pinned
  insert.run('sess-1', 'proj', 'bugfix', 'Auth fix', 'Fix narrative',
    '["fact-3"]', '["problem-solution"]', '[]', '[]', 'informational',
    '["auth"]', null, null, 0, 0, new Date(now - 2000).toISOString(), now - 2000);

  // Obs 4: no enrichment (legacy), not pinned
  insert.run('sess-1', 'proj', 'discovery', 'Legacy obs', 'Legacy narrative',
    '["fact-4"]', '["how-it-works"]', '[]', '[]', 'informational',
    null, null, null, 0, 0, new Date(now - 3000).toISOString(), now - 3000);
});

afterEach(() => {
  store.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Search API — topics filter', () => {
  it('should filter observations by topic', () => {
    const search = new SessionSearch(store.db);
    const results = search.searchObservations('', {
      project: 'proj',
      topics: ['auth'],
    });
    expect(results.length).toBe(2);
    expect(results.every(r => {
      const topics = r.topics ? JSON.parse(r.topics as string) as string[] : [];
      return topics.includes('auth');
    })).toBe(true);
  });

  it('should return all when topics filter is empty', () => {
    const search = new SessionSearch(store.db);
    const results = search.searchObservations('', {
      project: 'proj',
    });
    expect(results.length).toBe(4);
  });
});

describe('Search API — entity filter', () => {
  it('should filter by entity name', () => {
    const search = new SessionSearch(store.db);
    const results = search.searchObservations('', {
      project: 'proj',
      entity: 'Alice',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Auth migration');
  });
});

describe('Search API — entityType filter', () => {
  it('should filter by entity type', () => {
    const search = new SessionSearch(store.db);
    const results = search.searchObservations('', {
      project: 'proj',
      entityType: 'system',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Deploy config');
  });
});

describe('Search API — pinned filter', () => {
  it('should filter pinned-only observations', () => {
    const search = new SessionSearch(store.db);
    const results = search.searchObservations('', {
      project: 'proj',
      pinned: true,
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Auth migration');
  });
});

describe('Search API — combined filters', () => {
  it('should combine topic + entity filters with AND', () => {
    const search = new SessionSearch(store.db);
    const results = search.searchObservations('', {
      project: 'proj',
      topics: ['auth'],
      entity: 'Alice',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Auth migration');
  });
});
