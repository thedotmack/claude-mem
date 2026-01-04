#!/usr/bin/env bun

/**
 * Verify Timestamp Fix
 *
 * This script verifies that the timestamp corruption has been properly fixed.
 * It checks for any remaining observations in the bad window that shouldn't be there.
 */

import Database from 'bun:sqlite';
import { resolve } from 'path';

const DB_PATH = resolve(process.env.HOME!, '.claude-mem/claude-mem.db');

// Bad window: Dec 24 19:45-20:31 (using actual epoch format from database)
const BAD_WINDOW_START = 1766623500000; // Dec 24 19:45 PST
const BAD_WINDOW_END = 1766626260000;   // Dec 24 20:31 PST

// Original corruption window: Dec 16-22 (when sessions actually started)
const ORIGINAL_WINDOW_START = 1765914000000; // Dec 16 00:00 PST
const ORIGINAL_WINDOW_END = 1766613600000;   // Dec 23 23:59 PST

interface Observation {
  id: number;
  memory_session_id: string;
  created_at_epoch: number;
  created_at: string;
  title: string;
}

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
  console.log('🔍 Verifying timestamp fix...\n');

  const db = new Database(DB_PATH);

  try {
    // Check 1: Observations still in bad window
    console.log('Check 1: Looking for observations still in bad window (Dec 24 19:45-20:31)...');
    const badWindowObs = db.query<Observation, []>(`
      SELECT id, memory_session_id, created_at_epoch, created_at, title
      FROM observations
      WHERE created_at_epoch >= ${BAD_WINDOW_START}
        AND created_at_epoch <= ${BAD_WINDOW_END}
      ORDER BY id
    `).all();

    if (badWindowObs.length === 0) {
      console.log('✅ No observations found in bad window - GOOD!\n');
    } else {
      console.log(`⚠️  Found ${badWindowObs.length} observations still in bad window:\n`);
      for (const obs of badWindowObs) {
        console.log(`  Observation #${obs.id}: ${obs.title || '(no title)'}`);
        console.log(`    Timestamp: ${formatTimestamp(obs.created_at_epoch)}`);
        console.log(`    Session: ${obs.memory_session_id}\n`);
      }
    }

    // Check 2: Observations now in original window
    console.log('Check 2: Counting observations in original window (Dec 17-20)...');
    const originalWindowObs = db.query<{ count: number }, []>(`
      SELECT COUNT(*) as count
      FROM observations
      WHERE created_at_epoch >= ${ORIGINAL_WINDOW_START}
        AND created_at_epoch <= ${ORIGINAL_WINDOW_END}
    `).get();

    console.log(`Found ${originalWindowObs?.count || 0} observations in Dec 17-20 window`);
    console.log('(These should be the corrected observations)\n');

    // Check 3: Session distribution
    console.log('Check 3: Session distribution of corrected observations...');
    const sessionDist = db.query<{ memory_session_id: string; count: number }, []>(`
      SELECT memory_session_id, COUNT(*) as count
      FROM observations
      WHERE created_at_epoch >= ${ORIGINAL_WINDOW_START}
        AND created_at_epoch <= ${ORIGINAL_WINDOW_END}
      GROUP BY memory_session_id
      ORDER BY count DESC
    `).all();

    if (sessionDist.length > 0) {
      console.log(`Observations distributed across ${sessionDist.length} sessions:\n`);
      for (const dist of sessionDist.slice(0, 10)) {
        console.log(`  ${dist.memory_session_id}: ${dist.count} observations`);
      }
      if (sessionDist.length > 10) {
        console.log(`  ... and ${sessionDist.length - 10} more sessions`);
      }
      console.log();
    }

    // Check 4: Pending messages processed count
    console.log('Check 4: Verifying processed pending_messages...');
    const processedCount = db.query<{ count: number }, []>(`
      SELECT COUNT(*) as count
      FROM pending_messages
      WHERE status = 'processed'
        AND completed_at_epoch >= ${BAD_WINDOW_START}
        AND completed_at_epoch <= ${BAD_WINDOW_END}
    `).get();

    console.log(`${processedCount?.count || 0} pending messages were processed during bad window\n`);

    // Summary
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('VERIFICATION SUMMARY:');
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    if (badWindowObs.length === 0 && (originalWindowObs?.count || 0) > 0) {
      console.log('✅ SUCCESS: Timestamp fix appears to be working correctly!');
      console.log(`   - No observations remain in bad window (Dec 24 19:45-20:31)`);
      console.log(`   - ${originalWindowObs?.count} observations restored to Dec 17-20`);
      console.log(`   - Processed ${processedCount?.count} pending messages`);
      console.log('\n💡 Safe to re-enable orphan processing in worker-service.ts\n');
    } else if (badWindowObs.length > 0) {
      console.log('⚠️  WARNING: Some observations still have incorrect timestamps!');
      console.log(`   - ${badWindowObs.length} observations still in bad window`);
      console.log('   - Run fix-corrupted-timestamps.ts again or investigate manually\n');
    } else {
      console.log('ℹ️  No corrupted observations detected');
      console.log('   - Either already fixed or corruption never occurred\n');
    }

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
