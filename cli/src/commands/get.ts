/**
 * get command — retrieve full observation details by ID.
 * cmem get <ids...>
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputText } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { validateIds } from '../utils/validate.js';
import { stripPrivateTags } from '../utils/privacy.js';
import { renderObservations } from '../formatters/table.js';
import type { Observation } from '../types.js';

interface GetOpts {
  order?: string;
  project?: string;
  json?: boolean;
}

function parseJsonArray(value: string[] | string | undefined | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function sanitizeObservation(obs: Observation): Observation {
  return {
    ...obs,
    narrative: obs.narrative ? stripPrivateTags(obs.narrative) : obs.narrative,
    facts: parseJsonArray(obs.facts).map(stripPrivateTags),
    concepts: parseJsonArray(obs.concepts),
    files_read: parseJsonArray(obs.files_read),
    files_modified: parseJsonArray(obs.files_modified),
  };
}

export function registerGetCommand(program: Command): void {
  program
    .command('get <ids...>')
    .description('Get full observation details by ID')
    .option('--order <field>', 'sort order (id|date)')
    .option('-p, --project <name>', 'filter by project')
    .option('--json', 'output as JSON for agent use')
    .action(async (ids: string[], opts: GetOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const numericIds = validateIds(ids);

        const config = loadConfig();
        const client = createMemoryClient(config);

        const observations = await client.getObservations({
          ids: numericIds,
          orderBy: opts.order,
          project: opts.project,
        });

        const sanitized = observations.map(sanitizeObservation);

        if (mode === 'agent') {
          outputJSON(sanitized, { count: sanitized.length });
        } else {
          outputText(renderObservations(sanitized));
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
