#!/usr/bin/env bun
/**
 * Phase 2 End-to-End Tests
 * Tests SDK prompts, parser, and integration with HooksDatabase
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { buildInitPrompt, buildObservationPrompt, buildFinalizePrompt } from '../src/sdk/prompts.js';
import { parseObservations, parseSummary } from '../src/sdk/parser.js';
import { HooksDatabase } from '../src/services/sqlite/HooksDatabase.js';
import { DatabaseManager } from '../src/services/sqlite/Database.js';
import { migrations } from '../src/services/sqlite/migrations.js';
import fs from 'fs';
import path from 'path';

// Test database path
const TEST_DB_DIR = '/tmp/claude-mem-test';
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'claude-mem.db');

describe('SDK Prompts', () => {
  it('should build init prompt with all required sections', () => {
    const prompt = buildInitPrompt('test-project', 'session-123', 'Implement JWT auth');

    expect(prompt).toContain('test-project');
    expect(prompt).toContain('session-123');
    expect(prompt).toContain('Implement JWT auth');
    expect(prompt).toContain('SESSION CONTEXT');
    expect(prompt).toContain('YOUR ROLE');
    expect(prompt).toContain('WHAT TO CAPTURE');
    expect(prompt).toContain('HOW TO STORE OBSERVATIONS');
    expect(prompt).toContain('<observation>');
    expect(prompt).toContain('<type>');
    expect(prompt).toContain('<text>');
  });

  it('should build observation prompt with tool details', () => {
    const obs = {
      id: 1,
      tool_name: 'Edit',
      tool_input: JSON.stringify({ file: 'src/auth.ts' }),
      tool_output: JSON.stringify({ success: true }),
      created_at_epoch: Date.now()
    };

    const prompt = buildObservationPrompt(obs);

    expect(prompt).toContain('TOOL OBSERVATION');
    expect(prompt).toContain('Edit');
    expect(prompt).toContain('src/auth.ts');
    expect(prompt).toContain('ANALYSIS TASK');
  });

  it('should build finalize prompt with session context', () => {
    const session = {
      id: 1,
      sdk_session_id: 'sdk-123',
      project: 'test-project',
      user_prompt: 'Implement JWT auth'
    };

    const prompt = buildFinalizePrompt(session);

    expect(prompt).toContain('SESSION ENDING');
    expect(prompt).toContain('FINAL TASK');
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('<request>');
    expect(prompt).toContain('<files_read>');
  });
});

describe('XML Parser', () => {
  describe('parseObservations', () => {
    it('should parse single observation', () => {
      const text = `
        <observation>
          <type>feature</type>
          <text>Implemented JWT token refresh flow</text>
        </observation>
      `;

      const observations = parseObservations(text);

      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe('feature');
      expect(observations[0].text).toBe('Implemented JWT token refresh flow');
    });

    it('should parse multiple observations', () => {
      const text = `
        <observation>
          <type>feature</type>
          <text>Implemented JWT token refresh flow</text>
        </observation>
        <observation>
          <type>bugfix</type>
          <text>Fixed race condition in auth middleware</text>
        </observation>
      `;

      const observations = parseObservations(text);

      expect(observations).toHaveLength(2);
      expect(observations[0].type).toBe('feature');
      expect(observations[1].type).toBe('bugfix');
    });

    it('should skip observations with invalid types', () => {
      const text = `
        <observation>
          <type>invalid-type</type>
          <text>This should be skipped</text>
        </observation>
        <observation>
          <type>feature</type>
          <text>This should be kept</text>
        </observation>
      `;

      const observations = parseObservations(text);

      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe('feature');
    });

    it('should handle observations with surrounding text', () => {
      const text = `
        I analyzed the code and found something interesting:

        <observation>
          <type>discovery</type>
          <text>API rate limit is 100 requests per minute</text>
        </observation>

        This is an important finding.
      `;

      const observations = parseObservations(text);

      expect(observations).toHaveLength(1);
      expect(observations[0].type).toBe('discovery');
    });
  });

  describe('parseSummary', () => {
    it('should parse complete summary with all fields', () => {
      const text = `
        <summary>
          <request>Implement JWT authentication system</request>
          <investigated>Existing auth middleware, session management</investigated>
          <learned>Current system uses session cookies; no JWT support</learned>
          <completed>Implemented JWT token + refresh flow with 7-day expiry</completed>
          <next_steps>Add token revocation API endpoint; write integration tests</next_steps>
          <files_read>
            <file>src/auth.ts</file>
            <file>src/middleware/session.ts</file>
          </files_read>
          <files_edited>
            <file>src/auth.ts</file>
            <file>src/middleware/auth.ts</file>
          </files_edited>
          <notes>Token secret stored in .env</notes>
        </summary>
      `;

      const summary = parseSummary(text);

      expect(summary).not.toBeNull();
      expect(summary!.request).toBe('Implement JWT authentication system');
      expect(summary!.investigated).toBe('Existing auth middleware, session management');
      expect(summary!.learned).toBe('Current system uses session cookies; no JWT support');
      expect(summary!.completed).toBe('Implemented JWT token + refresh flow with 7-day expiry');
      expect(summary!.next_steps).toBe('Add token revocation API endpoint; write integration tests');
      expect(summary!.files_read).toEqual(['src/auth.ts', 'src/middleware/session.ts']);
      expect(summary!.files_edited).toEqual(['src/auth.ts', 'src/middleware/auth.ts']);
      expect(summary!.notes).toBe('Token secret stored in .env');
    });

    it('should handle empty file arrays', () => {
      const text = `
        <summary>
          <request>Research API documentation</request>
          <investigated>API endpoints and authentication methods</investigated>
          <learned>API uses OAuth 2.0</learned>
          <completed>Documented authentication flow</completed>
          <next_steps>Implement OAuth client</next_steps>
          <files_read></files_read>
          <files_edited></files_edited>
          <notes>Documentation is incomplete</notes>
        </summary>
      `;

      const summary = parseSummary(text);

      expect(summary).not.toBeNull();
      expect(summary!.files_read).toEqual([]);
      expect(summary!.files_edited).toEqual([]);
    });

    it('should return null if required fields are missing', () => {
      const text = `
        <summary>
          <request>Implement JWT authentication system</request>
          <investigated>Existing auth middleware</investigated>
        </summary>
      `;

      const summary = parseSummary(text);

      expect(summary).toBeNull();
    });

    it('should return null if no summary block found', () => {
      const text = 'This is just regular text without a summary.';

      const summary = parseSummary(text);

      expect(summary).toBeNull();
    });
  });
});

describe('HooksDatabase Integration', () => {
  let db: HooksDatabase;

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

  it('should store and retrieve observations', () => {
    db = new HooksDatabase();

    // Create session
    const sessionId = db.createSDKSession('claude-123', 'test-project', 'Test prompt');
    db.updateSDKSessionId(sessionId, 'sdk-123');

    // Store observation
    db.storeObservation('sdk-123', 'test-project', 'feature', 'Implemented JWT auth');

    // Verify storage
    const dbInstance = (db as any).db;
    const query = dbInstance.query('SELECT * FROM observations WHERE sdk_session_id = ?');
    const observations = query.all('sdk-123');

    expect(observations).toHaveLength(1);
    expect(observations[0].type).toBe('feature');
    expect(observations[0].text).toBe('Implemented JWT auth');
    expect(observations[0].project).toBe('test-project');

    db.close();
  });

  it('should store and retrieve summaries', () => {
    db = new HooksDatabase();

    // Create session
    const sessionId = db.createSDKSession('claude-456', 'test-project', 'Test prompt');
    db.updateSDKSessionId(sessionId, 'sdk-456');

    // Store summary
    const summaryData = {
      request: 'Implement feature',
      investigated: 'Existing code',
      learned: 'Found patterns',
      completed: 'Implemented feature',
      next_steps: 'Add tests',
      files_read: JSON.stringify(['src/app.ts']),
      files_edited: JSON.stringify(['src/app.ts']),
      notes: 'Used TypeScript'
    };

    db.storeSummary('sdk-456', 'test-project', summaryData);

    // Verify storage
    const summaries = db.getRecentSummaries('test-project', 10);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].request).toBe('Implement feature');
    expect(summaries[0].completed).toBe('Implemented feature');

    db.close();
  });

  it('should queue and process observations', () => {
    db = new HooksDatabase();

    // Create session
    const sessionId = db.createSDKSession('claude-789', 'test-project', 'Test prompt');
    db.updateSDKSessionId(sessionId, 'sdk-789');

    // Queue observation
    db.queueObservation(
      'sdk-789',
      'Edit',
      JSON.stringify({ file: 'src/auth.ts' }),
      JSON.stringify({ success: true })
    );

    // Get pending observations
    const pending = db.getPendingObservations('sdk-789', 10);

    expect(pending).toHaveLength(1);
    expect(pending[0].tool_name).toBe('Edit');

    // Mark as processed
    db.markObservationProcessed(pending[0].id);

    // Verify no pending observations
    const pendingAfter = db.getPendingObservations('sdk-789', 10);
    expect(pendingAfter).toHaveLength(0);

    db.close();
  });
});

console.log('Running Phase 2 Tests...');
