#!/usr/bin/env bun
/**
 * Clear messages from the queue
 *
 * Usage:
 *   bun scripts/clear-failed-queue.ts           # Clear failed messages (interactive)
 *   bun scripts/clear-failed-queue.ts --all     # Clear ALL messages (pending, processing, failed)
 *   bun scripts/clear-failed-queue.ts --force   # Non-interactive - clear without prompting
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

interface ClearResponse {
  success: boolean;
  clearedCount: number;
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

async function clearFailedQueue(): Promise<ClearResponse> {
  const res = await fetch(`${WORKER_URL}/api/pending-queue/failed`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    throw new Error(`Failed to clear failed queue: ${res.status}`);
  }
  return res.json();
}

async function clearAllQueue(): Promise<ClearResponse> {
  const res = await fetch(`${WORKER_URL}/api/pending-queue/all`, {
    method: 'DELETE'
  });
  if (!res.ok) {
    throw new Error(`Failed to clear queue: ${res.status}`);
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

  // Help flag
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Claude-Mem Queue Clearer

Clear messages from the observation queue.

Usage:
  bun scripts/clear-failed-queue.ts [options]

Options:
  --help, -h     Show this help message
  --all          Clear ALL messages (pending, processing, and failed)
  --force        Clear without prompting for confirmation

Examples:
  # Clear failed messages interactively
  bun scripts/clear-failed-queue.ts

  # Clear ALL messages (pending, processing, failed)
  bun scripts/clear-failed-queue.ts --all

  # Clear without confirmation (non-interactive)
  bun scripts/clear-failed-queue.ts --force

  # Clear all messages without confirmation
  bun scripts/clear-failed-queue.ts --all --force

What is this for?
  Failed messages are observations that exceeded the maximum retry count.
  Processing/pending messages may be stuck or unwanted.
  This command removes them to clean up the queue.

  --all is useful for a complete reset when you want to start fresh.
`);
    process.exit(0);
  }

  const force = args.includes('--force');
  const clearAll = args.includes('--all');

  console.log(clearAll
    ? '\n=== Claude-Mem Queue Clearer (ALL) ===\n'
    : '\n=== Claude-Mem Queue Clearer (Failed) ===\n');

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
  const { queue } = status;

  console.log('Queue Summary:');
  console.log(`  Pending:    ${queue.totalPending}`);
  console.log(`  Processing: ${queue.totalProcessing}`);
  console.log(`  Failed:     ${queue.totalFailed}`);
  console.log('');

  // Check if there are messages to clear
  const totalToClear = clearAll
    ? queue.totalPending + queue.totalProcessing + queue.totalFailed
    : queue.totalFailed;

  if (totalToClear === 0) {
    console.log(clearAll
      ? 'No messages in queue. Nothing to clear.\n'
      : 'No failed messages in queue. Nothing to clear.\n');
    process.exit(0);
  }

  // Show details about messages to clear
  const messagesToShow = clearAll ? queue.messages : queue.messages.filter(m => m.status === 'failed');
  if (messagesToShow.length > 0) {
    console.log(clearAll ? 'Messages to Clear:' : 'Failed Messages:');
    console.log('─'.repeat(80));

    // Group by session
    const bySession = new Map<number, QueueMessage[]>();
    for (const msg of messagesToShow) {
      const list = bySession.get(msg.session_db_id) || [];
      list.push(msg);
      bySession.set(msg.session_db_id, list);
    }

    for (const [sessionId, messages] of bySession) {
      const project = messages[0].project || 'unknown';
      const oldest = Math.min(...messages.map(m => m.created_at_epoch));

      if (clearAll) {
        const statuses = {
          pending: messages.filter(m => m.status === 'pending').length,
          processing: messages.filter(m => m.status === 'processing').length,
          failed: messages.filter(m => m.status === 'failed').length
        };
        console.log(`  Session ${sessionId} (${project})`);
        console.log(`    Messages: ${messages.length} total (${statuses.pending} pending, ${statuses.processing} processing, ${statuses.failed} failed)`);
        console.log(`    Age:      ${formatAge(oldest)}`);
      } else {
        console.log(`  Session ${sessionId} (${project})`);
        console.log(`    Messages: ${messages.length} failed`);
        console.log(`    Age:      ${formatAge(oldest)}`);
      }
    }
    console.log('─'.repeat(80));
    console.log('');
  }

  // Confirm before clearing
  const clearMessage = clearAll
    ? `Clear ${totalToClear} messages (pending, processing, and failed)?`
    : `Clear ${queue.totalFailed} failed messages?`;

  if (force) {
    console.log(`${clearMessage.replace('?', '')}...\n`);
  } else {
    const answer = await prompt(`${clearMessage} [y/N]: `);
    if (answer.toLowerCase() !== 'y') {
      console.log('\nCancelled. Run with --force to skip confirmation.\n');
      process.exit(0);
    }
    console.log('');
  }

  // Clear the queue
  const result = clearAll ? await clearAllQueue() : await clearFailedQueue();

  console.log('Clearing Result:');
  console.log(`  Messages cleared: ${result.clearedCount}`);
  console.log(`  Status:           ${result.success ? 'Success' : 'Failed'}\n`);

  if (result.success && result.clearedCount > 0) {
    console.log(clearAll
      ? 'All messages have been removed from the queue.\n'
      : 'Failed messages have been removed from the queue.\n');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
