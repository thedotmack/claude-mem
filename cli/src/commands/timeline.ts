/**
 * timeline command — view memory in chronological context.
 * cmem timeline [anchor] [options]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputText } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { renderTimeline } from '../formatters/table.js';

interface TimelineOpts {
  query?: string;
  before?: string;
  after?: string;
  project?: string;
  json?: boolean;
}

export function registerTimelineCommand(program: Command): void {
  program
    .command('timeline [anchor]')
    .description('View memory timeline around an anchor ID or query')
    .option('-q, --query <text>', 'timeline by search query instead of anchor')
    .option('-b, --before <n>', 'items before anchor', '5')
    .option('-a, --after <n>', 'items after anchor', '5')
    .option('-p, --project <name>', 'filter by project')
    .option('--json', 'output as JSON for agent use')
    .action(async (anchor: string | undefined, opts: TimelineOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const depthBefore = parseInt(opts.before ?? '5', 10);
        const depthAfter = parseInt(opts.after ?? '5', 10);

        const config = loadConfig();
        const client = createMemoryClient(config);

        const response = await client.timeline({
          anchor,
          query: opts.query,
          depthBefore,
          depthAfter,
          project: opts.project,
        });

        if (mode === 'agent') {
          outputJSON(response.items, {
            count: response.items.length,
            query: opts.query,
            project: opts.project,
          });
        } else {
          outputText(renderTimeline(response.items));
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
