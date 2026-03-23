/**
 * remember command — save a memory observation manually.
 * cmem remember <text> [options]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputSuccess } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { validateSearchQuery } from '../utils/validate.js';

interface RememberOpts {
  title?: string;
  project?: string;
  json?: boolean;
  dryRun?: boolean;
}

export function registerRememberCommand(program: Command): void {
  program
    .command('remember <text>')
    .description('Save a memory observation manually')
    .option('--title <title>', 'observation title (auto-generated if omitted)')
    .option('-p, --project <name>', 'project to file under')
    .option('--json', 'output as JSON for agent use')
    .option('--dry-run', 'preview what would be saved without writing')
    .action(async (text: string, opts: RememberOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        validateSearchQuery(text);

        if (opts.dryRun) {
          if (mode === 'agent') {
            outputJSON({ dryRun: true, text, title: opts.title, project: opts.project });
          } else {
            process.stdout.write(`[dry-run] Would save:\n`);
            process.stdout.write(`  text:    ${text}\n`);
            if (opts.title) process.stdout.write(`  title:   ${opts.title}\n`);
            if (opts.project) process.stdout.write(`  project: ${opts.project}\n`);
          }
          return;
        }

        const config = loadConfig();
        const client = createMemoryClient(config);

        const result = await client.saveMemory(text, opts.title, opts.project);

        if (mode === 'agent') {
          outputJSON(result);
        } else {
          outputSuccess(`Saved: #${result.id} — ${result.title}`, mode);
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
