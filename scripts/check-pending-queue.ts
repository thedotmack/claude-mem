#!/usr/bin/env bun
/**
 * Check and process pending observation queue
 *
 * Usage:
 *   bun scripts/check-pending-queue.ts           # Check status and prompt to process
 *   bun scripts/check-pending-queue.ts --process # Auto-process without prompting
 *   bun scripts/check-pending-queue.ts --limit 5 # Process up to 5 sessions
 */

const WORKER_URL = 'http://localhost:37777';

interface QueueMessage {
  id: number;
  session_db_id: number;
  message_type: string;
  tool_name: string | null;
  status: 'pending' | 'processing' | 'failed';
  retry_count: number;
  created_at_epoch: number;
  project: string | null;
}

interface QueueResponse {
  queue: {
    messages: QueueMessage[];
    totalPending: number;
    totalProcessing: number;
    totalFailed: number;
    stuckCount: number;
  };
  recentlyProcessed: QueueMessage[];
  sessionsWithPendingWork: number[];
}

interface ProcessResponse {
  success: boolean;
  totalPendingSessions: number;
  sessionsStarted: number;
  sessionsSkipped: number;
  startedSessionIds: number[];
}

async function checkWorkerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function getQueueStatus(): Promise<QueueResponse> {
  const res = await fetch(`${WORKER_URL}/api/pending-queue`);
  if (!res.ok) {
    throw new Error(`Failed to get queue status: ${res.status}`);
  }
  return res.json();
}

async function processQueue(limit: number): Promise<ProcessResponse> {
  const res = await fetch(`${WORKER_URL}/api/pending-queue/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionLimit: limit })
  });
  if (!res.ok) {
    throw new Error(`Failed to process queue: ${res.status}`);
  }
  return res.json();
}

function formatAge(epochMs: number): string {
  const ageMs = Date.now() - epochMs;
  const minutes = Math.floor(ageMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  return `${minutes}m ago`;
}

async function prompt(question: string): Promise<string> {
  // Check if we have a TTY for interactive input
  if (!process.stdin.isTTY) {
    console.log(question + '(no TTY, use --process flag for non-interactive mode)');
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

  // Help flag
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Claude-Mem Pending Queue Manager

Check and process pending observation queue backlog.

Usage:
  bun scripts/check-pending-queue.ts [options]

Options:
  --help, -h     Show this help message
  --process      Auto-process without prompting
  --limit N      Process up to N sessions (default: 10)

Examples:
  # Check queue status interactively
  bun scripts/check-pending-queue.ts

  # Auto-process up to 10 sessions
  bun scripts/check-pending-queue.ts --process

  # Process up to 5 sessions
  bun scripts/check-pending-queue.ts --process --limit 5

What is this for?
  If the claude-mem worker crashes or restarts, pending observations may
  be left unprocessed. This script shows the backlog and lets you trigger
  processing. The worker no longer auto-recovers on startup to give you
  control over when processing happens.
`);
    process.exit(0);
  }

  const autoProcess = args.includes('--process');
  const limitArg = args.find((_, i) => args[i - 1] === '--limit');
  const limit = limitArg ? parseInt(limitArg, 10) : 10;

  console.log('\n=== Claude-Mem Pending Queue Status ===\n');

  // Check worker health
  const healthy = await checkWorkerHealth();
  if (!healthy) {
    console.log('Worker is not running. Start it with:');
    console.log('  cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:start\n');
    process.exit(1);
  }
  console.log('Worker status: Running\n');

  // Get queue status
  const status = await getQueueStatus();
  const { queue, sessionsWithPendingWork } = status;

  // Display summary
  console.log('Queue Summary:');
  console.log(`  Pending:    ${queue.totalPending}`);
  console.log(`  Processing: ${queue.totalProcessing}`);
  console.log(`  Failed:     ${queue.totalFailed}`);
  console.log(`  Stuck:      ${queue.stuckCount} (processing > 5 min)`);
  console.log(`  Sessions:   ${sessionsWithPendingWork.length} with pending work\n`);

  // Check if there's any backlog
  const hasBacklog = queue.totalPending > 0 || queue.totalFailed > 0;
  const hasStuck = queue.stuckCount > 0;

  if (!hasBacklog && !hasStuck) {
    console.log('No backlog detected. Queue is healthy.\n');

    // Show recently processed if any
    if (status.recentlyProcessed.length > 0) {
      console.log(`Recently processed: ${status.recentlyProcessed.length} messages in last 30 min\n`);
    }
    process.exit(0);
  }

  // Show details about pending messages
  if (queue.messages.length > 0) {
    console.log('Pending Messages:');
    console.log('─'.repeat(80));

    // Group by session
    const bySession = new Map<number, QueueMessage[]>();
    for (const msg of queue.messages) {
      const list = bySession.get(msg.session_db_id) || [];
      list.push(msg);
      bySession.set(msg.session_db_id, list);
    }

    for (const [sessionId, messages] of bySession) {
      const project = messages[0].project || 'unknown';
      const oldest = Math.min(...messages.map(m => m.created_at_epoch));
      const statuses = {
        pending: messages.filter(m => m.status === 'pending').length,
        processing: messages.filter(m => m.status === 'processing').length,
        failed: messages.filter(m => m.status === 'failed').length
      };

      console.log(`  Session ${sessionId} (${project})`);
      console.log(`    Messages: ${messages.length} total`);
      console.log(`    Status:   ${statuses.pending} pending, ${statuses.processing} processing, ${statuses.failed} failed`);
      console.log(`    Age:      ${formatAge(oldest)}`);
    }
    console.log('─'.repeat(80));
    console.log('');
  }

  // Offer to process
  if (autoProcess) {
    console.log(`Auto-processing up to ${limit} sessions...\n`);
  } else {
    const answer = await prompt(`Process pending queue? (up to ${limit} sessions) [y/N]: `);
    if (answer.toLowerCase() !== 'y') {
      console.log('\nSkipped. Run with --process to auto-process.\n');
      process.exit(0);
    }
    console.log('');
  }

  // Process the queue
  const result = await processQueue(limit);

  console.log('Processing Result:');
  console.log(`  Sessions started: ${result.sessionsStarted}`);
  console.log(`  Sessions skipped: ${result.sessionsSkipped} (already active)`);
  console.log(`  Remaining:        ${result.totalPendingSessions - result.sessionsStarted}`);

  if (result.startedSessionIds.length > 0) {
    console.log(`  Started IDs:      ${result.startedSessionIds.join(', ')}`);
  }

  console.log('\nProcessing started in background. Check status again in a few minutes.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
