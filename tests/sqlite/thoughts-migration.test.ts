/**
 * Migration 008 tests - Thoughts table and FTS5 search
 * Validates the thoughts table schema, indexes, FTS5 virtual table, and triggers
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import type { Database } from 'bun:sqlite';

describe('Migration 008 - Thoughts Table & FTS5', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  describe('thoughts table schema', () => {
    it('should create the thoughts table with all required columns', () => {
      const columns = db.query(`PRAGMA table_info(thoughts)`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;

      const columnMap = new Map(columns.map(c => [c.name, c]));

      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.get('id')!.pk).toBe(1);

      expect(columnMap.has('memory_session_id')).toBe(true);
      expect(columnMap.get('memory_session_id')!.notnull).toBe(1);

      expect(columnMap.has('content_session_id')).toBe(true);
      expect(columnMap.get('content_session_id')!.notnull).toBe(0);

      expect(columnMap.has('project')).toBe(true);
      expect(columnMap.get('project')!.notnull).toBe(1);

      expect(columnMap.has('thinking_text')).toBe(true);
      expect(columnMap.get('thinking_text')!.notnull).toBe(1);

      expect(columnMap.has('thinking_summary')).toBe(true);
      expect(columnMap.get('thinking_summary')!.notnull).toBe(0);

      expect(columnMap.has('message_index')).toBe(true);
      expect(columnMap.has('prompt_number')).toBe(true);

      expect(columnMap.has('created_at')).toBe(true);
      expect(columnMap.get('created_at')!.notnull).toBe(1);

      expect(columnMap.has('created_at_epoch')).toBe(true);
      expect(columnMap.get('created_at_epoch')!.notnull).toBe(1);
    });

    it('should create the required indexes', () => {
      const indexes = db.query(`PRAGMA index_list(thoughts)`).all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_thoughts_session');
      expect(indexNames).toContain('idx_thoughts_project');
      expect(indexNames).toContain('idx_thoughts_epoch');
    });
  });

  describe('thoughts_fts virtual table', () => {
    it('should create the FTS5 virtual table', () => {
      const tables = db.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='thoughts_fts'`
      ).all() as Array<{ name: string }>;

      expect(tables.length).toBe(1);
      expect(tables[0].name).toBe('thoughts_fts');
    });

    it('should support full-text search on thinking_text', () => {
      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      db.run(
        `INSERT INTO thoughts (memory_session_id, project, thinking_text, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?)`,
        ['session-1', 'test-project', 'analyzing the database schema for performance issues', now, nowEpoch]
      );

      const results = db.query(
        `SELECT rowid, thinking_text FROM thoughts_fts WHERE thoughts_fts MATCH 'database schema'`
      ).all() as Array<{ rowid: number; thinking_text: string }>;

      expect(results.length).toBe(1);
      expect(results[0].thinking_text).toContain('database schema');
    });

    it('should support full-text search on thinking_summary', () => {
      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      db.run(
        `INSERT INTO thoughts (memory_session_id, project, thinking_text, thinking_summary, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['session-1', 'test-project', 'some thinking text', 'performance optimization review', now, nowEpoch]
      );

      const results = db.query(
        `SELECT rowid, thinking_summary FROM thoughts_fts WHERE thoughts_fts MATCH 'performance optimization'`
      ).all() as Array<{ rowid: number; thinking_summary: string }>;

      expect(results.length).toBe(1);
      expect(results[0].thinking_summary).toContain('performance optimization');
    });
  });

  describe('FTS5 triggers', () => {
    it('should have INSERT trigger (thoughts_ai)', () => {
      const triggers = db.query(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name='thoughts_ai'`
      ).all();
      expect(triggers.length).toBe(1);
    });

    it('should have DELETE trigger (thoughts_ad)', () => {
      const triggers = db.query(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name='thoughts_ad'`
      ).all();
      expect(triggers.length).toBe(1);
    });

    it('should have UPDATE trigger (thoughts_au)', () => {
      const triggers = db.query(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name='thoughts_au'`
      ).all();
      expect(triggers.length).toBe(1);
    });

    it('should sync INSERT to FTS table via trigger', () => {
      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      db.run(
        `INSERT INTO thoughts (memory_session_id, project, thinking_text, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?)`,
        ['session-1', 'test-project', 'unique trigger insert test content', now, nowEpoch]
      );

      const results = db.query(
        `SELECT rowid FROM thoughts_fts WHERE thoughts_fts MATCH 'unique trigger insert'`
      ).all();
      expect(results.length).toBe(1);
    });

    it('should sync DELETE to FTS table via trigger', () => {
      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      db.run(
        `INSERT INTO thoughts (memory_session_id, project, thinking_text, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?)`,
        ['session-1', 'test-project', 'content to be deleted soon', now, nowEpoch]
      );

      // Verify it's in FTS
      let results = db.query(
        `SELECT rowid FROM thoughts_fts WHERE thoughts_fts MATCH 'deleted soon'`
      ).all();
      expect(results.length).toBe(1);

      // Delete the row
      db.run(`DELETE FROM thoughts WHERE memory_session_id = 'session-1'`);

      // Verify it's removed from FTS
      results = db.query(
        `SELECT rowid FROM thoughts_fts WHERE thoughts_fts MATCH 'deleted soon'`
      ).all();
      expect(results.length).toBe(0);
    });

    it('should sync UPDATE to FTS table via trigger (delete-then-insert)', () => {
      const now = new Date().toISOString();
      const nowEpoch = Date.now();

      db.run(
        `INSERT INTO thoughts (memory_session_id, project, thinking_text, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?)`,
        ['session-1', 'test-project', 'original thinking text before update', now, nowEpoch]
      );

      // Update the row
      db.run(
        `UPDATE thoughts SET thinking_text = 'updated thinking text after modification' WHERE memory_session_id = 'session-1'`
      );

      // Old content should not match
      const oldResults = db.query(
        `SELECT rowid FROM thoughts_fts WHERE thoughts_fts MATCH 'original thinking'`
      ).all();
      expect(oldResults.length).toBe(0);

      // New content should match
      const newResults = db.query(
        `SELECT rowid FROM thoughts_fts WHERE thoughts_fts MATCH 'updated thinking'`
      ).all();
      expect(newResults.length).toBe(1);
    });
  });

  describe('migration version', () => {
    it('should register as version 21 in schema_versions', () => {
      const versions = db.query(
        `SELECT version FROM schema_versions ORDER BY version`
      ).all() as Array<{ version: number }>;

      const versionNumbers = versions.map(v => v.version);
      expect(versionNumbers).toContain(21);
    });
  });
});
