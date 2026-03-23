/**
 * settings command — view and update worker settings.
 * cmem settings [get <key>] [set <key> <value>] [list]
 */

import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { createMemoryClient } from '../client-factory.js';
import { detectOutputMode, outputJSON, outputError, outputSuccess } from '../output.js';
import { CLIError, ExitCode } from '../errors.js';
import { validateSettingKey, getAllowedSettingKeys } from '../utils/validate.js';

interface SettingsOpts {
  json?: boolean;
  dryRun?: boolean;
}

export function registerSettingsCommand(program: Command): void {
  const settingsCmd = program
    .command('settings')
    .description('View and update worker settings');

  settingsCmd
    .command('list')
    .description('List all current settings')
    .option('--json', 'output as JSON for agent use')
    .action(async (opts: SettingsOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        const client = createMemoryClient(loadConfig());
        const settings = await client.getSettings();

        if (mode === 'agent') {
          outputJSON(settings);
        } else {
          const entries = Object.entries(settings);
          if (entries.length === 0) {
            process.stdout.write('No settings configured.\n');
          } else {
            for (const [k, v] of entries) {
              process.stdout.write(`  ${k} = ${v}\n`);
            }
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

  settingsCmd
    .command('get <key>')
    .description('Get a specific setting value')
    .option('--json', 'output as JSON for agent use')
    .action(async (key: string, opts: SettingsOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        validateSettingKey(key);
        const client = createMemoryClient(loadConfig());
        const settings = await client.getSettings();
        const value = settings[key];

        if (mode === 'agent') {
          outputJSON({ key, value: value ?? null });
        } else {
          process.stdout.write(value !== undefined ? `${key} = ${value}\n` : `${key} is not set.\n`);
        }
      } catch (err) {
        const cliErr = err instanceof CLIError
          ? err
          : new CLIError((err as Error).message, ExitCode.INTERNAL_ERROR);
        outputError(cliErr, mode);
        process.exit(cliErr.code);
      }
    });

  settingsCmd
    .command('set <key> <value>')
    .description('Update a setting')
    .option('--json', 'output as JSON for agent use')
    .option('--dry-run', 'preview what would be set without writing')
    .action(async (key: string, value: string, opts: SettingsOpts) => {
      const mode = detectOutputMode({ json: opts.json });
      try {
        validateSettingKey(key);

        if (opts.dryRun) {
          if (mode === 'agent') {
            outputJSON({ dryRun: true, key, value });
          } else {
            process.stdout.write(`[dry-run] Would set: ${key} = ${value}\n`);
          }
          return;
        }

        const client = createMemoryClient(loadConfig());
        const result = await client.updateSettings({ [key]: value });

        if (mode === 'agent') {
          outputJSON(result);
        } else {
          outputSuccess(`Set ${key} = ${value}`, mode);
        }
      } catch (err) {
        const cliErr = err instanceof CLIError
          ? err
          : new CLIError((err as Error).message, ExitCode.INTERNAL_ERROR);
        outputError(cliErr, mode);
        process.exit(cliErr.code);
      }
    });

  settingsCmd
    .command('keys')
    .description('List all valid setting keys')
    .action(() => {
      for (const key of getAllowedSettingKeys()) {
        process.stdout.write(`  ${key}\n`);
      }
    });
}
