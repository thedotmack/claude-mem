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
console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getWorkerPort, workerHttpRequest } from '../shared/worker-utils.js';
import { ensureWorkerStarted } from '../services/worker-spawner.js';
import { searchCodebase, formatSearchResults } from '../services/smart-file-read/search.js';
import { parseFile, formatFoldedView, unfoldSymbol } from '../services/smart-file-read/parser.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the path to worker-service.cjs, which lives alongside mcp-server.cjs
// in the plugin's scripts directory. We need an explicit path because the MCP
// server runs under Node while the worker must run under Bun, so we can't rely
// on `__filename` pointing to a self-spawnable script.
//
// In the deployed CJS bundle, `__dirname` is always defined — the import.meta
// fallback only exists to keep the source future-proof against an eventual
// ESM port. Both fallback branches should be functionally unreachable today.
let mcpServerDirResolutionFailed = false;
const mcpServerDir = (() => {
  if (typeof __dirname !== 'undefined') return __dirname;
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    // Last-ditch fallback: cwd is almost certainly wrong, but throwing here
    // would crash the MCP server before it can serve a single request. Mark
    // the failure so the existence check below can produce a single, loud,
    // root-cause-attributing log line instead of a confusing "missing worker
    // bundle" warning that hides the dirname resolution failure.
    mcpServerDirResolutionFailed = true;
    return process.cwd();
  }
})();
const WORKER_SCRIPT_PATH = resolve(mcpServerDir, 'worker-service.cjs');

/**
 * Surface a clear, actionable error if the worker bundle isn't where we
 * expect. Without this check, a missing or partial install only fails later
 * inside spawnDaemon as a generic "failed to spawn" message.
 *
 * If dirname resolution itself failed (extremely unlikely in CJS), attribute
 * the missing-bundle warning to the root cause so the user doesn't waste time
 * looking for an install bug that doesn't exist.
 *
 * Called lazily from `ensureWorkerConnection` (not at module load) so that
 * tests or tools that import this module without booting the MCP server
 * don't see noisy ERROR-level log lines for a worker they never intended
 * to start. The check is cheap and idempotent, so calling it on every
 * auto-start attempt is fine.
 */
function errorIfWorkerScriptMissing(): void {
  // Only log here when the dirname resolution itself failed — that's the
  // mcp-server-specific root cause attribution that the spawner cannot
  // provide. The plain "missing bundle" case is already covered by the
  // existsSync guard inside ensureWorkerStarted, and logging from both
  // sites would produce a confusing double-log on the same code path.
  if (!mcpServerDirResolutionFailed) return;
  if (existsSync(WORKER_SCRIPT_PATH)) return;

  logger.error(
    'SYSTEM',
    'mcp-server: dirname resolution failed (both __dirname and import.meta.url are unavailable). Fell back to process.cwd() and the resolved WORKER_SCRIPT_PATH does not exist. This is the actual problem — the worker bundle is fine, but mcp-server cannot locate it. Worker auto-start will fail until the dirname-resolution path is fixed.',
    { workerScriptPath: WORKER_SCRIPT_PATH, mcpServerDir }
  );
}

/**
 * Map tool names to Worker HTTP endpoints
 */
const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'search': '/api/search',
  'timeline': '/api/timeline'
};

/**
 * Call Worker HTTP API endpoint (uses socket or TCP automatically)
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('SYSTEM', '→ Worker API', undefined, { endpoint, params });

  const searchParams = new URLSearchParams();

  // Convert params to query string
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  }

  const apiPath = `${endpoint}?${searchParams}`;

  try {
    const response = await workerHttpRequest(apiPath);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

    logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });

    // Worker returns { content: [...] } format directly
    return data;
  } catch (error: unknown) {
    logger.error('SYSTEM', '← Worker API error', { endpoint }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

async function executeWorkerPostRequest(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const response = await workerHttpRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  logger.debug('HTTP', 'Worker API success (POST)', undefined, { endpoint });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2)
    }]
  };
}

/**
 * Call Worker HTTP API with POST body
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('HTTP', 'Worker API request (POST)', undefined, { endpoint });

  try {
    return await executeWorkerPostRequest(endpoint, body);
  } catch (error: unknown) {
    logger.error('HTTP', 'Worker API error (POST)', { endpoint }, error instanceof Error ? error : new Error(String(error)));
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
    const response = await workerHttpRequest('/api/health');
    return response.ok;
  } catch (error: unknown) {
    // Expected during worker startup or if worker is down
    logger.debug('SYSTEM', 'Worker health check failed', {}, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

/**
 * Ensure Worker is available for Codex and other MCP-only clients.
 * Claude hooks already start the worker; this path makes Codex turnkey.
 */
async function ensureWorkerConnection(): Promise<boolean> {
  if (await verifyWorkerConnection()) {
    return true;
  }

  logger.warn('SYSTEM', 'Worker not available, attempting auto-start for MCP client');

  // Validate the worker bundle path lazily here (rather than at module load)
  // so that tests/tools that import this module without booting the MCP
  // server don't see noisy ERROR-level log lines for a worker they never
  // intended to start.
  errorIfWorkerScriptMissing();

  try {
    const port = getWorkerPort();
    const started = await ensureWorkerStarted(port, WORKER_SCRIPT_PATH);
    if (!started) {
      logger.error(
        'SYSTEM',
        'Worker auto-start returned false — MCP tools that require the worker (search, timeline, get_observations) will fail until the worker is running. Check earlier log lines for the specific failure reason (Bun not found, missing worker bundle, port conflict, etc.).'
      );
    }
    return started;
  } catch (error: unknown) {
    logger.error(
      'SYSTEM',
      'Worker auto-start threw — MCP tools that require the worker (search, timeline, get_observations) will fail until the worker is running.',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
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
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        project: { type: 'string', description: 'Filter by project name' },
        type: { type: 'string', description: 'Filter by observation type' },
        obs_type: { type: 'string', description: 'Filter by obs_type field' },
        dateStart: { type: 'string', description: 'Start date filter (ISO)' },
        dateEnd: { type: 'string', description: 'End date filter (ISO)' },
        offset: { type: 'number', description: 'Pagination offset' },
        orderBy: { type: 'string', description: 'Sort order: date_desc or date_asc' }
      },
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
      properties: {
        anchor: { type: 'number', description: 'Observation ID to center the timeline around' },
        query: { type: 'string', description: 'Query to find anchor automatically' },
        depth_before: { type: 'number', description: 'Items before anchor (default 3)' },
        depth_after: { type: 'number', description: 'Items after anchor (default 3)' },
        project: { type: 'string', description: 'Filter by project name' }
      },
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
  },
  {
    name: 'smart_search',
    description: 'Search codebase for symbols, functions, classes using tree-sitter AST parsing. Returns folded structural views with token counts. Use path parameter to scope the search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — matches against symbol names, file names, and file content'
        },
        path: {
          type: 'string',
          description: 'Root directory to search (default: current working directory)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 20)'
        },
        file_pattern: {
          type: 'string',
          description: 'Substring filter for file paths (e.g. ".ts", "src/services")'
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      const rootDir = resolve(args.path || process.cwd());
      const result = await searchCodebase(rootDir, args.query, {
        maxResults: args.max_results || 20,
        filePattern: args.file_pattern
      });
      const formatted = formatSearchResults(result, args.query);
      return {
        content: [{ type: 'text' as const, text: formatted }]
      };
    }
  },
  {
    name: 'smart_unfold',
    description: 'Expand a specific symbol (function, class, method) from a file. Returns the full source code of just that symbol. Use after smart_search or smart_outline to read specific code.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        },
        symbol_name: {
          type: 'string',
          description: 'Name of the symbol to unfold (function, class, method, etc.)'
        }
      },
      required: ['file_path', 'symbol_name']
    },
    handler: async (args: any) => {
      const filePath = resolve(args.file_path);
      const content = await readFile(filePath, 'utf-8');
      const unfolded = unfoldSymbol(content, filePath, args.symbol_name);
      if (unfolded) {
        return {
          content: [{ type: 'text' as const, text: unfolded }]
        };
      }
      // Symbol not found — show available symbols
      const parsed = parseFile(content, filePath);
      if (parsed.symbols.length > 0) {
        const available = parsed.symbols.map(s => `  - ${s.name} (${s.kind})`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Symbol "${args.symbol_name}" not found in ${args.file_path}.\n\nAvailable symbols:\n${available}`
          }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may be unsupported or empty.`
        }]
      };
    }
  },
  {
    name: 'smart_outline',
    description: 'Get structural outline of a file — shows all symbols (functions, classes, methods, types) with signatures but bodies folded. Much cheaper than reading the full file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        }
      },
      required: ['file_path']
    },
    handler: async (args: any) => {
      const filePath = resolve(args.file_path);
      const content = await readFile(filePath, 'utf-8');
      const parsed = parseFile(content, filePath);
      if (parsed.symbols.length > 0) {
        return {
          content: [{ type: 'text' as const, text: formatFoldedView(parsed) }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may use an unsupported language or be empty.`
        }]
      };
    }
  },
  {
    name: 'build_corpus',
    description: 'Build a knowledge corpus from filtered observations. Creates a queryable knowledge agent. Params: name (required), description, project, types (comma-separated), concepts (comma-separated), files (comma-separated), query, dateStart, dateEnd, limit',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Corpus name (used as filename)' },
        description: { type: 'string', description: 'What this corpus is about' },
        project: { type: 'string', description: 'Filter by project' },
        types: { type: 'string', description: 'Comma-separated observation types: decision,bugfix,feature,refactor,discovery,change' },
        concepts: { type: 'string', description: 'Comma-separated concepts to filter by' },
        files: { type: 'string', description: 'Comma-separated file paths to filter by' },
        query: { type: 'string', description: 'Semantic search query' },
        dateStart: { type: 'string', description: 'Start date (ISO format)' },
        dateEnd: { type: 'string', description: 'End date (ISO format)' },
        limit: { type: 'number', description: 'Maximum observations (default 500)' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/corpus', args);
    }
  },
  {
    name: 'list_corpora',
    description: 'List all knowledge corpora with their stats and priming status',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPI('/api/corpus', args);
    }
  },
  {
    name: 'prime_corpus',
    description: 'Prime a knowledge corpus — creates an AI session loaded with the corpus knowledge. Must be called before query_corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to prime' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/prime`, rest);
    }
  },
  {
    name: 'query_corpus',
    description: 'Ask a question to a primed knowledge corpus. The corpus must be primed first with prime_corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to query' },
        question: { type: 'string', description: 'The question to ask' }
      },
      required: ['name', 'question'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/query`, rest);
    }
  },
  {
    name: 'rebuild_corpus',
    description: 'Rebuild a knowledge corpus from its stored filter — re-runs the search to refresh with new observations. Does not re-prime the session.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to rebuild' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/rebuild`, rest);
    }
  },
  {
    name: 'reprime_corpus',
    description: 'Create a fresh knowledge agent session for a corpus, clearing prior Q&A context. Use when conversation has drifted or after rebuilding.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the corpus to reprime' }
      },
      required: ['name'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const { name, ...rest } = args;
      if (typeof name !== 'string' || name.trim() === '') throw new Error('Missing required argument: name');
      return await callWorkerAPIPost(`/api/corpus/${encodeURIComponent(name)}/reprime`, rest);
    }
  }
];

// Create the MCP server
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
  } catch (error: unknown) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// Parent heartbeat: self-exit when parent dies (ppid=1 on Unix means orphaned)
// Prevents orphaned MCP server processes when Claude Code exits unexpectedly
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
  // ppid-based orphan detection only works on Unix
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

  // Don't let the heartbeat timer keep the process alive
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

// Cleanup function — synchronous to ensure consistent behavior whether called
// from signal handlers, heartbeat interval, or awaited in async context
function cleanup(reason: string = 'shutdown') {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  detachStdioLifecycle();
  logger.info('SYSTEM', 'MCP server shutting down', { reason });
  process.exit(0);
}

// Register cleanup handlers for graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
async function main() {
  // Start the MCP server
  const transport = new StdioServerTransport();
  attachStdioLifecycle();
  await server.connect(transport);
  logger.info('SYSTEM', 'Claude-mem search server started');

  // Start parent heartbeat to detect orphaned MCP servers
  startParentHeartbeat();

  // Check Worker availability in background
  setTimeout(async () => {
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
  // Exit gracefully: Windows Terminal won't keep tab open on exit 0
  // The wrapper/plugin will handle restart logic if needed
  process.exit(0);
});
