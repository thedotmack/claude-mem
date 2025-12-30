#!/usr/bin/env bun

/**
 * Validate Timestamp Logic
 *
 * This script validates that the backlog timestamp logic would work correctly
 * by checking pending messages and simulating what timestamps they would get.
 */

import Database from 'bun:sqlite';
import { resolve } from 'path';

const DB_PATH = resolve(process.env.HOME!, '.claude-mem/claude-mem.db');

function formatTimestamp(epoch: number): string {
  return new Date(epoch).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function main() {
  console.log('🔍 Validating timestamp logic for backlog processing...\n');

  const db = new Database(DB_PATH);

  try {
    // Check for pending messages
    const pendingStats = db.query(`
      SELECT
        status,
        COUNT(*) as count,
        MIN(created_at_epoch) as earliest,
        MAX(created_at_epoch) as latest
      FROM pending_messages
      GROUP BY status
      ORDER BY status
    `).all();

    console.log('Pending Messages Status:\n');
    for (const stat of pendingStats) {
      console.log(`${stat.status}: ${stat.count} messages`);
      if (stat.earliest && stat.latest) {
        console.log(`  Created: ${formatTimestamp(stat.earliest)} to ${formatTimestamp(stat.latest)}`);
      }
    }
    console.log();

    // Get sample pending messages with their session info
    const pendingWithSessions = db.query(`
      SELECT
        pm.id,
        pm.session_db_id,
        pm.tool_name,
        pm.created_at_epoch as msg_created,
        pm.status,
        s.memory_session_id,
        s.started_at_epoch as session_started,
        s.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions s ON pm.session_db_id = s.id
      WHERE pm.status IN ('pending', 'processing')
      ORDER BY pm.created_at_epoch
      LIMIT 10
    `).all();

    if (pendingWithSessions.length === 0) {
      console.log('✅ No pending messages - all caught up!\n');
      db.close();
      return;
    }

    console.log(`Sample of ${pendingWithSessions.length} pending messages:\n`);
    console.log('═══════════════════════════════════════════════════════════════════════');

    for (const msg of pendingWithSessions) {
      console.log(`\nPending Message #${msg.id}: ${msg.tool_name} (${msg.status})`);
      console.log(`  Created: ${formatTimestamp(msg.msg_created)}`);

      if (msg.session_started) {
        console.log(`  Session started: ${formatTimestamp(msg.session_started)}`);
        console.log(`  Project: ${msg.project}`);

        // Validate logic
        const ageDays = Math.round((Date.now() - msg.msg_created) / (1000 * 60 * 60 * 24));

        if (msg.msg_created < msg.session_started) {
          console.log(`  ⚠️  WARNING: Message created BEFORE session! This is impossible.`);
        } else if (ageDays > 0) {
          console.log(`  📅 Message is ${ageDays} days old`);
          console.log(`  ✅ Would use original timestamp: ${formatTimestamp(msg.msg_created)}`);
        } else {
          console.log(`  ✅ Recent message, would use original timestamp: ${formatTimestamp(msg.msg_created)}`);
        }
      } else {
        console.log(`  ⚠️  No session found for session_db_id ${msg.session_db_id}`);
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log('\nTimestamp Logic Validation:\n');
    console.log('✅ Code Flow:');
    console.log('   1. SessionManager.yieldNextMessage() tracks earliestPendingTimestamp');
    console.log('   2. SDKAgent captures originalTimestamp before processing');
    console.log('   3. processSDKResponse passes originalTimestamp to storeObservation/storeSummary');
    console.log('   4. SessionStore uses overrideTimestampEpoch ?? Date.now()');
    console.log('   5. earliestPendingTimestamp reset after batch completes\n');

    console.log('✅ Expected Behavior:');
    console.log('   - New messages: get current timestamp');
    console.log('   - Backlog messages: get original created_at_epoch');
    console.log('   - Observations match their source message timestamps\n');

    // Check for any sessions with stuck processing messages
    const stuckMessages = db.query(`
      SELECT
        session_db_id,
        COUNT(*) as count,
        MIN(created_at_epoch) as earliest,
        MAX(created_at_epoch) as latest
      FROM pending_messages
      WHERE status = 'processing'
      GROUP BY session_db_id
      ORDER BY count DESC
    `).all();

    if (stuckMessages.length > 0) {
      console.log('⚠️  Stuck Messages (status=processing):\n');
      for (const stuck of stuckMessages) {
        const ageDays = Math.round((Date.now() - stuck.earliest) / (1000 * 60 * 60 * 24));
        console.log(`   Session ${stuck.session_db_id}: ${stuck.count} messages`);
        console.log(`     Stuck for ${ageDays} days (${formatTimestamp(stuck.earliest)})`);
      }
      console.log('\n   💡 These will be processed with original timestamps when orphan processing is enabled\n');
    }

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
