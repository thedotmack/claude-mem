/**
 * logs command — view worker logs.
 * cmem logs [options]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputSuccess } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';

interface LogsOpts {
  lines?: string;
  clear?: boolean;
  json?: boolean;
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('View worker logs')
    .option('-n, --lines <n>', 'number of log lines to return', '100')
    .option('--clear', 'clear the log file')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: LogsOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const config = loadConfig();
        const client = createMemoryClient(config);

        if (opts.clear) {
          const result = await client.clearLogs();
          if (mode === 'agent') {
            outputJSON(result);
          } else {
            outputSuccess(result.message, mode);
          }
          return;
        }

        const lines = opts.lines ? parseInt(opts.lines, 10) : 100;
        const response = await client.getLogs(lines);

        if (mode === 'agent') {
          outputJSON(response);
        } else {
          if (!response.exists) {
            process.stdout.write('Log file not found.\n');
          } else if (!response.logs.trim()) {
            process.stdout.write('Log file is empty.\n');
          } else {
            process.stdout.write(response.logs);
            if (!response.logs.endsWith('\n')) process.stdout.write('\n');
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
