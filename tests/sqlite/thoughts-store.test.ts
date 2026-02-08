/**
 * Thoughts storage method tests
 * Tests storeThoughts, getThoughts, getThoughtsByIds, and searchThoughts
 * on SessionStore using an in-memory database with all migrations applied
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import type { ThoughtInput } from '../../src/services/sqlite/thoughts/types.js';
import type { Database } from 'bun:sqlite';

describe('SessionStore Thoughts Methods', () => {
  let store: SessionStore;
  let rawDb: Database;

  beforeEach(() => {
    // Use ClaudeMemDatabase to get a fully-migrated db (includes thoughts table)
    const claudeDb = new ClaudeMemDatabase(':memory:');
    rawDb = claudeDb.db;

    // Create SessionStore with :memory: and swap db to the fully-migrated one
    // SessionStore constructor creates its own db, so we close it and replace
    store = Object.create(SessionStore.prototype);
    store.db = rawDb;
  });

  afterEach(() => {
    rawDb.close();
  });

  function makeThoughtInput(overrides: Partial<ThoughtInput> = {}): ThoughtInput {
    return {
      thinking_text: 'I need to analyze the database schema for potential issues',
      thinking_summary: 'Analyzing database schema',
      message_index: 0,
      ...overrides,
    };
  }

  describe('storeThoughts', () => {
    it('should store a single thought and return its id', () => {
      const ids = store.storeThoughts(
        'mem-session-1',
        'content-session-1',
        'test-project',
        [makeThoughtInput()],
        1
      );

      expect(ids).toHaveLength(1);
      expect(ids[0]).toBeGreaterThan(0);
    });

    it('should store multiple thoughts and return all ids', () => {
      const thoughts: ThoughtInput[] = [
        makeThoughtInput({ thinking_text: 'First thought', message_index: 0 }),
        makeThoughtInput({ thinking_text: 'Second thought', message_index: 1 }),
        makeThoughtInput({ thinking_text: 'Third thought', message_index: 2 }),
      ];

      const ids = store.storeThoughts(
        'mem-session-1',
        'content-session-1',
        'test-project',
        thoughts,
        1
      );

      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3); // All unique
    });

    it('should store thoughts with null content_session_id', () => {
      const ids = store.storeThoughts(
        'mem-session-1',
        null,
        'test-project',
        [makeThoughtInput()],
        null
      );

      expect(ids).toHaveLength(1);

      const row = rawDb.prepare('SELECT content_session_id FROM thoughts WHERE id = ?').get(ids[0]) as { content_session_id: string | null };
      expect(row.content_session_id).toBeNull();
    });

    it('should store thoughts with null thinking_summary', () => {
      const ids = store.storeThoughts(
        'mem-session-1',
        'content-session-1',
        'test-project',
        [makeThoughtInput({ thinking_summary: null })],
        1
      );

      expect(ids).toHaveLength(1);

      const row = rawDb.prepare('SELECT thinking_summary FROM thoughts WHERE id = ?').get(ids[0]) as { thinking_summary: string | null };
      expect(row.thinking_summary).toBeNull();
    });

    it('should return empty array for empty input', () => {
      const ids = store.storeThoughts(
        'mem-session-1',
        'content-session-1',
        'test-project',
        [],
        1
      );

      expect(ids).toHaveLength(0);
    });

    it('should populate created_at and created_at_epoch', () => {
      const before = Date.now();
      const ids = store.storeThoughts(
        'mem-session-1',
        null,
        'test-project',
        [makeThoughtInput()],
        null
      );
      const after = Date.now();

      const row = rawDb.prepare('SELECT created_at, created_at_epoch FROM thoughts WHERE id = ?').get(ids[0]) as {
        created_at: string;
        created_at_epoch: number;
      };

      expect(row.created_at_epoch).toBeGreaterThanOrEqual(before);
      expect(row.created_at_epoch).toBeLessThanOrEqual(after);
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    });
  });

  describe('getThoughts', () => {
    beforeEach(() => {
      // Insert some test data with known epochs
      const stmt = rawDb.prepare(`
        INSERT INTO thoughts (memory_session_id, content_session_id, project, thinking_text, thinking_summary, message_index, prompt_number, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run('mem-1', 'cs-1', 'project-a', 'thought alpha', 'summary alpha', 0, 1, '2026-01-01T00:00:00.000Z', 1000);
      stmt.run('mem-1', 'cs-1', 'project-a', 'thought beta', 'summary beta', 1, 1, '2026-01-02T00:00:00.000Z', 2000);
      stmt.run('mem-1', 'cs-1', 'project-a', 'thought gamma', 'summary gamma', 2, 2, '2026-01-03T00:00:00.000Z', 3000);
      stmt.run('mem-2', 'cs-2', 'project-b', 'thought delta', 'summary delta', 0, 1, '2026-01-04T00:00:00.000Z', 4000);
    });

    it('should return thoughts for a specific project', () => {
      const results = store.getThoughts('project-a');

      expect(results).toHaveLength(3);
      expect(results.every(r => r.project === 'project-a')).toBe(true);
    });

    it('should order by created_at_epoch DESC', () => {
      const results = store.getThoughts('project-a');

      expect(results[0].created_at_epoch).toBe(3000);
      expect(results[1].created_at_epoch).toBe(2000);
      expect(results[2].created_at_epoch).toBe(1000);
    });

    it('should respect limit option', () => {
      const results = store.getThoughts('project-a', { limit: 2 });

      expect(results).toHaveLength(2);
      expect(results[0].created_at_epoch).toBe(3000);
      expect(results[1].created_at_epoch).toBe(2000);
    });

    it('should filter by startEpoch', () => {
      const results = store.getThoughts('project-a', { startEpoch: 2000 });

      expect(results).toHaveLength(2);
      expect(results.every(r => r.created_at_epoch >= 2000)).toBe(true);
    });

    it('should filter by endEpoch', () => {
      const results = store.getThoughts('project-a', { endEpoch: 2000 });

      expect(results).toHaveLength(2);
      expect(results.every(r => r.created_at_epoch <= 2000)).toBe(true);
    });

    it('should filter by both startEpoch and endEpoch', () => {
      const results = store.getThoughts('project-a', { startEpoch: 1500, endEpoch: 2500 });

      expect(results).toHaveLength(1);
      expect(results[0].thinking_text).toBe('thought beta');
    });

    it('should return empty array for non-existent project', () => {
      const results = store.getThoughts('non-existent');
      expect(results).toHaveLength(0);
    });
  });

  describe('getThoughtsByIds', () => {
    let insertedIds: number[];

    beforeEach(() => {
      insertedIds = store.storeThoughts(
        'mem-1',
        'cs-1',
        'test-project',
        [
          makeThoughtInput({ thinking_text: 'first', message_index: 0 }),
          makeThoughtInput({ thinking_text: 'second', message_index: 1 }),
          makeThoughtInput({ thinking_text: 'third', message_index: 2 }),
        ],
        1
      );
    });

    it('should return thoughts matching the given ids', () => {
      const results = store.getThoughtsByIds([insertedIds[0], insertedIds[2]]);

      expect(results).toHaveLength(2);
      const texts = results.map(r => r.thinking_text);
      expect(texts).toContain('first');
      expect(texts).toContain('third');
    });

    it('should return all thoughts when all ids provided', () => {
      const results = store.getThoughtsByIds(insertedIds);
      expect(results).toHaveLength(3);
    });

    it('should return empty array for empty ids', () => {
      const results = store.getThoughtsByIds([]);
      expect(results).toHaveLength(0);
    });

    it('should return empty array for non-existent ids', () => {
      const results = store.getThoughtsByIds([99999, 99998]);
      expect(results).toHaveLength(0);
    });
  });

  describe('searchThoughts', () => {
    beforeEach(() => {
      store.storeThoughts(
        'mem-1',
        'cs-1',
        'project-a',
        [
          makeThoughtInput({ thinking_text: 'analyzing the database schema for performance optimization', thinking_summary: 'database analysis' }),
          makeThoughtInput({ thinking_text: 'implementing the authentication flow with JWT tokens', thinking_summary: 'auth implementation' }),
        ],
        1
      );
      store.storeThoughts(
        'mem-2',
        'cs-2',
        'project-b',
        [
          makeThoughtInput({ thinking_text: 'reviewing database migration strategy for the new schema', thinking_summary: 'migration review' }),
        ],
        1
      );
    });

    it('should find thoughts matching search query', () => {
      const results = store.searchThoughts('database schema');

      expect(results.length).toBeGreaterThanOrEqual(1);
      const texts = results.map(r => r.thinking_text);
      expect(texts.some(t => t.includes('database schema'))).toBe(true);
    });

    it('should filter by project when provided', () => {
      const results = store.searchThoughts('database', 'project-a');

      expect(results).toHaveLength(1);
      expect(results[0].project).toBe('project-a');
    });

    it('should search across all projects when project is not provided', () => {
      const results = store.searchThoughts('database');

      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect limit parameter', () => {
      const results = store.searchThoughts('database', undefined, 1);
      expect(results).toHaveLength(1);
    });

    it('should return empty array for no matches', () => {
      const results = store.searchThoughts('nonexistentxyzterm');
      expect(results).toHaveLength(0);
    });

    it('should search thinking_summary via FTS', () => {
      const results = store.searchThoughts('migration review');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.thinking_summary === 'migration review')).toBe(true);
    });
  });
});
