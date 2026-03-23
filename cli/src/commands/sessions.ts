/**
 * sessions — Browse session summaries.
 * cmem sessions [--limit N] [--offset N] [--project P] [--json]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError } from '../output.js';
import { ExitCode } from '../errors.js';

export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('Browse session summaries')
    .option('-l, --limit <n>', 'Number of results (default 20)', '20')
    .option('--offset <n>', 'Pagination offset', '0')
    .option('-p, --project <name>', 'Filter by project')
    .option('--json', 'Output as JSON')
    .action(async (opts: { limit: string; offset: string; project?: string; json?: boolean }) => {
      const mode = detectOutputMode(opts);
      const client = createMemoryClient(loadConfig());

      try {
        const limit = parseInt(opts.limit, 10) || 20;
        const offset = parseInt(opts.offset, 10) || 0;

        const result = await client.listSummaries({
          limit,
          offset,
          project: opts.project,
        });

        if (mode === 'agent') {
          outputJSON(result, {
            count: result.items.length,
            hasMore: result.hasMore,
            offset: result.offset,
            limit: result.limit,
            project: opts.project,
          });
        } else {
          if (result.items.length === 0) {
            process.stdout.write('No sessions found.\n');
          } else {
            for (const s of result.items) {
              const time = new Date(s.created_at_epoch).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              });
              const project = s.project ? ` [${s.project}]` : '';
              const sid = s.content_session_id
                ? ` (${s.content_session_id.slice(0, 8)})`
                : '';
              process.stdout.write(`\u25cb #${s.id}${sid}${project} — ${time}\n`);
              if (s.summary_text) {
                const preview = s.summary_text.slice(0, 120);
                const ellipsis = s.summary_text.length > 120 ? '\u2026' : '';
                process.stdout.write(`   ${preview}${ellipsis}\n`);
              }
              if (s.key_decisions) {
                process.stdout.write(`   Decisions: ${s.key_decisions.slice(0, 80)}\n`);
              }
            }
            process.stdout.write(
              `\n${result.items.length} of ${result.total} (offset ${result.offset})\n`,
            );
            if (result.hasMore) {
              process.stdout.write(
                `  Next: cmem sessions --offset ${result.offset + result.limit}\n`,
              );
            }
          }
        }
      } catch (err) {
        outputError(err as Error, mode);
        process.exit(ExitCode.WORKER_ERROR);
      }
    });
}
