
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { logger } from '../utils/logger.js';

console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { marketplaceDirectoryCandidates } from '../shared/known-marketplace-location.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { selectRuntime } from '../services/hooks/runtime-selector.js';
import { ensureWorkerConnection, registerClaudeMemTools } from './mcp-tool-table.js';

const server = new Server(
  {
    name: 'claude-mem',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},  // Exposes tools capability (handled by ListToolsRequestSchema and CallToolRequestSchema)
    },
  }
);

// The tools, their handlers and their visibility rules live in mcp-tool-table.ts,
// shared with the wire gateway's MCP over HTTP.
registerClaudeMemTools(server);

const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isCleaningUp = false;

function handleStdioClosed() {
  cleanup('stdio-closed');
}

function handleStdioError(error: Error) {
  logger.warn('SYSTEM', 'MCP stdio stream errored, shutting down', {
    message: error.message
  });
  cleanup('stdio-error');
}

function attachStdioLifecycle() {
  process.stdin.on('end', handleStdioClosed);
  process.stdin.on('close', handleStdioClosed);
  process.stdin.on('error', handleStdioError);
}

function detachStdioLifecycle() {
  process.stdin.off('end', handleStdioClosed);
  process.stdin.off('close', handleStdioClosed);
  process.stdin.off('error', handleStdioError);
}

function startParentHeartbeat() {
  if (process.platform === 'win32') return;

  const initialPpid = process.ppid;
  heartbeatTimer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) {
      logger.info('SYSTEM', 'Parent process died, self-exiting to prevent orphan', {
        initialPpid,
        currentPpid: process.ppid
      });
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function cleanup(reason: string = 'shutdown') {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  detachStdioLifecycle();
  logger.info('SYSTEM', 'MCP server shutting down', { reason });
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

function detectMissingMarketplaceMarker(): void {
  const home = homedir();
  // Includes the installLocation Claude Code records for a marketplace added
  // from a local folder (`/plugin marketplace add <path>`).
  const marketplaceCandidates = marketplaceDirectoryCandidates(home);
  const present = marketplaceCandidates.some(p => p && existsSync(p));
  const cacheCandidates = [
    resolve(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem'),
    resolve(home, '.config', 'claude', 'plugins', 'cache', 'thedotmack', 'claude-mem'),
  ];
  const cachePresent = cacheCandidates.some(p => p && existsSync(p));
  const cacheRoot = cacheCandidates[0];

  if (!present && cachePresent) {
    logger.error(
      'SYSTEM',
      'claude-mem MCP started but no marketplace directory was found at ~/.claude/plugins/marketplaces/thedotmack, the XDG equivalent, or the thedotmack installLocation in known_marketplaces.json. The IDE plugin loader needs that directory to fire claude-mem hooks (SessionStart, PostToolUse, Stop, etc.). Without it, MCP search will work but no new memories will be captured. To self-heal, reinstall the plugin from the marketplace (/plugin marketplace add thedotmack/claude-mem, then /plugin install claude-mem@thedotmack).',
      { marketplaceCandidates, cacheRoot }
    );
  }
}

function checkMarketplaceMarker(): void {
  try {
    detectMissingMarketplaceMarker();
  } catch (error) {
    logger.warn('SYSTEM', 'checkMarketplaceMarker failed (non-fatal startup check)', undefined, error instanceof Error ? error : new Error(String(error)));
  }
}

async function main() {
  const transport = new StdioServerTransport();
  attachStdioLifecycle();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-mem search server started');

  checkMarketplaceMarker();

  startParentHeartbeat();

  setTimeout(async () => {
    // Phase 8 — when CLAUDE_MEM_RUNTIME=server (or legacy `server-beta`,
    // normalized to `'server'` by selectRuntime), MCP must NOT auto-start
    // the worker. observation_* tools talk to the server runtime directly;
    // the legacy worker-backed tools (search/timeline/get_observations)
    // will simply error with a helpful message until the user switches
    // runtime.
    if (selectRuntime() === 'server') {
      logger.info('SYSTEM', 'MCP runtime=server — skipping worker auto-start', undefined, {});
      return;
    }
    const workerAvailable = await ensureWorkerConnection();
    if (!workerAvailable) {
      logger.error('SYSTEM', 'Worker not available', undefined, {});
      logger.error('SYSTEM', 'Tools will fail until Worker is started');
      logger.error('SYSTEM', 'Start Worker with: npm run worker:restart');
    } else {
      logger.info('SYSTEM', 'Worker available', undefined, {});
    }
  }, 0);
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(0);
});
