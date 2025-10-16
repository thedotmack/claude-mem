#!/usr/bin/env bun
/**
 * Test script for Phase 1 implementation
 * Tests database schema and hook functions
 */

import { DatabaseManager, migrations } from '../src/services/sqlite/index.js';
import { HooksDatabase } from '../src/services/sqlite/HooksDatabase.js';
import path from 'path';
import fs from 'fs';

async function testDatabaseSchema() {
  console.log('🧪 Testing Database Schema...\n');

  // Initialize database with migrations
  const manager = DatabaseManager.getInstance();
  for (const migration of migrations) {
    manager.registerMigration(migration);
  }

  const db = await manager.initialize();
  console.log('✅ Database initialized');

  // Check that migration 004 was applied
  const version = manager.getCurrentVersion();
  console.log(`✅ Current schema version: ${version}`);

  if (version < 4) {
    console.error('❌ Migration 004 was not applied!');
    process.exit(1);
  }

  // Verify tables exist
  const tables = [
    'sdk_sessions',
    'observation_queue',
    'observations',
    'session_summaries'
  ];

  for (const table of tables) {
    const query = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`);
    const result = query.get(table);
    if (!result) {
      console.error(`❌ Table ${table} does not exist!`);
      process.exit(1);
    }
    console.log(`✅ Table ${table} exists`);
  }

  console.log('\n✅ All schema tests passed!\n');
  // Don't close yet - keep connection for other tests
}

async function testHooksDatabase() {
  console.log('🧪 Testing Hooks Database...\n');

  const hooksDb = new HooksDatabase();

  // Clean up any existing test data first
  try {
    const manager = DatabaseManager.getInstance();
    const db = manager.getConnection();
    db.run('DELETE FROM session_summaries WHERE project = ?', ['test-project']);
    db.run('DELETE FROM observations WHERE project = ?', ['test-project']);
    db.run('DELETE FROM observation_queue WHERE sdk_session_id LIKE ?', ['test-sdk-session-id%']);
    db.run('DELETE FROM sdk_sessions WHERE project = ? OR claude_session_id = ?', ['test-project', 'test-claude-session-1']);
  } catch (error) {
    // Ignore cleanup errors
  }

  // Test creating an SDK session
  const sessionId = hooksDb.createSDKSession(
    'test-claude-session-1',
    'test-project',
    'Test user prompt'
  );
  console.log(`✅ Created SDK session with ID: ${sessionId}`);

  // Test finding active session
  const found = hooksDb.findActiveSDKSession('test-claude-session-1');
  if (!found || found.id !== sessionId) {
    console.error('❌ Could not find created session!');
    process.exit(1);
  }
  console.log(`✅ Found active session: ${found.project}`);

  // Test updating SDK session ID
  hooksDb.updateSDKSessionId(sessionId, 'test-sdk-session-id');
  const updated = hooksDb.findActiveSDKSession('test-claude-session-1');
  if (!updated || updated.sdk_session_id !== 'test-sdk-session-id') {
    console.error('❌ SDK session ID was not updated!');
    process.exit(1);
  }
  console.log(`✅ Updated SDK session ID: ${updated.sdk_session_id}`);

  // Test queuing observation
  hooksDb.queueObservation(
    'test-sdk-session-id',
    'Read',
    '{"file_path": "test.ts"}',
    '{"content": "test content"}'
  );
  console.log('✅ Queued observation');

  // Test getting pending observations
  const pending = hooksDb.getPendingObservations('test-sdk-session-id', 10);
  if (pending.length !== 1) {
    console.error('❌ Expected 1 pending observation!');
    process.exit(1);
  }
  console.log(`✅ Found ${pending.length} pending observation(s)`);

  // Test marking observation as processed
  hooksDb.markObservationProcessed(pending[0].id);
  const stillPending = hooksDb.getPendingObservations('test-sdk-session-id', 10);
  if (stillPending.length !== 0) {
    console.error('❌ Observation was not marked as processed!');
    process.exit(1);
  }
  console.log('✅ Marked observation as processed');

  // Test storing observation
  hooksDb.storeObservation(
    'test-sdk-session-id',
    'test-project',
    'feature',
    'Implemented test feature'
  );
  console.log('✅ Stored observation');

  // Test storing summary
  hooksDb.storeSummary(
    'test-sdk-session-id',
    'test-project',
    {
      request: 'Test request',
      completed: 'Test completed',
      learned: 'Test learned',
      next_steps: 'Test next steps',
      files_edited: '["test.ts"]'
    }
  );
  console.log('✅ Stored summary');

  // Test getting recent summaries
  const summaries = hooksDb.getRecentSummaries('test-project', 10);
  if (summaries.length !== 1) {
    console.error('❌ Expected 1 summary!');
    process.exit(1);
  }
  console.log(`✅ Found ${summaries.length} summary(ies)`);
  console.log(`   Request: ${summaries[0].request}`);

  // Test marking session as completed
  hooksDb.markSessionCompleted(sessionId);
  const completed = hooksDb.findActiveSDKSession('test-claude-session-1');
  if (completed) {
    console.error('❌ Session should not be active after completion!');
    process.exit(1);
  }
  console.log('✅ Marked session as completed');

  hooksDb.close();
  console.log('\n✅ All hooks database tests passed!\n');
}

async function cleanup() {
  console.log('🧹 Cleaning up test data...\n');

  try {
    const manager = DatabaseManager.getInstance();
    const db = manager.getConnection();

    // Clean up test data
    db.run('DELETE FROM session_summaries WHERE project = ?', ['test-project']);
    db.run('DELETE FROM observations WHERE project = ?', ['test-project']);
    db.run('DELETE FROM observation_queue WHERE sdk_session_id = ?', ['test-sdk-session-id']);
    db.run('DELETE FROM sdk_sessions WHERE project = ?', ['test-project']);

    console.log('✅ Test data cleaned up\n');
    manager.close();
  } catch (error: any) {
    // Database might already be closed, that's okay
    console.log('✅ Test data cleanup skipped (database already closed)\n');
  }
}

// Run tests
(async () => {
  try {
    await testDatabaseSchema();
    await testHooksDatabase();
    await cleanup();

    console.log('🎉 Phase 1 implementation tests passed!\n');
    process.exit(0);
  } catch (error: any) {
    console.error(`\n❌ Test failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
})();
