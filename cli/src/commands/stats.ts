/**
 * stats command — show worker and database statistics.
 * cmem stats
 */

import { homedir } from 'os';
import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputText } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { renderStats } from '../formatters/table.js';

interface StatsOpts {
  json?: boolean;
}

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show worker and database statistics')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: StatsOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const config = loadConfig();
        const client = createMemoryClient(config);

        const stats = await client.getStats();

        if (mode === 'agent') {
          const maskedPath = stats.database.path.replace(homedir(), '~');
          stats.database.path = maskedPath;
          outputJSON(stats);
        } else {
          outputText(renderStats(stats));
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
