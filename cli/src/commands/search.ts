/**
 * search command — full-text search across memory observations.
 * cmem search <query> [options]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputText } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { validateSearchQuery, validateLimit, validateOffset } from '../utils/validate.js';
import { renderSearchIndex } from '../formatters/table.js';

interface SearchOpts {
  limit?: string;
  project?: string;
  type?: string;
  obsType?: string;
  dateStart?: string;
  dateEnd?: string;
  offset?: string;
  order?: string;
  json?: boolean;
  /** When true, output only the result count and exit — useful for agents. */
  count?: boolean;
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query>')
    .description('Search memory observations')
    .option('-l, --limit <n>', 'max results', '20')
    .option('-p, --project <name>', 'filter by project')
    .option('-t, --type <type>', 'filter by type: observations|sessions|prompts')
    .option('--obs-type <type>', 'filter observations by obs type (decision|bugfix|feature|...)')
    .option('--date-start <date>', 'filter results after date (ISO or YYYY-MM-DD)')
    .option('--date-end <date>', 'filter results before date (ISO or YYYY-MM-DD)')
    .option('--offset <n>', 'pagination offset', '0')
    .option('--order <field>', 'sort order (relevance|date)')
    .option('--json', 'output as JSON for agent use')
    .option('--count', 'output only the result count (useful for agents that just need "how many")')
    .action(async (query: string, opts: SearchOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        validateSearchQuery(query);
        const limit = validateLimit(opts.limit, 100);
        const offset = validateOffset(opts.offset);

        const config = loadConfig();
        const client = createMemoryClient(config);

        const response = await client.search({
          query,
          type: opts.type,
          limit,
          offset,
          project: opts.project,
          obsType: opts.obsType,
          dateStart: opts.dateStart,
          dateEnd: opts.dateEnd,
          order: opts.order,
        });

        // --count: emit just the number and exit — ideal for agent if-branches
        if (opts.count) {
          if (mode === 'agent') {
            outputJSON([], {
              count: response.results.length,
              query,
              project: opts.project,
            });
          } else {
            outputText(String(response.results.length));
          }
          return;
        }

        if (mode === 'agent') {
          outputJSON(response.results, {
            count: response.results.length,
            query,
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
