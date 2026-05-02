#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface CountRow { count: number }
interface StatusRow { status: string; count: number }

function resolveDbPath(): string {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  return join(dataDir, 'claude-mem.db');
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.log(question + '(no TTY, use --force flag for non-interactive mode)');
    return 'n';
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(data.toString().trim());
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Claude-Mem Queue Clearer

Clear orphaned messages from the pending_messages SQLite table.

Usage:
  bun scripts/clear-failed-queue.ts [options]

Options:
  --help, -h     Show this help message
  --all          Clear ALL messages (pending, processing, processed, failed)
  --force        Clear without prompting for confirmation

Examples:
  # Clear failed messages interactively
  bun scripts/clear-failed-queue.ts

  # Clear ALL messages without confirmation
  bun scripts/clear-failed-queue.ts --all --force

Notes:
  Operates directly on ~/.claude-mem/claude-mem.db (or \$CLAUDE_MEM_DATA_DIR).
  Uses SQLite WAL mode so it is safe to run while the worker is running.
`);
    process.exit(0);
  }

  const force = args.includes('--force');
  const clearAll = args.includes('--all');

  console.log(clearAll
    ? '\n=== Claude-Mem Queue Clearer (ALL) ===\n'
    : '\n=== Claude-Mem Queue Clearer (Failed) ===\n');

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    console.log(`No database found at ${dbPath}. Nothing to clear.\n`);
    process.exit(0);
  }

  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');

  const counts = db.prepare(
    'SELECT status, COUNT(*) as count FROM pending_messages GROUP BY status'
  ).all() as StatusRow[];

  const total = counts.reduce((sum, row) => sum + row.count, 0);
  const failed = counts.find(r => r.status === 'failed')?.count ?? 0;

  console.log('Queue Summary:');
  for (const status of ['pending', 'processing', 'processed', 'failed'] as const) {
    const row = counts.find(r => r.status === status);
    console.log(`  ${status.padEnd(11)} ${row?.count ?? 0}`);
  }
  console.log('');

  const willClear = clearAll ? total : failed;
  if (willClear === 0) {
    console.log(clearAll
      ? 'No messages in queue. Nothing to clear.\n'
      : 'No failed messages in queue. Nothing to clear.\n');
    db.close();
    process.exit(0);
  }

  if (!force) {
    const answer = await prompt(
      clearAll
        ? `Clear ${willClear} messages (all statuses)? [y/N]: `
        : `Clear ${willClear} failed messages? [y/N]: `
    );
    if (answer.toLowerCase() !== 'y') {
      console.log('\nCancelled. Run with --force to skip confirmation.\n');
      db.close();
      process.exit(0);
    }
    console.log('');
  }

  const stmt = clearAll
    ? db.prepare('DELETE FROM pending_messages')
    : db.prepare("DELETE FROM pending_messages WHERE status = 'failed'");
  const cleared = stmt.run().changes;

  const remaining = (db.prepare(
    'SELECT COUNT(*) as count FROM pending_messages'
  ).get() as CountRow).count;

  console.log('Clearing Result:');
  console.log(`  Messages cleared: ${cleared}`);
  console.log(`  Remaining:        ${remaining}\n`);

  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
