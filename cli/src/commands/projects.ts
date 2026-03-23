/**
 * projects command — list all known projects in memory.
 * cmem projects
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputText } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { renderProjects } from '../formatters/table.js';

interface ProjectsOpts {
  json?: boolean;
}

export function registerProjectsCommand(program: Command): void {
  program
    .command('projects')
    .description('List all known projects in memory')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: ProjectsOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const config = loadConfig();
        const client = createMemoryClient(config);

        const response = await client.getProjects();

        if (mode === 'agent') {
          outputJSON(response.projects, { count: response.projects.length });
        } else {
          outputText(renderProjects(response.projects));
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
