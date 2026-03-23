/**
 * export-data command — export memory data to JSON.
 * cmem export-data [options]
 *
 * Named export-data to avoid collision with the JS reserved word 'export'.
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { writeFileSync } from 'fs';
import type { IMemoryClient } from '../memory-client.js';
import type { Observation, SessionSummary, ListParams } from '../types.js';

interface ExportOpts {
  output?: string;
  json?: boolean;
}

/** Fetch all pages of a paginated endpoint until hasMore is false. */
async function paginateAll<T>(
  fetcher: (params: ListParams) => Promise<{ items: T[]; hasMore: boolean }>,
  pageSize = 500,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;

  while (true) {
    const page = await fetcher({ limit: pageSize, offset });
    all.push(...page.items);
    if (!page.hasMore) break;
    offset += pageSize;
  }

  return all;
}

export function registerExportDataCommand(program: Command): void {
  program
    .command('export-data')
    .description('Export memory data to JSON (stdout or file)')
    .option('-o, --output <path>', 'write to file instead of stdout')
    .option('--json', 'wrap output in agent JSON envelope')
    .action(async (opts: ExportOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const config = loadConfig();
        const client = createMemoryClient(config) as IMemoryClient;

        // Paginate all entity types to avoid truncation
        const [observations, summaries] = await Promise.all([
          paginateAll<Observation>(p => client.listObservations(p)),
          paginateAll<SessionSummary>(p => client.listSummaries(p)),
        ]);

        const exportPayload = {
          exported_at: new Date().toISOString(),
          observations,
          summaries,
        };

        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify(exportPayload, null, 2), 'utf-8');
          if (mode === 'human') {
            process.stdout.write(`Exported to ${opts.output}\n`);
            process.stdout.write(`  ${observations.length} observations, ${summaries.length} sessions\n`);
          } else {
            outputJSON({ file: opts.output, observations: observations.length, summaries: summaries.length });
          }
        } else {
          if (mode === 'agent') {
            outputJSON(exportPayload);
          } else {
            process.stdout.write(JSON.stringify(exportPayload, null, 2) + '\n');
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
}
