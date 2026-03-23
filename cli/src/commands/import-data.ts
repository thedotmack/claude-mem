/**
 * import-data command — import memory data from a JSON file.
 * cmem import-data <file>
 *
 * Named import-data to avoid collision with the JS reserved word 'import'.
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputSuccess } from '../output.js';
import { CLIError, ExitCode, validationError } from '../errors.js';
import { readFileSync, existsSync } from 'fs';
import type { ImportPayload } from '../types.js';

interface ImportOpts {
  json?: boolean;
  dryRun?: boolean;
}

export function registerImportDataCommand(program: Command): void {
  program
    .command('import-data <file>')
    .description('Import memory data from a JSON file exported by cmem export-data')
    .option('--json', 'output as JSON for agent use')
    .option('--dry-run', 'parse file and show import stats without writing')
    .action(async (file: string, opts: ImportOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        if (!existsSync(file)) {
          throw validationError(`File not found: ${file}`);
        }

        let payload: ImportPayload;
        try {
          const raw = readFileSync(file, 'utf-8');
          payload = JSON.parse(raw) as ImportPayload;
        } catch {
          throw validationError(`Could not parse ${file} as JSON`);
        }

        if (opts.dryRun) {
          const stats = {
            sessions: payload.sessions?.length ?? 0,
            summaries: payload.summaries?.length ?? 0,
            observations: payload.observations?.length ?? 0,
            prompts: payload.prompts?.length ?? 0,
          };
          if (mode === 'agent') {
            outputJSON({ dryRun: true, file, stats });
          } else {
            process.stdout.write(`[dry-run] Would import from ${file}:\n`);
            process.stdout.write(`  Sessions:     ${stats.sessions}\n`);
            process.stdout.write(`  Summaries:    ${stats.summaries}\n`);
            process.stdout.write(`  Observations: ${stats.observations}\n`);
            process.stdout.write(`  Prompts:      ${stats.prompts}\n`);
          }
          return;
        }

        const config = loadConfig();
        const client = createMemoryClient(config);
        const result = await client.importData(payload);

        if (mode === 'agent') {
          outputJSON(result);
        } else {
          const s = result.stats;
          outputSuccess(
            [
              `Import complete:`,
              `  Observations: ${s.observationsImported} imported, ${s.observationsSkipped} skipped`,
              `  Sessions:     ${s.sessionsImported} imported, ${s.sessionsSkipped} skipped`,
              `  Summaries:    ${s.summariesImported} imported, ${s.summariesSkipped} skipped`,
              `  Prompts:      ${s.promptsImported} imported, ${s.promptsSkipped} skipped`,
            ].join('\n'),
            mode,
          );
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
