#!/usr/bin/env node

// <Block> 1.1 ====================================
// CLI Dependencies and Imports Setup
// Natural pattern: Import what you need before using it
import { Command } from 'commander';
import { PACKAGE_NAME, PACKAGE_VERSION, PACKAGE_DESCRIPTION } from '../shared/config.js';

// Import command handlers
import { compress } from '../commands/compress.js';
import { install } from '../commands/install.js';
import { uninstall } from '../commands/uninstall.js';
import { status } from '../commands/status.js';
import { logs } from '../commands/logs.js';
import { loadContext } from '../commands/load-context.js';
import { trash } from '../commands/trash.js';
import { restore } from '../commands/restore.js';
import { save } from '../commands/save.js';
import { changelog } from '../commands/changelog.js';
// Cloud functionality disabled - incomplete setup
// import { cloudCommand } from '../commands/cloud.js';
import { importHistory } from '../commands/import-history.js';
import { TranscriptCompressor } from '../core/compression/TranscriptCompressor.js';

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
// Compress Command Definition
// Natural pattern: Define command with its options and handler
// Compress command
program
  .command('compress [transcript]')
  .description('Compress a Claude Code transcript into memory')
  .option('--output <path>', 'Output directory for compressed files')
  .option('--dry-run', 'Show what would be compressed without doing it')
  .option('-v, --verbose', 'Show detailed output')
  .action(compress);
// </Block> =======================================

// <Block> 1.4 ====================================
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
  .action(async () => {
    const { viewTrash } = await import('../commands/trash-view.js');
    await viewTrash();
  });

// Trash empty subcommand
trashCmd
  .command('empty')
  .description('Permanently delete all files in trash')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (options: any) => {
    const { emptyTrash } = await import('../commands/trash-empty.js');
    await emptyTrash(options);
  });

// Restore command
program
  .command('restore')
  .description('Restore files from trash interactively')
  .action(restore);
// </Block> =======================================

// Cloud command
// Cloud functionality disabled - incomplete setup
// program.addCommand(cloudCommand);

// Save command
program
  .command('save <message>')
  .description('Save a message to the memory system')
  .action(save);

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

// Import History command
program
  .command('import-history')
  .description('Import historical Claude Code conversations into memory')
  .option('-v, --verbose', 'Show detailed output')
  .option('-m, --multi', 'Enable multi-select mode (default is single-select)')
  .action(importHistory);

// <Block> 1.11 ===================================  
// Hook Commands
// Internal commands called by hook scripts
program
  .command('hook:pre-compact', { hidden: true })
  .description('Internal pre-compact hook handler')
  .action(async () => {
    const { preCompactHook } = await import('../commands/hooks.js');
    await preCompactHook();
  });

program
  .command('hook:session-start', { hidden: true })
  .description('Internal session-start hook handler')
  .action(async () => {
    const { sessionStartHook } = await import('../commands/hooks.js');
    await sessionStartHook();
  });

program
  .command('hook:session-end', { hidden: true })
  .description('Internal session-end hook handler')
  .action(async () => {
    const { sessionEndHook } = await import('../commands/hooks.js');
    await sessionEndHook();
  });

// </Block> =======================================

// Debug command to show filtered output
program
  .command('debug-filter')
  .description('Show filtered transcript output (first 5 messages)')
  .argument('<transcript-path>', 'Path to transcript file')
  .action((transcriptPath) => {
    const compressor = new TranscriptCompressor();
    compressor.showFilteredOutput(transcriptPath);
  });

// <Block> 1.11 ===================================
// CLI Execution
// Natural pattern: After defining all commands, parse and execute
// Parse arguments and execute
program.parse();
// </Block> =======================================