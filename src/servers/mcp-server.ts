/**
 * Claude-mem MCP Search Server - Thin HTTP Wrapper
 *
 * Refactored from 2,718 lines to ~600-800 lines
 * Delegates all business logic to Worker HTTP API at localhost:37777
 * Maintains MCP protocol handling and tool schemas
 */

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

// Import logger first
import { logger } from '../utils/logger.js';

// CRITICAL: Redirect console to stderr BEFORE other imports
// MCP uses stdio transport where stdout is reserved for JSON-RPC protocol messages.
// Any logs to stdout break the protocol (Claude Desktop parses "[2025..." as JSON array).
const _originalLog = console['log'];
console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { spawnDaemon, getPlatformTimeout } from '../services/infrastructure/ProcessManager.js';
import { waitForHealth } from '../services/infrastructure/HealthMonitor.js';
import path from 'path';
import { existsSync } from 'fs';

/**
 * Flag to prevent concurrent auto-start attempts
 */
let autoStartInProgress = false;

/**
 * Worker HTTP API configuration
 */
const WORKER_PORT = getWorkerPort();
const WORKER_HOST = getWorkerHost();
const WORKER_BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

/**
 * Map tool names to Worker HTTP endpoints
 */
const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'search': '/api/search',
  'timeline': '/api/timeline'
};

/**
 * Check if an error is a connection error (worker offline)
 * Checks both error messages and error codes for robustness
 */
function isConnectionError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Check error message patterns
    if (msg.includes('econnrefused') ||
        msg.includes('fetch failed') ||
        msg.includes('unable to connect') ||
        msg.includes('network error') ||
        msg.includes('enotfound') ||
        msg.includes('etimedout') ||
        msg.includes('econnreset') ||
        msg.includes('ehostunreach')) {
      return true;
    }
    // Check error code if available (Node.js style)
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH'].includes(nodeError.code)) {
      return true;
    }
  }
  return false;
}

/**
 * Cooldown tracking to prevent rapid repeated auto-start attempts
 */
let lastAutoStartAttempt = 0;
const AUTO_START_COOLDOWN_MS = 30000; // Don't retry auto-start within 30 seconds

/**
 * Attempt to recover from worker offline by auto-starting
 * Returns true if worker is now available
 */
async function attemptWorkerRecovery(): Promise<boolean> {
  // Check cooldown to prevent rapid repeated attempts
  const now = Date.now();
  if (now - lastAutoStartAttempt < AUTO_START_COOLDOWN_MS) {
    logger.debug('SYSTEM', 'Auto-start on cooldown, skipping recovery attempt');
    return false;
  }
  lastAutoStartAttempt = now;

  logger.warn('SYSTEM', 'Worker appears offline, attempting recovery');

  // Quick recheck in case of transient failure (unlikely for localhost, but defensive)
  const available = await verifyWorkerConnection();
  if (available) {
    logger.info('SYSTEM', 'Worker recovered before auto-start (transient failure)');
    return true;
  }

  // Try to auto-start
  return await autoStartWorker();
}

/**
 * Call Worker HTTP API endpoint
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('SYSTEM', '→ Worker API', undefined, { endpoint, params });

  const makeRequest = async (): Promise<Response> => {
    const searchParams = new URLSearchParams();

    // Convert params to query string
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    const url = `${WORKER_BASE_URL}${endpoint}?${searchParams}`;
    return await fetch(url);
  };

  try {
    let response: Response;
    
    try {
      response = await makeRequest();
    } catch (error) {
      // Connection failed - try to recover and retry once
      if (isConnectionError(error)) {
        const recovered = await attemptWorkerRecovery();
        if (recovered) {
          logger.info('SYSTEM', 'Worker recovered, retrying request', { endpoint });
          response = await makeRequest();
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

    logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });

    // Worker returns { content: [...] } format directly
    return data;
  } catch (error) {
    logger.error('SYSTEM', '← Worker API error', { endpoint }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Call Worker HTTP API with POST body
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('HTTP', 'Worker API request (POST)', undefined, { endpoint });

  const makeRequest = async (): Promise<Response> => {
    const url = `${WORKER_BASE_URL}${endpoint}`;
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  };

  try {
    let response: Response;
    
    try {
      response = await makeRequest();
    } catch (error) {
      // Connection failed - try to recover and retry once
      if (isConnectionError(error)) {
        const recovered = await attemptWorkerRecovery();
        if (recovered) {
          logger.info('SYSTEM', 'Worker recovered, retrying request', { endpoint });
          response = await makeRequest();
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    logger.debug('HTTP', 'Worker API success (POST)', undefined, { endpoint });

    // Wrap raw data in MCP format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error) {
    logger.error('HTTP', 'Worker API error (POST)', { endpoint }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Verify Worker is accessible
 */
async function verifyWorkerConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/health`);
    return response.ok;
  } catch (error) {
    // Expected during worker startup or if worker is down
    logger.debug('SYSTEM', 'Worker health check failed', {}, error as Error);
    return false;
  }
}

/**
 * Attempt to start the worker daemon automatically
 * Returns true if worker started successfully, false otherwise
 * Uses a lock to prevent concurrent auto-start attempts
 */
async function autoStartWorker(): Promise<boolean> {
  const MAX_WAIT_MS = 60000; // Max time to wait for in-progress attempt
  const POLL_INTERVAL_MS = 500;

  // Prevent concurrent auto-start attempts (race condition fix)
  if (autoStartInProgress) {
    logger.debug('SYSTEM', 'Auto-start already in progress, waiting...');
    const startWait = Date.now();
    // Wait for the in-progress attempt to complete with timeout
    while (autoStartInProgress) {
      if (Date.now() - startWait > MAX_WAIT_MS) {
        logger.error('SYSTEM', 'Timeout waiting for in-progress auto-start');
        return false;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    // Check if worker is now available
    return await verifyWorkerConnection();
  }
  
  autoStartInProgress = true;
  
  try {
    logger.info('SYSTEM', 'Attempting to auto-start worker daemon');
    
    // Get the worker service script path
    // In production, this is the bundled worker-service.cjs next to mcp-server.cjs
    // Uses __dirname which esbuild provides in CommonJS bundles
    const workerScriptPath = path.join(__dirname, 'worker-service.cjs');
    
    // Validate script exists before attempting to spawn
    if (!existsSync(workerScriptPath)) {
      logger.error('SYSTEM', 'Worker script not found', { path: workerScriptPath });
      return false;
    }
    
    const pid = spawnDaemon(workerScriptPath, WORKER_PORT);
    if (pid === undefined) {
      logger.error('SYSTEM', 'Failed to spawn worker daemon during auto-start');
      return false;
    }

    // Windows WMIC returns 0 (PID unavailable), Unix returns actual PID
    if (process.platform === 'win32') {
      logger.info('SYSTEM', 'Worker daemon spawn initiated (Windows/WMIC)', { note: 'PID unavailable via WMIC' });
    } else {
      logger.info('SYSTEM', 'Worker daemon spawned, waiting for health check', { pid });
    }
    
    // Wait for worker to become healthy (30 seconds timeout, platform-adjusted)
    const healthy = await waitForHealth(WORKER_PORT, getPlatformTimeout(30000));
    if (!healthy) {
      logger.error('SYSTEM', 'Worker failed to start (health check timeout)');
      return false;
    }
    
    logger.info('SYSTEM', 'Worker auto-started successfully');
    return true;
  } finally {
    autoStartInProgress = false;
  }
}

/**
 * Tool definitions with HTTP-based handlers
 * Minimal descriptions - use help() tool with operation parameter for detailed docs
 */
const tools = [
  {
    name: '__IMPORTANT',
    description: `3-LAYER WORKFLOW (ALWAYS FOLLOW):
1. search(query) → Get index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID) → Get context around interesting results
3. get_observations([IDs]) → Fetch full details ONLY for filtered IDs
NEVER fetch full details without filtering first. 10x token savings.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Memory Search Workflow

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(query="...", limit=20, project="...")\`
   Returns: Table with IDs, titles, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context showing what was happening

3. **Fetch** - Get full details ONLY for relevant IDs
   \`get_observations(ids=[...])\`  # ALWAYS batch for 2+ items
   Returns: Complete details (~500-1000 tokens/result)

**Why:** 10x token savings. Never fetch full details without filtering first.`
      }]
    })
  },
  {
    name: 'search',
    description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, type, obs_type, dateStart, dateEnd, offset, orderBy',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after, project',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs, required), orderBy, limit, project',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of observation IDs to fetch (required)'
        }
      },
      required: ['ids'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/observations/batch', args);
    }
  }
];

// Create the MCP server
const server = new Server(
  {
    name: 'mcp-search-server',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},  // Exposes tools capability (handled by ListToolsRequestSchema and CallToolRequestSchema)
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error as Error);
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// Cleanup function
async function cleanup() {
  logger.info('SYSTEM', 'MCP server shutting down');
  process.exit(0);
}

// Register cleanup handlers for graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
async function main() {
  // Start the MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-mem search server started');

  // Check Worker availability and auto-start if needed
  setTimeout(async () => {
    let workerAvailable = await verifyWorkerConnection();
    
    if (!workerAvailable) {
      logger.warn('SYSTEM', 'Worker not available, attempting auto-start', { workerUrl: WORKER_BASE_URL });
      
      // Try to auto-start the worker
      const started = await autoStartWorker();
      if (started) {
        workerAvailable = true;
      } else {
        logger.error('SYSTEM', 'Worker auto-start failed');
        logger.error('SYSTEM', 'Tools will fail until Worker is started');
        logger.error('SYSTEM', 'Start Worker with: npm run worker:restart');
      }
    }
    
    if (workerAvailable) {
      logger.info('SYSTEM', 'Worker available', { workerUrl: WORKER_BASE_URL });
    }
  }, 0);
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  // Exit gracefully: Windows Terminal won't keep tab open on exit 0
  // The wrapper/plugin will handle restart logic if needed
  process.exit(0);
});
