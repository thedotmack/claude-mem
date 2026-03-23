/**
 * observations — Browse paginated observations.
 * cmem observations [--limit N] [--offset N] [--project P] [--json]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError } from '../output.js';
import { getTypeIcon } from '../formatters/icons.js';
import { ExitCode } from '../errors.js';

export function registerObservationsCommand(program: Command): void {
  program
    .command('observations')
    .description('Browse paginated observations')
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

        const result = await client.listObservations({
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
            process.stdout.write('No observations found.\n');
          } else {
            for (const obs of result.items) {
              const icon = getTypeIcon(obs.type);
              const time = new Date(obs.created_at_epoch).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              });
              const project = obs.project ? ` [${obs.project}]` : '';
              process.stdout.write(`${icon} #${obs.id} ${obs.title}${project}\n`);
              process.stdout.write(`   ${time} | ${obs.type}\n`);
            }
            const countLabel = result.hasMore
              ? `${result.items.length}+ results (more available)`
              : `${result.items.length} results`;
            process.stdout.write(`\n${countLabel}\n`);
            if (result.hasMore) {
              process.stdout.write(
                `  Next: cmem observations --offset ${(result.offset ?? 0) + (result.limit ?? 20)}\n`,
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
