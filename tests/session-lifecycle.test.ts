#!/usr/bin/env bun
/**
 * Phase 3 End-to-End Lifecycle Test
 * Simulates a complete Claude Code session lifecycle through database operations
 *
 * This test verifies that all hook database operations work together correctly
 * to support a full session from initialization to summary generation
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { HooksDatabase } from '../src/services/sqlite/HooksDatabase.js';
import { DatabaseManager } from '../src/services/sqlite/Database.js';
import { migrations } from '../src/services/sqlite/migrations.js';
import fs from 'fs';
import path from 'path';

// Test database path
const TEST_DB_DIR = '/tmp/claude-mem-e2e-test';

describe('Phase 3: End-to-End Lifecycle', () => {
  beforeAll(async () => {
    // Clean up any existing test directory
    if (fs.existsSync(TEST_DB_DIR)) {
      const files = fs.readdirSync(TEST_DB_DIR);
      files.forEach(file => {
        fs.unlinkSync(path.join(TEST_DB_DIR, file));
      });
      fs.rmdirSync(TEST_DB_DIR);
    }

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

  it('should complete full session lifecycle', () => {
    const claudeSessionId = 'e2e-session-1';
    const project = 'my-app';
    const userPrompt = 'Implement user authentication with JWT';

    // Step 1: Create SDK session (simulates newHook)
    console.log('\n=== Step 1: Initialize Session ===');
    let db = new HooksDatabase();
    const sessionId = db.createSDKSession(claudeSessionId, project, userPrompt);
    expect(sessionId).toBeGreaterThan(0);

    const session = db.findActiveSDKSession(claudeSessionId);
    expect(session).not.toBeNull();
    expect(session!.project).toBe(project);

    // Simulate SDK worker capturing session ID
    db.updateSDKSessionId(sessionId, 'sdk-e2e-1');
    db.close();

    // Step 2: Queue multiple observations (simulates saveHook)
    console.log('\n=== Step 2: Queue Observations ===');
    db = new HooksDatabase();

    const observations = [
      { tool: 'Read', input: { file_path: 'src/auth.ts' }, output: { content: 'export function login() {}' } },
      { tool: 'Edit', input: { file_path: 'src/auth.ts' }, output: { success: true } },
      { tool: 'Write', input: { file_path: 'src/middleware/auth.ts' }, output: { success: true } },
      { tool: 'Bash', input: { command: 'npm install jsonwebtoken' }, output: { stdout: 'added 1 package' } },
      { tool: 'Read', input: { file_path: 'package.json' }, output: { content: '{"dependencies": {}}' } }
    ];

    for (const obs of observations) {
      db.queueObservation(
        'sdk-e2e-1',
        obs.tool,
        JSON.stringify(obs.input),
        JSON.stringify(obs.output)
      );
    }

    const pending = db.getPendingObservations('sdk-e2e-1', 100);
    expect(pending.length).toBe(observations.length);
    db.close();

    // Step 3: Process observations (simulates SDK worker)
    console.log('\n=== Step 3: Process Observations ===');
    db = new HooksDatabase();

    for (const obs of pending) {
      // Simulate SDK extracting meaningful observations
      if (obs.tool_name === 'Edit' || obs.tool_name === 'Write') {
        db.storeObservation(
          'sdk-e2e-1',
          project,
          'feature',
          `Modified ${JSON.parse(obs.tool_input).file_path}`
        );
      }

      db.markObservationProcessed(obs.id);
    }

    const stillPending = db.getPendingObservations('sdk-e2e-1', 100);
    expect(stillPending.length).toBe(0);
    db.close();

    // Step 4: Queue FINALIZE message (simulates summaryHook)
    console.log('\n=== Step 4: Queue FINALIZE ===');
    db = new HooksDatabase();
    db.queueObservation('sdk-e2e-1', 'FINALIZE', '{}', '{}');

    const finalizeMsg = db.getPendingObservations('sdk-e2e-1', 100);
    expect(finalizeMsg.length).toBe(1);
    expect(finalizeMsg[0].tool_name).toBe('FINALIZE');
    db.close();

    // Step 5: Generate summary (simulates SDK worker finalization)
    console.log('\n=== Step 5: Generate Summary ===');
    db = new HooksDatabase();

    db.storeSummary('sdk-e2e-1', project, {
      request: 'Implement user authentication with JWT',
      investigated: 'Existing auth.ts file and authentication patterns',
      learned: 'Current system had basic login function without JWT support',
      completed: 'Implemented JWT-based authentication with login function and auth middleware',
      next_steps: 'Add token refresh mechanism and write unit tests',
      files_read: JSON.stringify(['src/auth.ts', 'package.json']),
      files_edited: JSON.stringify(['src/auth.ts', 'src/middleware/auth.ts']),
      notes: 'Installed jsonwebtoken package for JWT support'
    });

    db.markSessionCompleted(sessionId);
    db.close();

    // Verify summary stored
    db = new HooksDatabase();
    const summaries = db.getRecentSummaries(project, 10);
    expect(summaries.length).toBe(1);
    expect(summaries[0].request).toBe('Implement user authentication with JWT');
    expect(summaries[0].completed).toContain('JWT-based authentication');
    db.close();

    // Step 6: Retrieve context for next session (simulates contextHook)
    console.log('\n=== Step 6: Retrieve Context ===');
    db = new HooksDatabase();
    const contextSummaries = db.getRecentSummaries(project, 5);

    expect(contextSummaries.length).toBeGreaterThan(0);
    expect(contextSummaries[0].request).toBe('Implement user authentication with JWT');
    expect(contextSummaries[0].files_edited).toContain('src/auth.ts');

    // Verify session is no longer active
    const completedSession = db.findActiveSDKSession(claudeSessionId);
    expect(completedSession).toBeNull();

    db.close();

    console.log('\n✅ End-to-end lifecycle test passed!');
  });

  it('should handle performance requirements (< 50ms per operation)', () => {
    const db = new HooksDatabase();

    // Create session
    const sessionId = db.createSDKSession('perf-test', 'perf-project', 'Test');
    db.updateSDKSessionId(sessionId, 'sdk-perf-1');

    // Test queue observation performance
    const iterations = 20;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();

      db.queueObservation(
        'sdk-perf-1',
        'Read',
        JSON.stringify({ file_path: `test-${i}.ts` }),
        JSON.stringify({ content: 'test' })
      );

      const duration = performance.now() - start;
      times.push(duration);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTime = Math.max(...times);

    console.log(`\nPerformance Results:`);
    console.log(`  Average time: ${avgTime.toFixed(2)}ms`);
    console.log(`  Max time: ${maxTime.toFixed(2)}ms`);

    // Should be well under 50ms requirement
    expect(avgTime).toBeLessThan(50);
    expect(maxTime).toBeLessThan(100);

    db.close();
  });

  it('should handle interrupted sessions gracefully', () => {
    const db = new HooksDatabase();

    // Create session
    const sessionId = db.createSDKSession(
      'interrupt-test',
      'interrupt-project',
      'Test interruption'
    );
    db.updateSDKSessionId(sessionId, 'sdk-interrupt-1');

    // Queue some observations
    for (let i = 0; i < 5; i++) {
      db.queueObservation(
        'sdk-interrupt-1',
        'Read',
        JSON.stringify({ file_path: `file-${i}.ts` }),
        JSON.stringify({ content: `content ${i}` })
      );
    }

    // Simulate user interruption (no FINALIZE message)
    // Observations should remain in queue
    const pending = db.getPendingObservations('sdk-interrupt-1', 100);
    expect(pending.length).toBe(5);

    // Session should still be active
    const stillActive = db.findActiveSDKSession('interrupt-test');
    expect(stillActive).not.toBeNull();

    db.close();

    console.log('\n✅ Interrupted session test passed!');
  });

  it('should support multiple concurrent projects', () => {
    const db = new HooksDatabase();

    // Create sessions for different projects
    const proj1Id = db.createSDKSession('session-proj1', 'project-1', 'Feature A');
    const proj2Id = db.createSDKSession('session-proj2', 'project-2', 'Feature B');

    db.updateSDKSessionId(proj1Id, 'sdk-proj1');
    db.updateSDKSessionId(proj2Id, 'sdk-proj2');

    // Store summaries for each project
    db.storeSummary('sdk-proj1', 'project-1', {
      request: 'Feature A for project 1',
      completed: 'Implemented feature A'
    });

    db.storeSummary('sdk-proj2', 'project-2', {
      request: 'Feature B for project 2',
      completed: 'Implemented feature B'
    });

    // Retrieve summaries - should be project-specific
    const proj1Summaries = db.getRecentSummaries('project-1', 10);
    const proj2Summaries = db.getRecentSummaries('project-2', 10);

    expect(proj1Summaries.length).toBeGreaterThan(0);
    expect(proj2Summaries.length).toBeGreaterThan(0);

    expect(proj1Summaries[0].request).toContain('project 1');
    expect(proj2Summaries[0].request).toContain('project 2');

    db.close();

    console.log('\n✅ Multiple projects test passed!');
  });
});

console.log('Running Phase 3 End-to-End Tests...');
