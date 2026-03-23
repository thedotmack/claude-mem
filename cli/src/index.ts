#!/usr/bin/env node
/**
 * cmem — CLI for persistent AI agent memory.
 *
 * cmem connects to a running memory worker (default: http://localhost:37777)
 * and exposes its capabilities as a structured command-line interface. It is
 * designed to be consumed both by humans (formatted tables, timelines) and by
 * other AI agents (--json output with structured CLIResponse envelopes).
 *
 * Command groups:
 *   Search & browse  — search, timeline, get, observations, sessions
 *   Summaries        — stats, projects, context
 *   Write            — remember
 *   Infrastructure   — settings, logs, worker, queue
 *   Live stream      — stream, endless
 *   Curated lists    — decisions, changes, how
 *   Data portability — export-data, import-data
 *
 * Configuration is read from ~/.cmem/config.json (or the path set by
 * CMEM_CONFIG env var). Run `cmem settings` to inspect or edit it.
 *
 * Entry point: registers all commands via Commander and parses process.argv.
 */

import { Command } from 'commander';
import { getVersion } from './utils/version.js';

// Search & browse
import { registerSearchCommand } from './commands/search.js';
import { registerTimelineCommand } from './commands/timeline.js';
import { registerGetCommand } from './commands/get.js';
import { registerObservationsCommand } from './commands/observations.js';
import { registerSessionsCommand } from './commands/sessions.js';

// Summary commands
import { registerStatsCommand } from './commands/stats.js';
import { registerProjectsCommand } from './commands/projects.js';
import { registerContextCommand } from './commands/context.js';

// Write
import { registerRememberCommand } from './commands/remember.js';

// Infrastructure
import { registerSettingsCommand } from './commands/settings.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerWorkerCommand } from './commands/worker.js';
import { registerQueueCommand } from './commands/queue.js';

// Live stream
import { registerStreamCommand } from './commands/stream.js';
import { registerEndlessCommand } from './commands/endless.js';

// Curated list commands
import { registerDecisionsCommand } from './commands/decisions.js';
import { registerChangesCommand } from './commands/changes.js';
import { registerHowCommand } from './commands/how.js';

// Data portability
import { registerExportDataCommand } from './commands/export-data.js';
import { registerImportDataCommand } from './commands/import-data.js';

const program = new Command();

program
  .name('cmem')
  .description('CLI for persistent AI agent memory — search, stream, and manage context across sessions')
  .version(getVersion(), '-v, --version', 'output the current version');

// Register all commands
registerSearchCommand(program);
registerTimelineCommand(program);
registerGetCommand(program);
registerObservationsCommand(program);
registerSessionsCommand(program);
registerStatsCommand(program);
registerProjectsCommand(program);
registerContextCommand(program);
registerRememberCommand(program);
registerSettingsCommand(program);
registerLogsCommand(program);
registerWorkerCommand(program);
registerQueueCommand(program);
registerStreamCommand(program);
registerEndlessCommand(program);
registerDecisionsCommand(program);
registerChangesCommand(program);
registerHowCommand(program);
registerExportDataCommand(program);
registerImportDataCommand(program);

program.parse();
