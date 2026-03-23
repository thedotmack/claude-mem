/**
 * decisions command — list key decisions from memory.
 * cmem decisions [options]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputText } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { validateLimit } from '../utils/validate.js';
import { renderSearchIndex } from '../formatters/table.js';

interface DecisionsOpts {
  limit?: string;
  project?: string;
  json?: boolean;
}

export function registerDecisionsCommand(program: Command): void {
  program
    .command('decisions')
    .description('List key decisions stored in memory')
    .option('-l, --limit <n>', 'max results', '20')
    .option('-p, --project <name>', 'filter by project')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: DecisionsOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const limit = validateLimit(opts.limit, 100);
        const config = loadConfig();
        const client = createMemoryClient(config);

        const response = await client.decisions({ limit, project: opts.project });

        if (mode === 'agent') {
          outputJSON(response.results, {
            count: response.results.length,
            project: opts.project,
          });
        } else {
          outputText(renderSearchIndex(response.results));
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
