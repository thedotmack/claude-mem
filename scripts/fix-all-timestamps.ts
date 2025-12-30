#!/usr/bin/env bun

/**
 * Fix ALL Corrupted Observation Timestamps
 *
 * This script finds and repairs ALL observations with timestamps that don't match
 * their session start times, not just ones in an arbitrary "bad window".
 */

import Database from 'bun:sqlite';
import { resolve } from 'path';

const DB_PATH = resolve(process.env.HOME!, '.claude-mem/claude-mem.db');

interface CorruptedObservation {
  obs_id: number;
  obs_title: string;
  obs_created: number;
  session_started: number;
  session_completed: number | null;
  memory_session_id: string;
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
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const autoYes = args.includes('--yes') || args.includes('-y');

  console.log('🔍 Finding ALL observations with timestamp corruption...\n');
  if (dryRun) {
    console.log('🏃 DRY RUN MODE - No changes will be made\n');
  }

  const db = new Database(DB_PATH);

  try {
    // Find all observations where timestamp doesn't match session
    const corrupted = db.query<CorruptedObservation, []>(`
      SELECT
        o.id as obs_id,
        o.title as obs_title,
        o.created_at_epoch as obs_created,
        s.started_at_epoch as session_started,
        s.completed_at_epoch as session_completed,
        s.memory_session_id
      FROM observations o
      JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      WHERE o.created_at_epoch < s.started_at_epoch  -- Observation older than session
         OR (s.completed_at_epoch IS NOT NULL
             AND o.created_at_epoch > (s.completed_at_epoch + 3600000))  -- More than 1hr after session
      ORDER BY o.id
    `).all();

    console.log(`Found ${corrupted.length} observations with corrupted timestamps\n`);

    if (corrupted.length === 0) {
      console.log('✅ No corrupted timestamps found!');
      db.close();
      return;
    }

    // Display findings
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('PROPOSED FIXES:');
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    for (const obs of corrupted.slice(0, 50)) {
      const daysDiff = Math.round((obs.obs_created - obs.session_started) / (1000 * 60 * 60 * 24));
      console.log(`Observation #${obs.obs_id}: ${obs.obs_title || '(no title)'}`);
      console.log(`  ❌ Wrong: ${formatTimestamp(obs.obs_created)}`);
      console.log(`  ✅ Correct: ${formatTimestamp(obs.session_started)}`);
      console.log(`  📅 Off by ${daysDiff} days\n`);
    }

    if (corrupted.length > 50) {
      console.log(`... and ${corrupted.length - 50} more\n`);
    }

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(`Ready to fix ${corrupted.length} observations.`);

    if (dryRun) {
      console.log('\n🏃 DRY RUN COMPLETE - No changes made.');
      console.log('Run without --dry-run flag to apply fixes.\n');
      db.close();
      return;
    }

    if (autoYes) {
      console.log('Auto-confirming with --yes flag...\n');
      applyFixes(db, corrupted);
      return;
    }

    console.log('Apply these fixes? (y/n): ');

    const stdin = Bun.stdin.stream();
    const reader = stdin.getReader();

    reader.read().then(({ value }) => {
      const response = new TextDecoder().decode(value).trim().toLowerCase();

      if (response === 'y' || response === 'yes') {
        applyFixes(db, corrupted);
      } else {
        console.log('\n❌ Fixes cancelled. No changes made.');
        db.close();
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    db.close();
    process.exit(1);
  }
}

function applyFixes(db: Database, corrupted: CorruptedObservation[]) {
  console.log('\n🔧 Applying fixes...\n');

  const updateStmt = db.prepare(`
    UPDATE observations
    SET created_at_epoch = ?,
        created_at = datetime(?/1000, 'unixepoch')
    WHERE id = ?
  `);

  let successCount = 0;
  let errorCount = 0;

  for (const obs of corrupted) {
    try {
      updateStmt.run(
        obs.session_started,
        obs.session_started,
        obs.obs_id
      );
      successCount++;
      if (successCount % 10 === 0 || successCount <= 10) {
        console.log(`✅ Fixed observation #${obs.obs_id}`);
      }
    } catch (error) {
      errorCount++;
      console.error(`❌ Failed to fix observation #${obs.obs_id}:`, error);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('RESULTS:');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`✅ Successfully fixed: ${successCount}`);
  console.log(`❌ Failed: ${errorCount}`);
  console.log(`📊 Total processed: ${corrupted.length}\n`);

  if (successCount > 0) {
    console.log('🎉 ALL timestamp corruption has been repaired!\n');
  }

  db.close();
}

main();
