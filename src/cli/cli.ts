/**
 * Commander.js CLI Entry Point
 *
 * Thin wiring layer that maps CLI commands to existing handler functions.
 * Daemon management commands import infrastructure functions directly from
 * worker-service.ts, ProcessManager.ts, and HealthMonitor.ts.
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
// Daemon Management Commands
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

program
  .command('mcp')
  .description('Start the MCP search server')
  .action(handleMcp);

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

  // Auto-start worker if not running (spawn daemon if needed)
  const { getWorkerPort } = await import('../shared/worker-utils.js');
  const { ensureWorkerStarted } = await import('../services/worker-service.js');
  const port = getWorkerPort();
  await ensureWorkerStarted(port);

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

program
  .command('statusline')
  .description('Output observation counts for status line')
  .argument('[cwd]', 'Working directory (defaults to process.cwd())')
  .action(handleStatusline);

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
// Helpers
// ============================================================================

/**
 * Emit JSON status output for hook framework communication.
 * Exit code 0 ensures Windows Terminal doesn't keep tabs open.
 *
 * NOTE: This function is async because it lazily imports buildStatusOutput.
 * Callers must await it. The process.exit(0) at the end means it never
 * actually returns, matching the `never` return type for practical purposes.
 */
async function exitWithStatus(status: 'ready' | 'error', message?: string): Promise<never> {
  const { buildStatusOutput } = await import('../services/worker-service.js');
  const output = buildStatusOutput(status, message);
  console.log(JSON.stringify(output));
  process.exit(0);
}

// ============================================================================
// Action Handlers
// ============================================================================

async function handleStart() {
  const { getWorkerPort } = await import('../shared/worker-utils.js');
  const { ensureWorkerStarted } = await import('../services/worker-service.js');
  const port = getWorkerPort();
  const workerReady = await ensureWorkerStarted(port);
  if (workerReady) {
    await exitWithStatus('ready');
  } else {
    await exitWithStatus('error', 'Failed to start worker');
  }
}

async function handleStop() {
  const { getWorkerPort } = await import('../shared/worker-utils.js');
  const { httpShutdown, waitForPortFree } = await import('../services/infrastructure/HealthMonitor.js');
  const { removePidFile, getPlatformTimeout } = await import('../services/infrastructure/ProcessManager.js');
  const { logger } = await import('../utils/logger.js');

  const port = getWorkerPort();
  await httpShutdown(port);
  const freed = await waitForPortFree(port, getPlatformTimeout(15000));
  if (!freed) {
    logger.warn('SYSTEM', 'Port did not free up after shutdown', { port });
  }
  removePidFile();
  logger.info('SYSTEM', 'Worker stopped successfully');
  process.exit(0);
}

async function handleRestart() {
  const { getWorkerPort } = await import('../shared/worker-utils.js');
  const { httpShutdown, waitForPortFree } = await import('../services/infrastructure/HealthMonitor.js');
  const { removePidFile, getPlatformTimeout } = await import('../services/infrastructure/ProcessManager.js');
  const { logger } = await import('../utils/logger.js');

  const port = getWorkerPort();

  logger.info('SYSTEM', 'Restarting worker');
  await httpShutdown(port);
  const freed = await waitForPortFree(port, getPlatformTimeout(15000));
  if (!freed) {
    logger.error('SYSTEM', 'Port did not free up after shutdown, aborting restart', { port });
    // Exit gracefully: Windows Terminal won't keep tab open on exit 0
    process.exit(0);
  }
  removePidFile();

  // Use ensureWorkerStarted to handle the spawn + health check
  const { ensureWorkerStarted } = await import('../services/worker-service.js');
  const healthy = await ensureWorkerStarted(port);
  if (!healthy) {
    logger.error('SYSTEM', 'Worker failed to restart');
    // Exit gracefully: Windows Terminal won't keep tab open on exit 0
    process.exit(0);
  }

  logger.info('SYSTEM', 'Worker restarted successfully');
  process.exit(0);
}

async function handleStatus() {
  const { getWorkerPort } = await import('../shared/worker-utils.js');
  const { isPortInUse } = await import('../services/infrastructure/HealthMonitor.js');
  const { readPidFile } = await import('../services/infrastructure/ProcessManager.js');

  const port = getWorkerPort();
  const running = await isPortInUse(port);
  const pidInfo = readPidFile();
  if (running && pidInfo) {
    console.log('Worker is running');
    console.log(`  PID: ${pidInfo.pid}`);
    console.log(`  Port: ${pidInfo.port}`);
    console.log(`  Started: ${pidInfo.startedAt}`);
  } else {
    console.log('Worker is not running');
  }
  process.exit(0);
}

async function handleDaemon() {
  const { getWorkerPort } = await import('../shared/worker-utils.js');
  const { isPortInUse } = await import('../services/infrastructure/HealthMonitor.js');
  const { readPidFile, removePidFile, isProcessAlive } = await import('../services/infrastructure/ProcessManager.js');
  const { WorkerService } = await import('../services/worker-service.js');
  const { logger } = await import('../utils/logger.js');

  const port = getWorkerPort();

  // GUARD 1: Refuse to start if another worker is already alive (PID check).
  // Instant check (kill -0) — no HTTP dependency.
  const existingPidInfo = readPidFile();
  if (existingPidInfo && isProcessAlive(existingPidInfo.pid)) {
    logger.info('SYSTEM', 'Worker already running (PID alive), refusing to start duplicate', {
      existingPid: existingPidInfo.pid,
      existingPort: existingPidInfo.port,
      startedAt: existingPidInfo.startedAt
    });
    process.exit(0);
  }

  // GUARD 2: Refuse to start if the port is already bound.
  // Catches the race where two daemons start simultaneously before
  // either writes a PID file. Must run BEFORE constructing WorkerService
  // because the constructor registers signal handlers and timers that
  // prevent the process from exiting even if listen() fails later.
  if (await isPortInUse(port)) {
    logger.info('SYSTEM', 'Port already in use, refusing to start duplicate', { port });
    process.exit(0);
  }

  // Prevent daemon from dying silently on unhandled errors.
  // The HTTP server can continue serving even if a background task throws.
  process.on('unhandledRejection', (reason) => {
    logger.error('SYSTEM', 'Unhandled rejection in daemon', {
      reason: reason instanceof Error ? reason.message : String(reason)
    });
  });
  process.on('uncaughtException', (error) => {
    logger.error('SYSTEM', 'Uncaught exception in daemon', {}, error as Error);
    // Don't exit — keep the HTTP server running
  });

  const worker = new WorkerService();
  worker.start().catch((error) => {
    logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
    removePidFile();
    // Exit gracefully: Windows Terminal won't keep tab open on exit 0
    process.exit(0);
  });
}

async function handleMcp() {
  const { startMcpServer } = await import('../servers/mcp-server.js');
  await startMcpServer();
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

async function handleStatusline(cwd?: string) {
  const { Database } = await import('bun:sqlite');
  const { existsSync, readFileSync } = await import('fs');
  const { homedir } = await import('os');
  const { join, basename } = await import('path');

  const workingDir = cwd || process.env.CLAUDE_CWD || process.cwd();
  const project = basename(workingDir);

  // Resolve data directory: env var -> settings.json -> default
  let dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  if (!process.env.CLAUDE_MEM_DATA_DIR) {
    const settingsPath = join(dataDir, 'settings.json');
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (settings.CLAUDE_MEM_DATA_DIR) dataDir = settings.CLAUDE_MEM_DATA_DIR;
      } catch { /* use default — intentionally tolerant of corrupt settings */ }
    }
  }

  const dbPath = join(dataDir, 'claude-mem.db');
  if (!existsSync(dbPath)) {
    console.log(JSON.stringify({ observations: 0, prompts: 0, project }));
    process.exit(0);
  }

  const db = new Database(dbPath, { readonly: true });
  const obs = db.query('SELECT COUNT(*) as c FROM observations WHERE project = ?').get(project) as { c: number };
  const prompts = db.query(
    `SELECT COUNT(*) as c FROM user_prompts up
     JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
     WHERE s.project = ?`
  ).get(project) as { c: number };
  console.log(JSON.stringify({ observations: obs.c, prompts: prompts.c, project }));
  db.close();
  process.exit(0);
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
