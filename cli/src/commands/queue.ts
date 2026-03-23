/**
 * queue command — view and manage the processing queue.
 * cmem queue [status|process|clear]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputSuccess } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';

interface QueueOpts {
  json?: boolean;
}

export function registerQueueCommand(program: Command): void {
  const queueCmd = program
    .command('queue')
    .description('View and manage the observation processing queue');

  queueCmd
    .command('status')
    .description('Show queue depth and processing state')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: QueueOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const client = createMemoryClient(loadConfig());
        const [status, queue] = await Promise.all([
          client.getProcessingStatus(),
          client.getPendingQueue(),
        ]);

        if (mode === 'agent') {
          outputJSON({ status, queue });
        } else {
          process.stdout.write(`Processing: ${status.isProcessing ? 'yes' : 'no'}\n`);
          process.stdout.write(`Queue depth: ${status.queueDepth}\n`);
          process.stdout.write(`Pending: ${queue.queue.totalPending}  Failed: ${queue.queue.totalFailed}  Stuck: ${queue.queue.stuckCount}\n`);
          if (queue.queue.messages.length > 0) {
            process.stdout.write('\nPending messages:\n');
            for (const msg of queue.queue.messages.slice(0, 10)) {
              process.stdout.write(`  #${msg.id} [${msg.status}] ${msg.type}\n`);
            }
          }
        }
      } catch (err) {
        const cliErr = err instanceof CLIError
          ? err
          : new CLIError((err as Error).message, ExitCode.INTERNAL_ERROR);
        outputError(cliErr, mode);
        process.exit(cliErr.code);
      }
    });

  queueCmd
    .command('process')
    .description('Trigger immediate processing of pending queue items')
    .option('--limit <n>', 'max sessions to process', '10')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: QueueOpts & { limit?: string }) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const sessionLimit = opts.limit ? parseInt(opts.limit, 10) : undefined;
        const client = createMemoryClient(loadConfig());
        const result = await client.processPendingQueue(sessionLimit);

        if (mode === 'agent') {
          outputJSON(result);
        } else {
          outputSuccess('Queue processing triggered.', mode);
        }
      } catch (err) {
        const cliErr = err instanceof CLIError
          ? err
          : new CLIError((err as Error).message, ExitCode.INTERNAL_ERROR);
        outputError(cliErr, mode);
        process.exit(cliErr.code);
      }
    });

  queueCmd
    .command('clear')
    .description('Clear failed queue items (pass --all to clear everything)')
    .option('--all', 'clear all queue items, not just failed')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: QueueOpts & { all?: boolean }) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const client = createMemoryClient(loadConfig());
        const result = opts.all
          ? await client.clearAllQueue()
          : await client.clearFailedQueue();

        if (mode === 'agent') {
          outputJSON(result);
        } else {
          outputSuccess(`Cleared ${result.clearedCount} queue item(s).`, mode);
        }
      } catch (err) {
        const cliErr = err instanceof CLIError
          ? err
          : new CLIError((err as Error).message, ExitCode.INTERNAL_ERROR);
        outputError(cliErr, mode);
        process.exit(cliErr.code);
      }
    });
}
