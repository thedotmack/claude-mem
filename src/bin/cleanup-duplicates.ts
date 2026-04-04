#!/usr/bin/env node
/**
 * Cleanup duplicate observations and summaries from the database
 * Keeps the earliest entry (MIN(id)) for each duplicate group
 */

import { SessionStore } from '../services/sqlite/SessionStore.js';
import { queryAll, exec } from '../services/sqlite/adapter.js';

async function main() {
  console.log('Starting duplicate cleanup...\n');

  const db = await SessionStore.create();

  // Find and delete duplicate observations
  console.log('Finding duplicate observations...');

  const duplicateObs = await queryAll<{
    content_hash: string;
    count: number;
    ids: string;
  }>(db.db, `
    SELECT content_hash, COUNT(*) as count, GROUP_CONCAT(id) as ids
    FROM observations
    WHERE content_hash IS NOT NULL
    GROUP BY content_hash
    HAVING count > 1
  `);

  console.log(`Found ${duplicateObs.length} duplicate observation groups\n`);

  let deletedObs = 0;
  for (const dup of duplicateObs) {
    const ids = dup.ids.split(',').map(id => parseInt(id, 10));
    const keepId = Math.min(...ids);
    const deleteIds = ids.filter(id => id !== keepId);

    console.log(`Observation hash "${dup.content_hash}"`);
    console.log(`  Found ${dup.count} copies, keeping ID ${keepId}, deleting ${deleteIds.length} duplicates`);

    await exec(db.db, `DELETE FROM observations WHERE id IN (${deleteIds.join(',')})`);
    deletedObs += deleteIds.length;
  }

  // Find and delete duplicate summaries
  console.log('\n\nFinding duplicate summaries...');

  const duplicateSum = await queryAll<{
    memory_session_id: string;
    request: string;
    completed: string;
    learned: string;
    count: number;
    ids: string;
  }>(db.db, `
    SELECT memory_session_id, request, completed, learned, COUNT(*) as count, GROUP_CONCAT(id) as ids
    FROM session_summaries
    GROUP BY memory_session_id, request, completed, learned
    HAVING count > 1
  `);

  console.log(`Found ${duplicateSum.length} duplicate summary groups\n`);

  let deletedSum = 0;
  for (const dup of duplicateSum) {
    const ids = dup.ids.split(',').map(id => parseInt(id, 10));
    const keepId = Math.min(...ids);
    const deleteIds = ids.filter(id => id !== keepId);

    console.log(`Summary "${dup.request.substring(0, 60)}..."`);
    console.log(`  Found ${dup.count} copies, keeping ID ${keepId}, deleting ${deleteIds.length} duplicates`);

    await exec(db.db, `DELETE FROM session_summaries WHERE id IN (${deleteIds.join(',')})`);
    deletedSum += deleteIds.length;
  }

  await db.close();

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
