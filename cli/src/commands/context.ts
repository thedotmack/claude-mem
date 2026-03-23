/**
 * context — Get context injection preview.
 * cmem context --project <name> [--full] [--colors] [--json]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError } from '../output.js';
import { validationError } from '../errors.js';
import { ExitCode } from '../errors.js';

export function registerContextCommand(program: Command): void {
  program
    .command('context')
    .description('Get context injection preview for a project')
    .requiredOption('-p, --project <name>', 'Project name (required)')
    .option('--full', 'Return full context (not truncated)')
    .option('--colors', 'Include ANSI color codes in output')
    .option('--json', 'Output as JSON (wraps plain text in JSON envelope)')
    .action(async (opts: { project: string; full?: boolean; colors?: boolean; json?: boolean }) => {
      const mode = detectOutputMode(opts);
      const client = createMemoryClient(loadConfig());

      try {
        if (!opts.project || opts.project.trim().length === 0) {
          throw validationError('--project is required');
        }

        const text = await client.getContext(opts.project, {
          full: opts.full,
          colors: opts.colors,
        });

        if (mode === 'agent') {
          outputJSON({ text, project: opts.project });
        } else {
          process.stdout.write(text);
          if (!text.endsWith('\n')) process.stdout.write('\n');
        }
      } catch (err) {
        outputError(err as Error, mode);
        process.exit(ExitCode.WORKER_ERROR);
      }
    });
}
