/**
 * Commander.js CLI Entry Point
 *
 * Thin wiring layer that maps CLI commands to existing handler functions.
 * Phase 1: hooks, generate, clean, and cursor are fully wired.
 * Daemon management commands (start, stop, restart, status, daemon) are
 * stubbed — they will be extracted from worker-service.ts in Phase 2.
 */

import { Command } from 'commander';

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

const program = new Command();

program
  .name('claude-mem')
  .version(packageVersion)
  .description('Memory compression system for Claude Code');

// ============================================================================
// Daemon Management Commands (Phase 2 stubs)
// ============================================================================

program
  .command('start')
  .description('Start the worker daemon')
  .action(handleStart);

program
  .command('stop')
  .description('Stop the worker daemon')
  .action(handleStop);

program
  .command('restart')
  .description('Restart the worker daemon')
  .action(handleRestart);

program
  .command('status')
  .description('Show worker daemon status')
  .action(handleStatus);

// ============================================================================
// Hook Command Group
// ============================================================================

const hookCmd = new Command('hook')
  .description('Run a lifecycle hook')
  .option('--platform <name>', 'Platform adapter to use', 'claude-code');

const hookEventNames = [
  'context',
  'session-init',
  'observation',
  'summarize',
  'session-complete',
  'user-message',
  'file-edit',
] as const;

const hookAction = (event: string) => async () => {
  const platform = hookCmd.opts().platform;
  const { hookCommand } = await import('./hook-command.js');
  await hookCommand(platform, event);
};

for (const event of hookEventNames) {
  hookCmd
    .command(event)
    .description(`Handle ${event} hook event`)
    .action(hookAction(event));
}

program.addCommand(hookCmd);

// ============================================================================
// Utility Commands
// ============================================================================

program
  .command('generate')
  .description('Regenerate CLAUDE.md files for folders with observations')
  .option('--dry-run', 'Report what would be done without writing files')
  .action(handleGenerate);

program
  .command('clean')
  .description('Remove auto-generated content from CLAUDE.md files')
  .option('--dry-run', 'Report what would be done without modifying files')
  .action(handleClean);

// ============================================================================
// Cursor Integration
// ============================================================================

program
  .command('cursor')
  .description('Manage Cursor IDE integration')
  .argument('<subcommand>', 'Cursor subcommand (install, uninstall, status, setup)')
  .allowUnknownOption()
  .action(handleCursor);

// ============================================================================
// Hidden Daemon Mode
// ============================================================================

program
  .command('daemon', { hidden: true })
  .description('Run as daemon process (internal)')
  .action(handleDaemon);

// ============================================================================
// Action Handlers
// ============================================================================

async function handleStart() {
  // Phase 2: Wire to extracted ensureWorkerStarted() from worker-service.ts
  console.error('Not yet wired — see Phase 2');
  process.exit(1);
}

async function handleStop() {
  // Phase 2: Wire to extracted httpShutdown() + waitForPortFree() + removePidFile()
  console.error('Not yet wired — see Phase 2');
  process.exit(1);
}

async function handleRestart() {
  // Phase 2: Wire to extracted restart logic from worker-service.ts
  console.error('Not yet wired — see Phase 2');
  process.exit(1);
}

async function handleStatus() {
  // Phase 2: Wire to extracted isPortInUse() + readPidFile() from worker-service.ts
  console.error('Not yet wired — see Phase 2');
  process.exit(1);
}

async function handleDaemon() {
  // Phase 2: Wire to extracted daemon startup logic from worker-service.ts
  console.error('Not yet wired — see Phase 2');
  process.exit(1);
}

async function handleGenerate(options: { dryRun?: boolean }) {
  const { generateClaudeMd } = await import('./claude-md-commands.js');
  const result = await generateClaudeMd(!!options.dryRun);
  process.exit(result);
}

async function handleClean(options: { dryRun?: boolean }) {
  const { cleanClaudeMd } = await import('./claude-md-commands.js');
  const result = await cleanClaudeMd(!!options.dryRun);
  process.exit(result);
}

async function handleCursor(subcommand: string) {
  const { handleCursorCommand } = await import('../services/integrations/CursorHooksInstaller.js');
  const result = await handleCursorCommand(subcommand, program.args.slice(1));
  process.exit(result);
}

// ============================================================================
// Parse and Execute
// ============================================================================

await program.parseAsync();
