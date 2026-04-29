#!/usr/bin/env bun

import Database from 'bun:sqlite';
import { resolve } from 'path';

const DB_PATH = resolve(process.env.HOME!, '.claude-mem/claude-mem.db');

const BAD_WINDOW_START = 1766623500000; 
const BAD_WINDOW_END = 1766626260000;   

interface AffectedObservation {
  id: number;
  memory_session_id: string;
  created_at_epoch: number;
  title: string;
}

interface ProcessedMessage {
  id: number;
  session_db_id: number;
  tool_name: string;
  created_at_epoch: number;
  completed_at_epoch: number;
}

interface SessionMapping {
  session_db_id: number;
  memory_session_id: string;
}

interface TimestampFix {
  observation_id: number;
  observation_title: string;
  wrong_timestamp: number;
  correct_timestamp: number;
  session_db_id: number;
  pending_message_id: number;
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

  console.log('🔍 Analyzing corrupted observation timestamps...\n');
  if (dryRun) {
    console.log('🏃 DRY RUN MODE - No changes will be made\n');
  }

  const db = new Database(DB_PATH);

  try {
    console.log('Step 1: Finding observations created during bad window...');
    const affectedObs = db.query<AffectedObservation, []>(`
      SELECT id, memory_session_id, created_at_epoch, title
      FROM observations
      WHERE created_at_epoch >= ${BAD_WINDOW_START}
        AND created_at_epoch <= ${BAD_WINDOW_END}
      ORDER BY id
    `).all();

    console.log(`Found ${affectedObs.length} observations in bad window\n`);

    if (affectedObs.length === 0) {
      console.log('✅ No affected observations found!');
      return;
    }

    console.log('Step 2: Finding pending messages processed during bad window...');
    const processedMessages = db.query<ProcessedMessage, []>(`
      SELECT id, session_db_id, tool_name, created_at_epoch, completed_at_epoch
      FROM pending_messages
      WHERE status = 'processed'
        AND completed_at_epoch >= ${BAD_WINDOW_START}
        AND completed_at_epoch <= ${BAD_WINDOW_END}
      ORDER BY completed_at_epoch
    `).all();

    console.log(`Found ${processedMessages.length} processed messages\n`);

    console.log('Step 3: Matching observations to session start times...');
    const fixes: TimestampFix[] = [];

    interface ObsWithSession {
      obs_id: number;
      obs_title: string;
      obs_created: number;
      session_started: number;
      memory_session_id: string;
    }

    const obsWithSessions = db.query<ObsWithSession, []>(`
      SELECT
        o.id as obs_id,
        o.title as obs_title,
        o.created_at_epoch as obs_created,
        s.started_at_epoch as session_started,
        s.memory_session_id
      FROM observations o
      JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      WHERE o.created_at_epoch >= ${BAD_WINDOW_START}
        AND o.created_at_epoch <= ${BAD_WINDOW_END}
        AND s.started_at_epoch < ${BAD_WINDOW_START}
      ORDER BY o.id
    `).all();

    for (const row of obsWithSessions) {
      fixes.push({
        observation_id: row.obs_id,
        observation_title: row.obs_title || '(no title)',
        wrong_timestamp: row.obs_created,
        correct_timestamp: row.session_started,
        session_db_id: 0, // Not needed for this approach
        pending_message_id: 0 
      });
    }

    console.log(`Identified ${fixes.length} observations to fix\n`);

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log('PROPOSED FIXES:');
    console.log('═══════════════════════════════════════════════════════════════════════\n');

    for (const fix of fixes) {
      const daysDiff = Math.round((fix.wrong_timestamp - fix.correct_timestamp) / (1000 * 60 * 60 * 24));
      console.log(`Observation #${fix.observation_id}: ${fix.observation_title}`);
      console.log(`  ❌ Wrong: ${formatTimestamp(fix.wrong_timestamp)}`);
      console.log(`  ✅ Correct: ${formatTimestamp(fix.correct_timestamp)}`);
      console.log(`  📅 Off by ${daysDiff} days\n`);
    }

    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(`Ready to fix ${fixes.length} observations.`);

    if (dryRun) {
      console.log('\n🏃 DRY RUN COMPLETE - No changes made.');
      console.log('Run without --dry-run flag to apply fixes.\n');
      db.close();
      return;
    }

    if (autoYes) {
      console.log('Auto-confirming with --yes flag...\n');
      applyFixes(db, fixes);
      return;
    }

    console.log('Apply these fixes? (y/n): ');

    const stdin = Bun.stdin.stream();
    const reader = stdin.getReader();

    reader.read().then(({ value }) => {
      const response = new TextDecoder().decode(value).trim().toLowerCase();

      if (response === 'y' || response === 'yes') {
        applyFixes(db, fixes);
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

function applyFixes(db: Database, fixes: TimestampFix[]) {
  console.log('\n🔧 Applying fixes...\n');

  const updateStmt = db.prepare(`
    UPDATE observations
    SET created_at_epoch = ?,
        created_at = datetime(?/1000, 'unixepoch')
    WHERE id = ?
  `);

  let successCount = 0;
  let errorCount = 0;

  for (const fix of fixes) {
    try {
      updateStmt.run(
        fix.correct_timestamp,
        fix.correct_timestamp,
        fix.observation_id
      );
      successCount++;
      console.log(`✅ Fixed observation #${fix.observation_id}`);
    } catch (error) {
      errorCount++;
      console.error(`❌ Failed to fix observation #${fix.observation_id}:`, error);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('RESULTS:');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`✅ Successfully fixed: ${successCount}`);
  console.log(`❌ Failed: ${errorCount}`);
  console.log(`📊 Total processed: ${fixes.length}\n`);

  if (successCount > 0) {
    console.log('🎉 Timestamp corruption has been repaired!');
    console.log('💡 Next steps:');
    console.log('   1. Verify the fixes with: bun scripts/verify-timestamp-fix.ts');
    console.log('   2. Consider re-enabling orphan processing if timestamp fix is working\n');
  }

  db.close();
}

main();
