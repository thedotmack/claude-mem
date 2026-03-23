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

interface ExportOpts {
  output?: string;
  json?: boolean;
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
        const client = createMemoryClient(config);

        // Export collects observations and sessions via paginated listing
        const [observations, summaries] = await Promise.all([
          client.listObservations({ limit: 10000 }),
          client.listSummaries({ limit: 10000 }),
        ]);

        const exportPayload = {
          exported_at: new Date().toISOString(),
          observations: observations.items,
          summaries: summaries.items,
        };

        if (opts.output) {
          writeFileSync(opts.output, JSON.stringify(exportPayload, null, 2), 'utf-8');
          if (mode === 'human') {
            process.stdout.write(`Exported to ${opts.output}\n`);
            process.stdout.write(`  ${observations.items.length} observations, ${summaries.items.length} sessions\n`);
          } else {
            outputJSON({ file: opts.output, observations: observations.total, summaries: summaries.total });
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
