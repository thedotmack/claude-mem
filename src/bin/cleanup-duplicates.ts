#!/usr/bin/env node
/**
 * Cleanup duplicate observations and summaries from the database
 * Keeps the earliest entry (MIN(id)) for each duplicate group
 */

import { SessionStore } from '../services/sqlite/SessionStore.js';

function main() {
  console.log('Starting duplicate cleanup...\n');

  const db = new SessionStore();

  // Find and delete duplicate observations
  console.log('Finding duplicate observations...');

  const duplicateObsQuery = db['db'].prepare(`
    SELECT memory_session_id, title, subtitle, type, COUNT(*) as count, GROUP_CONCAT(id) as ids
    FROM observations
    GROUP BY memory_session_id, title, subtitle, type
    HAVING count > 1
  `);

  const duplicateObs = duplicateObsQuery.all() as Array<{
    memory_session_id: string;
    title: string;
    subtitle: string;
    type: string;
    count: number;
    ids: string;
  }>;

  console.log(`Found ${duplicateObs.length} duplicate observation groups\n`);

  let deletedObs = 0;
  for (const dup of duplicateObs) {
    const ids = dup.ids.split(',').map(id => parseInt(id, 10));
    const keepId = Math.min(...ids);
    const deleteIds = ids.filter(id => id !== keepId);

    console.log(`Observation "${dup.title.substring(0, 60)}..."`);
    console.log(`  Found ${dup.count} copies, keeping ID ${keepId}, deleting ${deleteIds.length} duplicates`);

    const deleteStmt = db['db'].prepare(`DELETE FROM observations WHERE id IN (${deleteIds.join(',')})`);
    deleteStmt.run();
    deletedObs += deleteIds.length;
  }

  // Find and delete duplicate summaries
  console.log('\n\nFinding duplicate summaries...');

  const duplicateSumQuery = db['db'].prepare(`
    SELECT memory_session_id, request, completed, learned, COUNT(*) as count, GROUP_CONCAT(id) as ids
    FROM session_summaries
    GROUP BY memory_session_id, request, completed, learned
    HAVING count > 1
  `);

  const duplicateSum = duplicateSumQuery.all() as Array<{
    memory_session_id: string;
    request: string;
    completed: string;
    learned: string;
    count: number;
    ids: string;
  }>;

  console.log(`Found ${duplicateSum.length} duplicate summary groups\n`);

  let deletedSum = 0;
  for (const dup of duplicateSum) {
    const ids = dup.ids.split(',').map(id => parseInt(id, 10));
    const keepId = Math.min(...ids);
    const deleteIds = ids.filter(id => id !== keepId);

    console.log(`Summary "${dup.request.substring(0, 60)}..."`);
    console.log(`  Found ${dup.count} copies, keeping ID ${keepId}, deleting ${deleteIds.length} duplicates`);

    const deleteStmt = db['db'].prepare(`DELETE FROM session_summaries WHERE id IN (${deleteIds.join(',')})`);
    deleteStmt.run();
    deletedSum += deleteIds.length;
  }

  db.close();

  console.log('\n' + '='.repeat(60));
  console.log('Cleanup Complete!');
  console.log('='.repeat(60));
  console.log(`🗑️  Deleted: ${deletedObs} duplicate observations`);
  console.log(`🗑️  Deleted: ${deletedSum} duplicate summaries`);
  console.log(`🗑️  Total: ${deletedObs + deletedSum} duplicates removed`);
  console.log('='.repeat(60));
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
