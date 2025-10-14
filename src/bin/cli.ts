#!/usr/bin/env node

// <Block> 1.1 ====================================
// CLI Dependencies and Imports Setup
// Natural pattern: Import what you need before using it
import { Command } from 'commander';
import { PACKAGE_NAME, PACKAGE_VERSION, PACKAGE_DESCRIPTION } from '../shared/config.js';

// Import command handlers
import { install } from '../commands/install.js';
import { uninstall } from '../commands/uninstall.js';
import { status } from '../commands/status.js';
import { logs } from '../commands/logs.js';
import { loadContext } from '../commands/load-context.js';
import { trash } from '../commands/trash.js';
import { viewTrash } from '../commands/trash-view.js';
import { emptyTrash } from '../commands/trash-empty.js';
import { restore } from '../commands/restore.js';
import { changelog } from '../commands/changelog.js';
import { doctor } from '../commands/doctor.js';
import { storeMemory } from '../commands/store-memory.js';
import { storeOverview } from '../commands/store-overview.js';
import { updateSessionMetadata } from '../commands/update-session-metadata.js';
import { generateTitle } from '../commands/generate-title.js';

const program = new Command();
// </Block> =======================================

// <Block> 1.2 ====================================
// Program Configuration
// Natural pattern: Configure program metadata first
program
  .name(PACKAGE_NAME)
  .description(PACKAGE_DESCRIPTION)
  .version(PACKAGE_VERSION);
// </Block> =======================================

// <Block> 1.3 ====================================
// Install Command Definition
// Natural pattern: Define command with its options and handler
// Install command
program
  .command('install')
  .description('Install Claude Code hooks for automatic compression')
  .option('--user', 'Install for current user (default)')
  .option('--project', 'Install for current project only')
  .option('--local', 'Install to custom local directory')
  .option('--path <path>', 'Custom installation path (with --local)')
  .option('--timeout <ms>', 'Hook execution timeout in milliseconds', '180000')
  .option('--skip-mcp', 'Skip Chroma MCP server installation')
  .option('--force', 'Force installation even if already installed')
  .action(install);
// </Block> =======================================

// <Block> 1.5 ====================================
// Uninstall Command Definition
// Natural pattern: Define command with its options and handler
// Uninstall command
program
  .command('uninstall')
  .description('Remove Claude Code hooks')
  .option('--user', 'Remove from user settings (default)')
  .option('--project', 'Remove from project settings')
  .option('--all', 'Remove from both user and project settings')
  .action(uninstall);
// </Block> =======================================


// <Block> 1.6 ====================================
// Status Command Definition
// Natural pattern: Define command with its handler
// Status command
program
  .command('status')
  .description('Check installation status of Claude Memory System')
  .action(status);

// Doctor command
program
  .command('doctor')
  .description('Run environment and pipeline diagnostics for rolling memory')
  .option('--json', 'Output JSON instead of text')
  .action(async (options: any) => {
    try {
      await doctor(options);
    } catch (error: any) {
      console.error(`doctor failed: ${error.message || error}`);
      process.exitCode = 1;
    }
  });
// </Block> =======================================

// <Block> 1.7 ====================================
// Logs Command Definition
// Natural pattern: Define command with its options and handler
// Logs command
program
  .command('logs')
  .description('View claude-mem operation logs')
  .option('--debug', 'Show debug logs only')
  .option('--error', 'Show error logs only')
  .option('--tail [n]', 'Show last n lines', '50')
  .option('--follow', 'Follow log output')
  .action(logs);
// </Block> =======================================

// <Block> 1.8 ====================================
// Load-Context Command Definition
// Natural pattern: Define command with its options and handler
// Load-context command
program
  .command('load-context')
  .description('Load compressed memories for current session')
  .option('--project <name>', 'Filter by project name')
  .option('--count <n>', 'Number of memories to load', '10')
  .option('--raw', 'Output raw JSON instead of formatted text')
  .option('--format <type>', 'Output format: json, session-start, or default')
  .action(loadContext);
// </Block> =======================================

// <Block> 1.9 ====================================
// Trash and Restore Commands Definition
// Natural pattern: Define commands for safe file operations

// Trash command with subcommands
const trashCmd = program
  .command('trash')
  .description('Manage trash bin for safe file deletion')
  .argument('[files...]', 'Files to move to trash')
  .option('-r, --recursive', 'Remove directories recursively')
  .option('-R', 'Remove directories recursively (same as -r)')
  .option('-f, --force', 'Suppress errors for nonexistent files')
  .action(async (files: string[] | undefined, options: any) => {
    // If no files provided, show help
    if (!files || files.length === 0) {
      trashCmd.outputHelp();
      return;
    }
    
    // Map -R to recursive
    if (options.R) options.recursive = true;
    
    await trash(files, {
      force: options.force,
      recursive: options.recursive
    });
  });

// Trash view subcommand
trashCmd
  .command('view')
  .description('View contents of trash bin')
  .action(viewTrash);

// Trash empty subcommand
trashCmd
  .command('empty')
  .description('Permanently delete all files in trash')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(emptyTrash);

// Restore command
program
  .command('restore')
  .description('Restore files from trash interactively')
  .action(restore);
// </Block> =======================================

// Store memory command (for SDK streaming)
program
  .command('store-memory')
  .description('Store a memory to all storage layers (used by SDK)')
  .requiredOption('--id <id>', 'Memory ID')
  .requiredOption('--project <project>', 'Project name')
  .requiredOption('--session <session>', 'Session ID')
  .requiredOption('--date <date>', 'Date (YYYY-MM-DD)')
  .requiredOption('--title <title>', 'Memory title (3-8 words)')
  .requiredOption('--subtitle <subtitle>', 'Memory subtitle (max 24 words)')
  .requiredOption('--facts <json>', 'Atomic facts as JSON array')
  .option('--concepts <json>', 'Concept tags as JSON array')
  .option('--files <json>', 'Files touched as JSON array')
  .action(storeMemory);

// Store overview command (for SDK streaming)
program
  .command('store-overview')
  .description('Store a session overview (used by SDK)')
  .requiredOption('--project <project>', 'Project name')
  .requiredOption('--session <session>', 'Session ID')
  .requiredOption('--content <content>', 'Overview content')
  .action(storeOverview);

// Update session metadata command (for SDK streaming)
program
  .command('update-session-metadata')
  .description('Update session title and subtitle (used by SDK)')
  .requiredOption('--project <project>', 'Project name')
  .requiredOption('--session <session>', 'Session ID')
  .requiredOption('--title <title>', 'Session title (3-6 words)')
  .option('--subtitle <subtitle>', 'Session subtitle (max 20 words)')
  .action(updateSessionMetadata);

// Changelog command
program
  .command('changelog')
  .description('Generate CHANGELOG.md from claude-mem memories')
  .option('--historical <n>', 'Number of versions to search (default: current version only)')
  .option('--generate <version>', 'Generate changelog for a specific version')
  .option('--start <time>', 'Start time for memory search (ISO format)')
  .option('--end <time>', 'End time for memory search (ISO format)')
  .option('--update', 'Update CHANGELOG.md from JSONL entries')
  .option('--preview', 'Preview the generated changelog')
  .option('-v, --verbose', 'Show detailed output')
  .action(changelog);

// Generate title command
program
  .command('generate-title <prompt>')
  .description('Generate a session title and subtitle from a prompt')
  .option('--json', 'Output as JSON')
  .option('--oneline', 'Output as single line (title - subtitle)')
  .option('--session-id <id>', 'Claude session ID to update')
  .option('--save', 'Save the generated title to the database (requires --session-id)')
  .action(generateTitle);

// </Block> =======================================

// <Block> 1.11 ===================================
// CLI Execution
// Natural pattern: After defining all commands, parse and execute
// Parse arguments and execute
program.parse();
// </Block> =======================================

// <Block> 1.12 ===================================
// Module Exports for Programmatic Use
// Export database and utility classes for hooks and external consumers
export { DatabaseManager, StreamingSessionStore, migrations, initializeDatabase, getDatabase } from '../services/sqlite/index.js';
// </Block> =======================================
