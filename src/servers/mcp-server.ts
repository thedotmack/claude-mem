
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
import { loadFromFileOnce } from '../shared/hook-settings.js';
import { parseHttpArgs, startMcpHttpServer, type CwdResolver, type McpHttpOptions } from './mcp-http.js';
import { buildWorkerOriginPolicy } from '../services/worker/http/origin-policy.js';

/**
 * One MCP Server. Over stdio there is exactly one; over HTTP every session gets its own.
 * `getCwd` returns the project directory of the request carrying a tool call, resolved
 * for every call, so the project-scoped tools see the caller's project. Without it they
 * use process.cwd().
 */
function createMcpServer(getCwd?: CwdResolver): Server {
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
  registerClaudeMemTools(server, getCwd);
  return server;
}

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

function scheduleWorkerAutostart(): void {
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

async function main() {
  // Built here, not at module load, so HTTP mode never creates this unused stdio server.
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  attachStdioLifecycle();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-mem search server started');

  checkMarketplaceMarker();

  startParentHeartbeat();

  scheduleWorkerAutostart();
}

/**
 * HTTP mode (`--http`): one long-lived process serves many MCP clients. No stdin lifecycle
 * and no parent heartbeat, since no single client owns this process.
 */
async function mainHttp(options: McpHttpOptions) {
  const handle = await startMcpHttpServer({
    ...options,
    originPolicy: buildWorkerOriginPolicy(loadFromFileOnce()),
    createServer: createMcpServer,
  });
  logger.info('SYSTEM', 'Claude-mem MCP HTTP server started', { host: options.host, port: handle.port });

  checkMarketplaceMarker();

  scheduleWorkerAutostart();
}

// stdio keeps its historical exit code 0 on a fatal error. HTTP mode, including a
// refused --host or --port, exits 1 so a process manager reports the failure.
let fatalExitCode = 0;
async function start(): Promise<void> {
  let httpOptions: McpHttpOptions | null;
  try {
    httpOptions = parseHttpArgs(process.argv.slice(2), process.env);
  } catch (error) {
    fatalExitCode = 1; // parseHttpArgs only throws when HTTP mode was requested.
    throw error;
  }
  if (!httpOptions) return main();
  fatalExitCode = 1;
  return mainHttp(httpOptions);
}

start().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(fatalExitCode);
});
