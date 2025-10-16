#!/usr/bin/env bun
/**
 * Phase 3 Integration Tests
 * Tests the complete hook lifecycle and end-to-end integration
 *
 * Note: These tests verify database integration rather than calling hooks directly
 * since hooks call process.exit() which would terminate the test process
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { HooksDatabase } from '../src/services/sqlite/HooksDatabase.js';
import { DatabaseManager } from '../src/services/sqlite/Database.js';
import { migrations } from '../src/services/sqlite/migrations.js';
import fs from 'fs';
import path from 'path';

// Test database path
const TEST_DB_DIR = '/tmp/claude-mem-phase3-test';
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'claude-mem.db');

describe('Phase 3: Hook Database Integration', () => {
  beforeAll(async () => {
    // Create test directory
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });

    // Set test environment
    process.env.CLAUDE_MEM_DATA_DIR = TEST_DB_DIR;

    // Initialize database with migrations
    const dbManager = DatabaseManager.getInstance();
    migrations.forEach(m => dbManager.registerMigration(m));
    await dbManager.initialize();
    dbManager.close();
  });

  afterAll(() => {
    // Clean up test database and all files
    if (fs.existsSync(TEST_DB_DIR)) {
      const files = fs.readdirSync(TEST_DB_DIR);
      files.forEach(file => {
        fs.unlinkSync(path.join(TEST_DB_DIR, file));
      });
      fs.rmdirSync(TEST_DB_DIR);
    }
  });

  describe('HooksDatabase - Session Management', () => {
    it('should create and find SDK sessions', () => {
      const db = new HooksDatabase();

      const sessionId = db.createSDKSession(
        'test-claude-session-1',
        'my-project',
        'Implement authentication'
      );

      expect(sessionId).toBeGreaterThan(0);

      const found = db.findActiveSDKSession('test-claude-session-1');
      expect(found).not.toBeNull();
      expect(found!.project).toBe('my-project');
      expect(found!.id).toBe(sessionId);

      db.close();
    });

    it('should update SDK session ID', () => {
      const db = new HooksDatabase();

      const sessionId = db.createSDKSession(
        'test-claude-session-2',
        'my-project',
        'Test prompt'
      );

      db.updateSDKSessionId(sessionId, 'sdk-session-abc');

      const found = db.findActiveSDKSession('test-claude-session-2');
      expect(found!.sdk_session_id).toBe('sdk-session-abc');

      db.close();
    });

    it('should mark session as completed', () => {
      const db = new HooksDatabase();

      const sessionId = db.createSDKSession(
        'test-claude-session-3',
        'my-project',
        'Test prompt'
      );

      db.markSessionCompleted(sessionId);

      const found = db.findActiveSDKSession('test-claude-session-3');
      expect(found).toBeNull(); // Should not find active session

      db.close();
    });
  });

  describe('HooksDatabase - Observation Queue', () => {
    it('should queue and retrieve observations', () => {
      const db = new HooksDatabase();

      // Create session first (FK constraint requirement)
      const sessionId = db.createSDKSession('claude-queue-1', 'test-project', 'Test');
      db.updateSDKSessionId(sessionId, 'sdk-queue-test-1');

      db.queueObservation(
        'sdk-queue-test-1',
        'Read',
        JSON.stringify({ file_path: 'src/app.ts' }),
        JSON.stringify({ content: 'test content' })
      );

      const pending = db.getPendingObservations('sdk-queue-test-1', 10);
      expect(pending).toHaveLength(1);
      expect(pending[0].tool_name).toBe('Read');

      db.close();
    });

    it('should mark observations as processed', () => {
      const db = new HooksDatabase();

      // Create session first (FK constraint requirement)
      const sessionId = db.createSDKSession('claude-queue-2', 'test-project', 'Test');
      db.updateSDKSessionId(sessionId, 'sdk-queue-test-2');

      db.queueObservation(
        'sdk-queue-test-2',
        'Edit',
        JSON.stringify({ file_path: 'src/app.ts' }),
        JSON.stringify({ success: true })
      );

      const pending = db.getPendingObservations('sdk-queue-test-2', 10);
      expect(pending).toHaveLength(1);

      db.markObservationProcessed(pending[0].id);

      const stillPending = db.getPendingObservations('sdk-queue-test-2', 10);
      expect(stillPending).toHaveLength(0);

      db.close();
    });

    it('should queue FINALIZE messages', () => {
      const db = new HooksDatabase();

      // Create session first (FK constraint requirement)
      const sessionId = db.createSDKSession('claude-finalize', 'test-project', 'Test');
      db.updateSDKSessionId(sessionId, 'sdk-finalize-test');

      db.queueObservation('sdk-finalize-test', 'FINALIZE', '{}', '{}');

      const pending = db.getPendingObservations('sdk-finalize-test', 10);
      expect(pending).toHaveLength(1);
      expect(pending[0].tool_name).toBe('FINALIZE');

      db.close();
    });
  });

  describe('HooksDatabase - Observations Storage', () => {
    it('should store observations from SDK', () => {
      const db = new HooksDatabase();

      // Create session first (FK constraint requirement)
      const sessionId = db.createSDKSession('claude-obs-1', 'my-project', 'Test');
      db.updateSDKSessionId(sessionId, 'sdk-obs-test-1');

      db.storeObservation(
        'sdk-obs-test-1',
        'my-project',
        'feature',
        'Implemented JWT authentication'
      );

      const dbInstance = (db as any).db;
      const query = dbInstance.query('SELECT * FROM observations WHERE sdk_session_id = ?');
      const observations = query.all('sdk-obs-test-1');

      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe('feature');
      expect(observations[0].text).toBe('Implemented JWT authentication');

      db.close();
    });
  });

  describe('HooksDatabase - Summaries', () => {
    it('should store and retrieve summaries', () => {
      const db = new HooksDatabase();

      // Create session first (FK constraint requirement)
      const sessionId = db.createSDKSession('claude-summary-1', 'my-project', 'Test');
      db.updateSDKSessionId(sessionId, 'sdk-summary-test-1');

      db.storeSummary('sdk-summary-test-1', 'my-project', {
        request: 'Implement authentication',
        investigated: 'Existing patterns',
        learned: 'No JWT support',
        completed: 'Implemented JWT',
        next_steps: 'Add tests',
        files_read: JSON.stringify(['src/auth.ts']),
        files_edited: JSON.stringify(['src/auth.ts']),
        notes: 'Used bcrypt'
      });

      const summaries = db.getRecentSummaries('my-project', 10);
      expect(summaries.length).toBeGreaterThan(0);

      const summary = summaries.find(s => s.request === 'Implement authentication');
      expect(summary).not.toBeUndefined();
      expect(summary!.completed).toBe('Implemented JWT');

      db.close();
    });

    it('should return recent summaries only for specific project', () => {
      const db = new HooksDatabase();

      // Create sessions first (FK constraint requirement)
      const session1Id = db.createSDKSession('claude-proj-1', 'project-1', 'Test');
      db.updateSDKSessionId(session1Id, 'sdk-proj1');

      const session2Id = db.createSDKSession('claude-proj-2', 'project-2', 'Test');
      db.updateSDKSessionId(session2Id, 'sdk-proj2');

      db.storeSummary('sdk-proj1', 'project-1', {
        request: 'Feature for project 1',
        completed: 'Done'
      });

      db.storeSummary('sdk-proj2', 'project-2', {
        request: 'Feature for project 2',
        completed: 'Done'
      });

      const proj1Summaries = db.getRecentSummaries('project-1', 10);
      const proj2Summaries = db.getRecentSummaries('project-2', 10);

      expect(proj1Summaries.every(s => s.request?.includes('project 1'))).toBe(true);
      expect(proj2Summaries.every(s => s.request?.includes('project 2'))).toBe(true);

      db.close();
    });
  });
});

console.log('Running Phase 3 Integration Tests...');
