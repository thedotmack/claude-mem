#!/usr/bin/env node

// <Block> 1.1 ====================================
// CLI Dependencies and Imports Setup
// Natural pattern: Import what you need before using it
import { Command } from 'commander';
import { PACKAGE_NAME, PACKAGE_VERSION, PACKAGE_DESCRIPTION } from '../shared/config.js';

// Import command handlers
import { install } from '../commands/install.js';
import { uninstall } from '../commands/uninstall.js';
import { logs } from '../commands/logs.js';
import { trash } from '../commands/trash.js';
import { viewTrash } from '../commands/trash-view.js';
import { emptyTrash } from '../commands/trash-empty.js';
import { restore } from '../commands/restore.js';
import { doctor } from '../commands/doctor.js';
import { status } from '../commands/status.js';

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

// Doctor command
program
  .command('doctor')
  .description('Run health checks on claude-mem installation')
  .option('--json', 'Output results as JSON')
  .action(doctor);

// Status command
program
  .command('status')
  .description('Show claude-mem system status')
  .action(status);
// </Block> =======================================

// <Block> 1.9 ====================================
// Hook Commands Definition
// Natural pattern: Define hook commands for Claude Code integration
// Hook commands (for Claude Code hook integration)
program
  .command('context')
  .description('SessionStart hook - show recent session context')
  .action(async () => {
    const { contextHook } = await import('../hooks/index.js');
    const input = await readStdin();
    contextHook(JSON.parse(input));
  });

program
  .command('new')
  .description('UserPromptSubmit hook - initialize SDK session')
  .action(async () => {
    const { newHook } = await import('../hooks/index.js');
    const input = await readStdin();
    newHook(JSON.parse(input));
  });

program
  .command('save')
  .description('PostToolUse hook - queue observation')
  .action(async () => {
    const { saveHook } = await import('../hooks/index.js');
    const input = await readStdin();
    saveHook(JSON.parse(input));
  });

program
  .command('summary')
  .description('Stop hook - finalize session')
  .action(async () => {
    const { summaryHook } = await import('../hooks/index.js');
    const input = await readStdin();
    summaryHook(JSON.parse(input));
  });

// Helper function to read stdin
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

// </Block> =======================================

// <Block> 1.11 ===================================
// CLI Execution
// Natural pattern: After defining all commands, parse and execute
// Parse arguments and execute
program.parse();
// </Block> =======================================

// <Block> 1.11 ===================================
// Module Exports for Programmatic Use
// Export database and utility classes for hooks and external consumers
export { DatabaseManager, migrations, initializeDatabase, getDatabase } from '../services/sqlite/index.js';
// </Block> =======================================
