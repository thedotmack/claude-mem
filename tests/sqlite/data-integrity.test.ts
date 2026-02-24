/**
 * Data integrity tests for TRIAGE-03
 * Tests: content-hash deduplication, project name collision, empty project guard, stuck isProcessing
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  storeObservation,
  computeObservationContentHash,
  findDuplicateObservation,
} from '../../src/services/sqlite/observations/store.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import { storeObservations } from '../../src/services/sqlite/transactions.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';

function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    type: 'discovery',
    title: 'Test Observation',
    subtitle: 'Test Subtitle',
    facts: ['fact1', 'fact2'],
    narrative: 'Test narrative content',
    concepts: ['concept1', 'concept2'],
    files_read: ['/path/to/file1.ts'],
    files_modified: ['/path/to/file2.ts'],
    ...overrides,
  };
}

function createSessionWithMemoryId(db: Database, contentSessionId: string, memorySessionId: string, project: string = 'test-project'): string {
  const sessionId = createSDKSession(db, contentSessionId, project, 'initial prompt');
  updateMemorySessionId(db, sessionId, memorySessionId);
  return memorySessionId;
}

describe('TRIAGE-03: Data Integrity', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  describe('Content-hash deduplication', () => {
    it('computeObservationContentHash produces consistent hashes', () => {
      const hash1 = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
      const hash2 = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(16);
    });

    it('computeObservationContentHash produces different hashes for different content', () => {
      const hash1 = computeObservationContentHash('session-1', 'Title A', 'Narrative A');
      const hash2 = computeObservationContentHash('session-1', 'Title B', 'Narrative B');
      expect(hash1).not.toBe(hash2);
    });

    it('computeObservationContentHash handles nulls', () => {
      const hash = computeObservationContentHash('session-1', null, null);
      expect(hash.length).toBe(16);
    });

    it('storeObservation deduplicates identical observations within 30s window', () => {
      const memId = createSessionWithMemoryId(db, 'content-dedup-1', 'mem-dedup-1');
      const obs = createObservationInput({ title: 'Same Title', narrative: 'Same Narrative' });

      const now = Date.now();
      const result1 = storeObservation(db, memId, 'test-project', obs, 1, 0, now);
      const result2 = storeObservation(db, memId, 'test-project', obs, 1, 0, now + 1000);

      // Second call should return the same id as the first (deduped)
      expect(result2.id).toBe(result1.id);
    });

    it('storeObservation allows same content after dedup window expires', () => {
      const memId = createSessionWithMemoryId(db, 'content-dedup-2', 'mem-dedup-2');
      const obs = createObservationInput({ title: 'Same Title', narrative: 'Same Narrative' });

      const now = Date.now();
      const result1 = storeObservation(db, memId, 'test-project', obs, 1, 0, now);
      // 31 seconds later — outside the 30s window
      const result2 = storeObservation(db, memId, 'test-project', obs, 1, 0, now + 31_000);

      expect(result2.id).not.toBe(result1.id);
    });

    it('storeObservation allows different content at same time', () => {
      const memId = createSessionWithMemoryId(db, 'content-dedup-3', 'mem-dedup-3');
      const obs1 = createObservationInput({ title: 'Title A', narrative: 'Narrative A' });
      const obs2 = createObservationInput({ title: 'Title B', narrative: 'Narrative B' });

      const now = Date.now();
      const result1 = storeObservation(db, memId, 'test-project', obs1, 1, 0, now);
      const result2 = storeObservation(db, memId, 'test-project', obs2, 1, 0, now);

      expect(result2.id).not.toBe(result1.id);
    });

    it('content_hash column is populated on new observations', () => {
      const memId = createSessionWithMemoryId(db, 'content-hash-col', 'mem-hash-col');
      const obs = createObservationInput();

      storeObservation(db, memId, 'test-project', obs);

      const row = db.prepare('SELECT content_hash FROM observations LIMIT 1').get() as { content_hash: string };
      expect(row.content_hash).toBeTruthy();
      expect(row.content_hash.length).toBe(16);
    });
  });

  describe('Transaction-level deduplication', () => {
    it('storeObservations deduplicates within a batch', () => {
      const memId = createSessionWithMemoryId(db, 'content-tx-1', 'mem-tx-1');
      const obs = createObservationInput({ title: 'Duplicate', narrative: 'Same content' });

      const result = storeObservations(db, memId, 'test-project', [obs, obs, obs], null);

      // First is inserted, second and third are deduped to the first
      expect(result.observationIds.length).toBe(3);
      expect(result.observationIds[1]).toBe(result.observationIds[0]);
      expect(result.observationIds[2]).toBe(result.observationIds[0]);

      // Only 1 row in the database
      const count = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      expect(count.count).toBe(1);
    });
  });

  describe('Empty project string guard', () => {
    it('storeObservation replaces empty project with cwd-derived name', () => {
      const memId = createSessionWithMemoryId(db, 'content-empty-proj', 'mem-empty-proj');
      const obs = createObservationInput();

      const result = storeObservation(db, memId, '', obs);
      const row = db.prepare('SELECT project FROM observations WHERE id = ?').get(result.id) as { project: string };

      // Should not be empty — will be derived from cwd
      expect(row.project).toBeTruthy();
      expect(row.project.length).toBeGreaterThan(0);
    });
  });

  describe('Stuck isProcessing flag', () => {
    it('hasAnyPendingWork resets stuck processing messages older than 5 minutes', () => {
      // Create a pending_messages table entry that's stuck in 'processing'
      const sessionId = createSDKSession(db, 'content-stuck', 'stuck-project', 'test');

      // Insert a processing message stuck for 6 minutes
      const sixMinutesAgo = Date.now() - (6 * 60 * 1000);
      db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, retry_count, created_at_epoch, started_processing_at_epoch)
        VALUES (?, 'content-stuck', 'observation', 'processing', 0, ?, ?)
      `).run(sessionId, sixMinutesAgo, sixMinutesAgo);

      const pendingStore = new PendingMessageStore(db);

      // hasAnyPendingWork should reset the stuck message and still return true (it's now pending again)
      const hasPending = pendingStore.hasAnyPendingWork();
      expect(hasPending).toBe(true);

      // Verify the message was reset to 'pending'
      const msg = db.prepare('SELECT status FROM pending_messages WHERE content_session_id = ?').get('content-stuck') as { status: string };
      expect(msg.status).toBe('pending');
    });

    it('hasAnyPendingWork does NOT reset recently-started processing messages', () => {
      const sessionId = createSDKSession(db, 'content-recent', 'recent-project', 'test');

      // Insert a processing message started 1 minute ago (well within 5-minute threshold)
      const oneMinuteAgo = Date.now() - (1 * 60 * 1000);
      db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, retry_count, created_at_epoch, started_processing_at_epoch)
        VALUES (?, 'content-recent', 'observation', 'processing', 0, ?, ?)
      `).run(sessionId, oneMinuteAgo, oneMinuteAgo);

      const pendingStore = new PendingMessageStore(db);
      const hasPending = pendingStore.hasAnyPendingWork();
      expect(hasPending).toBe(true);

      // Verify the message is still 'processing' (not reset)
      const msg = db.prepare('SELECT status FROM pending_messages WHERE content_session_id = ?').get('content-recent') as { status: string };
      expect(msg.status).toBe('processing');
    });

    it('hasAnyPendingWork returns false when no pending or processing messages exist', () => {
      const pendingStore = new PendingMessageStore(db);
      expect(pendingStore.hasAnyPendingWork()).toBe(false);
    });
  });
});
