#!/usr/bin/env bun

const DEFAULT_WORKER_PORT = 37777;

function resolveWorkerPort(): number {
  const raw = process.env.CLAUDE_MEM_WORKER_PORT;
  if (raw === undefined || raw === '') return DEFAULT_WORKER_PORT;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(
      `[check-pending-queue] Invalid CLAUDE_MEM_WORKER_PORT=${JSON.stringify(raw)}; ` +
        `falling back to ${DEFAULT_WORKER_PORT}`
    );
    return DEFAULT_WORKER_PORT;
  }
  return parsed;
}

const WORKER_PORT = resolveWorkerPort();
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const WORKER_FETCH_TIMEOUT_MS = 10_000;

interface ProcessingStatusResponse {
  isProcessing: boolean;
  queueDepth: number;
}

interface SetProcessingResponse {
  status: string;
  isProcessing: boolean;
  queueDepth: number;
  activeSessions: number;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMessage: string,
  timeoutMs: number = WORKER_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`${timeoutMessage} (timed out after ${timeoutMs}ms)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function checkWorkerHealth(): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${WORKER_URL}/api/health`,
      undefined,
      'Health check did not respond',
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function getProcessingStatus(): Promise<ProcessingStatusResponse> {
  const res = await fetchWithTimeout(
    `${WORKER_URL}/api/processing-status`,
    undefined,
    'Failed to get processing status',
  );
  if (!res.ok) {
    throw new Error(`Failed to get processing status: ${res.status}`);
  }
  return res.json() as Promise<ProcessingStatusResponse>;
}

async function triggerProcessing(): Promise<SetProcessingResponse> {
  const res = await fetchWithTimeout(
    `${WORKER_URL}/api/processing`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    },
    'Failed to trigger processing',
  );
  if (!res.ok) {
    throw new Error(`Failed to trigger processing: ${res.status}`);
  }
  return res.json() as Promise<SetProcessingResponse>;
}

async function prompt(question: string): Promise<string> {
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

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Claude-Mem Pending Queue Manager

Check current processing status and queue depth, optionally trigger processing.

Usage:
  bun scripts/check-pending-queue.ts [options]

Options:
  --help, -h     Show this help message
  --process      Trigger processing without prompting

Environment:
  CLAUDE_MEM_WORKER_PORT  Worker port (default: 37777)

Examples:
  # Check queue status interactively
  bun scripts/check-pending-queue.ts

  # Trigger processing non-interactively
  bun scripts/check-pending-queue.ts --process

What is this for?
  If the claude-mem worker has unprocessed observations queued, this script
  reports the current queue depth and lets you trigger processing.
`);
    process.exit(0);
  }

  const autoProcess = args.includes('--process');

  console.log('\n=== Claude-Mem Pending Queue Status ===\n');

  const healthy = await checkWorkerHealth();
  if (!healthy) {
    console.log(`Worker is not running at ${WORKER_URL}. Start it with:`);
    console.log('  cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:start\n');
    process.exit(1);
  }
  console.log(`Worker status: Running at ${WORKER_URL}\n`);

  const status = await getProcessingStatus();

  console.log('Queue Summary:');
  console.log(`  Processing: ${status.isProcessing ? 'yes' : 'no'}`);
  console.log(`  Queue depth: ${status.queueDepth}\n`);

  const hasBacklog = status.queueDepth > 0;

  if (!hasBacklog) {
    console.log('No backlog detected. Queue is empty.\n');
    process.exit(0);
  }

  if (autoProcess) {
    console.log('Triggering processing...\n');
  } else {
    const answer = await prompt(`Trigger processing for ${status.queueDepth} queued items? [y/N]: `);
    if (answer.toLowerCase() !== 'y') {
      console.log('\nSkipped. Run with --process to auto-process.\n');
      process.exit(0);
    }
    console.log('');
  }

  const result = await triggerProcessing();

  console.log('Processing Result:');
  console.log(`  Status:           ${result.status}`);
  console.log(`  Is processing:    ${result.isProcessing ? 'yes' : 'no'}`);
  console.log(`  Queue depth:      ${result.queueDepth}`);
  console.log(`  Active sessions:  ${result.activeSessions}`);

  console.log('\nProcessing handled by worker. Check status again in a few minutes.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
