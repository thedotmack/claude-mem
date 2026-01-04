#!/usr/bin/env bun
/**
 * Cleanup script for duplicate observations created by the batching bug.
 *
 * The bug: When multiple messages were batched together, observations were stored
 * once per message ID instead of once per observation. For example, if 4 messages
 * were batched and produced 3 observations, those 3 observations were stored
 * 12 times (4×3) instead of 3 times.
 *
 * This script identifies duplicates by matching on:
 * - memory_session_id (same session)
 * - text (same content)
 * - type (same observation type)
 * - created_at_epoch within 60 seconds (same batch window)
 *
 * Usage:
 *   bun scripts/cleanup-duplicates.ts           # Dry run (default)
 *   bun scripts/cleanup-duplicates.ts --execute # Actually delete duplicates
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');

// Time window modes for duplicate detection
const TIME_WINDOW_MODES = {
  strict: 5,      // 5 seconds - only exact duplicates from same batch
  normal: 60,     // 60 seconds - duplicates within same minute
  aggressive: 0,  // 0 = ignore time entirely, match on session+text+type only
};

interface DuplicateGroup {
  memory_session_id: string;
  title: string;
  type: string;
  epoch_bucket: number;
  count: number;
  ids: number[];
  keep_id: number;
  delete_ids: number[];
}

interface ObservationRow {
  id: number;
  memory_session_id: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  type: string;
  created_at_epoch: number;
}

function main() {
  const dryRun = !process.argv.includes('--execute');
  const aggressive = process.argv.includes('--aggressive');
  const strict = process.argv.includes('--strict');

  // Determine time window
  let windowMode: keyof typeof TIME_WINDOW_MODES = 'normal';
  if (aggressive) windowMode = 'aggressive';
  if (strict) windowMode = 'strict';
  const batchWindowSeconds = TIME_WINDOW_MODES[windowMode];

  console.log('='.repeat(60));
  console.log('Claude-Mem Duplicate Observation Cleanup');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN (use --execute to delete)' : 'EXECUTE'}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Time window: ${windowMode} (${batchWindowSeconds === 0 ? 'ignore time' : batchWindowSeconds + ' seconds'})`);
  console.log('');
  console.log('Options:');
  console.log('  --execute     Actually delete duplicates (default: dry run)');
  console.log('  --strict      5-second window (exact batch duplicates only)');
  console.log('  --aggressive  Ignore time, match on session+text+type only');
  console.log('');

  const db = dryRun
    ? new Database(DB_PATH, { readonly: true })
    : new Database(DB_PATH);

  // Get total observation count
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
  console.log(`Total observations in database: ${totalCount.count}`);

  // Find all observations and group by content fingerprint
  const observations = db.prepare(`
    SELECT
      id,
      memory_session_id,
      title,
      subtitle,
      narrative,
      type,
      created_at_epoch
    FROM observations
    ORDER BY memory_session_id, title, type, created_at_epoch
  `).all() as ObservationRow[];

  console.log(`Analyzing ${observations.length} observations for duplicates...`);
  console.log('');

  // Group observations by fingerprint (session + text + type + time bucket)
  const groups = new Map<string, ObservationRow[]>();

  for (const obs of observations) {
    // Skip observations without title (can't dedupe without content identifier)
    if (obs.title === null) continue;

    // Create content hash from title + subtitle + narrative
    const contentKey = `${obs.title}|${obs.subtitle || ''}|${obs.narrative || ''}`;

    // Create fingerprint based on time window mode
    let fingerprint: string;
    if (batchWindowSeconds === 0) {
      // Aggressive mode: ignore time entirely
      fingerprint = `${obs.memory_session_id}|${obs.type}|${contentKey}`;
    } else {
      // Normal/strict mode: include time bucket
      const epochBucket = Math.floor(obs.created_at_epoch / batchWindowSeconds);
      fingerprint = `${obs.memory_session_id}|${obs.type}|${epochBucket}|${contentKey}`;
    }

    if (!groups.has(fingerprint)) {
      groups.set(fingerprint, []);
    }
    groups.get(fingerprint)!.push(obs);
  }

  // Find groups with duplicates
  const duplicateGroups: DuplicateGroup[] = [];

  for (const [fingerprint, rows] of groups) {
    if (rows.length > 1) {
      // Sort by id to keep the oldest (lowest id)
      rows.sort((a, b) => a.id - b.id);
      const keepId = rows[0].id;
      const deleteIds = rows.slice(1).map(r => r.id);

      // SAFETY: Never delete all copies - always keep at least one
      if (deleteIds.length >= rows.length) {
        throw new Error(`SAFETY VIOLATION: Would delete all ${rows.length} copies! Aborting.`);
      }
      if (!deleteIds.every(id => id !== keepId)) {
        throw new Error(`SAFETY VIOLATION: Delete list contains keep_id ${keepId}! Aborting.`);
      }

      const title = rows[0].title || '';
      duplicateGroups.push({
        memory_session_id: rows[0].memory_session_id,
        title: title.substring(0, 100) + (title.length > 100 ? '...' : ''),
        type: rows[0].type,
        epoch_bucket: batchWindowSeconds > 0 ? Math.floor(rows[0].created_at_epoch / batchWindowSeconds) : 0,
        count: rows.length,
        ids: rows.map(r => r.id),
        keep_id: keepId,
        delete_ids: deleteIds,
      });
    }
  }

  if (duplicateGroups.length === 0) {
    console.log('No duplicate observations found!');
    db.close();
    return;
  }

  // Calculate stats
  const totalDuplicates = duplicateGroups.reduce((sum, g) => sum + g.delete_ids.length, 0);
  const affectedSessions = new Set(duplicateGroups.map(g => g.memory_session_id)).size;

  console.log('DUPLICATE ANALYSIS:');
  console.log('-'.repeat(60));
  console.log(`Duplicate groups found: ${duplicateGroups.length}`);
  console.log(`Total duplicates to remove: ${totalDuplicates}`);
  console.log(`Affected sessions: ${affectedSessions}`);
  console.log(`Observations after cleanup: ${totalCount.count - totalDuplicates}`);
  console.log('');

  // Show sample of duplicates
  console.log('SAMPLE DUPLICATES (first 10 groups):');
  console.log('-'.repeat(60));

  for (const group of duplicateGroups.slice(0, 10)) {
    console.log(`Session: ${group.memory_session_id.substring(0, 20)}...`);
    console.log(`Type: ${group.type}`);
    console.log(`Count: ${group.count} copies (keeping id=${group.keep_id}, deleting ${group.delete_ids.length})`);
    console.log(`Title: "${group.title}"`);
    console.log('');
  }

  if (duplicateGroups.length > 10) {
    console.log(`... and ${duplicateGroups.length - 10} more groups`);
    console.log('');
  }

  // Execute deletion if not dry run
  if (!dryRun) {
    console.log('EXECUTING DELETION...');
    console.log('-'.repeat(60));

    const allDeleteIds = duplicateGroups.flatMap(g => g.delete_ids);

    // Delete in batches of 500 to avoid SQLite limits
    const BATCH_SIZE = 500;
    let deleted = 0;

    db.exec('BEGIN TRANSACTION');

    try {
      for (let i = 0; i < allDeleteIds.length; i += BATCH_SIZE) {
        const batch = allDeleteIds.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const stmt = db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`);
        const result = stmt.run(...batch);
        deleted += result.changes;
        console.log(`Deleted batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.changes} observations`);
      }

      db.exec('COMMIT');
      console.log('');
      console.log(`Successfully deleted ${deleted} duplicate observations!`);

      // Verify final count
      const finalCount = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      console.log(`Final observation count: ${finalCount.count}`);

    } catch (error) {
      db.exec('ROLLBACK');
      console.error('Error during deletion, rolled back:', error);
      process.exit(1);
    }
  } else {
    console.log('DRY RUN COMPLETE');
    console.log('-'.repeat(60));
    console.log('No changes were made. Run with --execute to delete duplicates.');
  }

  db.close();
}

main();
