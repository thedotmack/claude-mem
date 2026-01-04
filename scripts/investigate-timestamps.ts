#!/usr/bin/env bun

/**
 * Investigate Timestamp Situation
 *
 * This script investigates the actual state of observations and pending messages
 * to understand what happened with the timestamp corruption.
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
  console.log('🔍 Investigating timestamp situation...\n');

  const db = new Database(DB_PATH);

  try {
    // Check 1: Recent observations on Dec 24
    console.log('Check 1: All observations created on Dec 24, 2025...');
    const dec24Start = 1735027200000; // Dec 24 00:00 PST
    const dec24End = 1735113600000;   // Dec 25 00:00 PST

    const dec24Obs = db.query(`
      SELECT id, memory_session_id, created_at_epoch, title
      FROM observations
      WHERE created_at_epoch >= ${dec24Start}
        AND created_at_epoch < ${dec24End}
      ORDER BY created_at_epoch
      LIMIT 100
    `).all();

    console.log(`Found ${dec24Obs.length} observations on Dec 24:\n`);
    for (const obs of dec24Obs.slice(0, 20)) {
      console.log(`  #${obs.id}: ${formatTimestamp(obs.created_at_epoch)} - ${obs.title || '(no title)'}`);
    }
    if (dec24Obs.length > 20) {
      console.log(`  ... and ${dec24Obs.length - 20} more`);
    }
    console.log();

    // Check 2: Observations from Dec 17-20
    console.log('Check 2: Observations from Dec 17-20, 2025...');
    const dec17Start = 1734422400000; // Dec 17 00:00 PST
    const dec21Start = 1734768000000; // Dec 21 00:00 PST

    const oldObs = db.query(`
      SELECT id, memory_session_id, created_at_epoch, title
      FROM observations
      WHERE created_at_epoch >= ${dec17Start}
        AND created_at_epoch < ${dec21Start}
      ORDER BY created_at_epoch
      LIMIT 100
    `).all();

    console.log(`Found ${oldObs.length} observations from Dec 17-20:\n`);
    for (const obs of oldObs.slice(0, 20)) {
      console.log(`  #${obs.id}: ${formatTimestamp(obs.created_at_epoch)} - ${obs.title || '(no title)'}`);
    }
    if (oldObs.length > 20) {
      console.log(`  ... and ${oldObs.length - 20} more`);
    }
    console.log();

    // Check 3: Pending messages status
    console.log('Check 3: Pending messages status...');
    const statusCounts = db.query(`
      SELECT status, COUNT(*) as count
      FROM pending_messages
      GROUP BY status
    `).all();

    console.log('Pending message counts by status:');
    for (const row of statusCounts) {
      console.log(`  ${row.status}: ${row.count}`);
    }
    console.log();

    // Check 4: Old pending messages from Dec 17-20
    console.log('Check 4: Pending messages from Dec 17-20...');
    const oldMessages = db.query(`
      SELECT id, session_db_id, tool_name, status, created_at_epoch, completed_at_epoch
      FROM pending_messages
      WHERE created_at_epoch >= ${dec17Start}
        AND created_at_epoch < ${dec21Start}
      ORDER BY created_at_epoch
      LIMIT 50
    `).all();

    console.log(`Found ${oldMessages.length} pending messages from Dec 17-20:\n`);
    for (const msg of oldMessages.slice(0, 20)) {
      const completedAt = msg.completed_at_epoch ? formatTimestamp(msg.completed_at_epoch) : 'N/A';
      console.log(`  #${msg.id}: ${msg.tool_name} - Status: ${msg.status}`);
      console.log(`    Created: ${formatTimestamp(msg.created_at_epoch)}`);
      console.log(`    Completed: ${completedAt}\n`);
    }
    if (oldMessages.length > 20) {
      console.log(`  ... and ${oldMessages.length - 20} more`);
    }

    // Check 5: Recently completed pending messages
    console.log('Check 5: Recently completed pending messages...');
    const recentCompleted = db.query(`
      SELECT id, session_db_id, tool_name, status, created_at_epoch, completed_at_epoch
      FROM pending_messages
      WHERE completed_at_epoch IS NOT NULL
      ORDER BY completed_at_epoch DESC
      LIMIT 20
    `).all();

    console.log(`Most recent completed pending messages:\n`);
    for (const msg of recentCompleted) {
      const createdAt = formatTimestamp(msg.created_at_epoch);
      const completedAt = formatTimestamp(msg.completed_at_epoch);
      const lag = Math.round((msg.completed_at_epoch - msg.created_at_epoch) / 1000);
      console.log(`  #${msg.id}: ${msg.tool_name} (${msg.status})`);
      console.log(`    Created: ${createdAt}`);
      console.log(`    Completed: ${completedAt} (${lag}s later)\n`);
    }

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
