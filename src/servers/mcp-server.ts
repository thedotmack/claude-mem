/**
 * Claude-mem MCP Search Server - Thin HTTP Wrapper
 *
 * Refactored from 2,718 lines to ~600-800 lines
 * Delegates all business logic to Worker HTTP API at localhost:37777
 * Maintains MCP protocol handling and tool schemas
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { happy_path_error__with_fallback } from '../utils/silent-debug.js';
import { getWorkerPort } from '../shared/worker-utils.js';

/**
 * Worker HTTP API configuration
 */
const WORKER_PORT = getWorkerPort();
const WORKER_BASE_URL = `http://localhost:${WORKER_PORT}`;

/**
 * Map tool names to Worker HTTP endpoints
 */
const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'search': '/api/search',
  'timeline': '/api/timeline',
  'decisions': '/api/decisions',
  'changes': '/api/changes',
  'how_it_works': '/api/how-it-works',
  'search_observations': '/api/search/observations',
  'search_sessions': '/api/search/sessions',
  'search_user_prompts': '/api/search/prompts',
  'find_by_concept': '/api/search/by-concept',
  'find_by_file': '/api/search/by-file',
  'find_by_type': '/api/search/by-type',
  'get_recent_context': '/api/context/recent',
  'get_context_timeline': '/api/context/timeline',
  'get_timeline_by_query': '/api/timeline/by-query'
};

/**
 * Call Worker HTTP API endpoint
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  happy_path_error__with_fallback('[mcp-server] → Worker API', { endpoint, params });

  try {
    const searchParams = new URLSearchParams();

    // Convert params to query string
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    const url = `${WORKER_BASE_URL}${endpoint}?${searchParams}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

    happy_path_error__with_fallback('[mcp-server] ← Worker API success', { endpoint });

    // Worker returns { content: [...] } format directly
    return data;
  } catch (error: any) {
    happy_path_error__with_fallback('[mcp-server] ← Worker API error', { endpoint, error: error.message });
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error.message}`
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
    return false;
  }
}

/**
 * Tool definitions with HTTP-based handlers
 */
const tools = [
  {
    name: 'search',
    description: 'Unified search across all memory types (observations, sessions, and user prompts) using vector-first semantic search (ChromaDB). Returns combined results from all document types. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',
    inputSchema: z.object({
      query: z.string().optional().describe('Natural language search query for semantic ranking via ChromaDB vector search. Optional - omit for date-filtered queries only (Chroma cannot filter by date, requires direct SQLite).'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),
      type: z.enum(['observations', 'sessions', 'prompts']).optional().describe('Filter by document type (observations, sessions, or prompts). Omit to search all types.'),
      obs_type: z.string().optional().describe('Filter observations by type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change). Only applies when type="observations"'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list). Only applies when type="observations"'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match). Only applies when type="observations"'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'timeline',
    description: 'Fetch timeline of observations around a specific point in time. Supports two modes: anchor-based (fetch observations before/after a specific observation ID) and query-based (semantic search for anchor point). IMPORTANT: Use anchor_id when you know the specific observation, or query to find an anchor point first.',
    inputSchema: z.object({
      query: z.string().optional().describe('Natural language query to find anchor observation (query-based mode). Mutually exclusive with anchor_id.'),
      anchor_id: z.number().optional().describe('Observation ID to use as anchor (anchor-based mode). Mutually exclusive with query.'),
      before: z.number().min(0).max(100).default(10).describe('Number of observations to fetch before anchor'),
      after: z.number().min(0).max(100).default(10).describe('Number of observations to fetch after anchor'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      obs_type: z.string().optional().describe('Filter observations by type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list)'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
      project: z.string().optional().describe('Filter by project name')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'decisions',
    description: 'Semantic shortcut for finding architectural, design, and implementation decisions. Optimized for decision-type observations with relevant keyword boosting.',
    inputSchema: z.object({
      query: z.string().describe('Natural language query for finding decisions'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['decisions'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'changes',
    description: 'Semantic shortcut for finding code changes, refactorings, and modifications. Optimized for change-type observations with relevant keyword boosting.',
    inputSchema: z.object({
      query: z.string().describe('Natural language query for finding changes'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['changes'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'how_it_works',
    description: 'Semantic shortcut for understanding system architecture, design patterns, and implementation details. Optimized for discovery-type observations with architecture/design keyword boosting.',
    inputSchema: z.object({
      query: z.string().describe('Natural language query for understanding how something works'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['how_it_works'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'search_observations',
    description: '[DEPRECATED - Use "search" with type="observations" instead] Search observations (facts/narratives) using FTS5 full-text search. Supports filtering by type, concepts, files, and date range.',
    inputSchema: z.object({
      query: z.string().optional().describe('Full-text search query (FTS5)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      type: z.string().optional().describe('Filter by observation type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list)'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('relevance').describe('Sort order (relevance only when query provided)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search_observations'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'search_sessions',
    description: '[DEPRECATED - Use "search" with type="sessions" instead] Search session summaries using FTS5 full-text search. Returns both request_summary and learned_summary fields.',
    inputSchema: z.object({
      query: z.string().optional().describe('Full-text search query (FTS5)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('relevance').describe('Sort order (relevance only when query provided)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search_sessions'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'search_user_prompts',
    description: '[DEPRECATED - Use "search" with type="prompts" instead] Search user prompts using FTS5 full-text search. Searches prompt text only.',
    inputSchema: z.object({
      query: z.string().optional().describe('Full-text search query (FTS5)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('relevance').describe('Sort order (relevance only when query provided)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search_user_prompts'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'find_by_concept',
    description: 'Find observations tagged with specific concepts. Returns observations that match any of the provided concept tags.',
    inputSchema: z.object({
      concepts: z.string().describe('Concept tag(s) to filter by (single value or comma-separated list)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      type: z.string().optional().describe('Filter by observation type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['find_by_concept'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'find_by_file',
    description: 'Find observations related to specific file paths. Uses partial matching - searches for file paths containing the provided string.',
    inputSchema: z.object({
      files: z.string().describe('File path(s) to filter by (single value or comma-separated list for partial match)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      type: z.string().optional().describe('Filter by observation type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['find_by_file'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'find_by_type',
    description: 'Find observations of specific types. Returns observations matching any of the provided observation types.',
    inputSchema: z.object({
      type: z.string().describe('Observation type(s) to filter by (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list)'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)'),
      limit: z.number().min(1).max(100).default(20).describe('Maximum number of results'),
      offset: z.number().min(0).default(0).describe('Number of results to skip'),
      orderBy: z.enum(['date_desc', 'date_asc']).default('date_desc').describe('Sort order')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['find_by_type'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_recent_context',
    description: 'Get recent session context for timeline display. Returns recent observations, sessions, and user prompts with metadata for building timeline UI.',
    inputSchema: z.object({
      limit: z.number().min(1).max(100).default(30).describe('Maximum number of timeline items to return'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      type: z.string().optional().describe('Filter by observation type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list)'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['get_recent_context'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_context_timeline',
    description: 'Get timeline of observations around a specific observation ID. Returns observations before and after the anchor point with metadata for timeline display.',
    inputSchema: z.object({
      anchor_id: z.number().describe('Observation ID to use as anchor point'),
      before: z.number().min(0).max(100).default(10).describe('Number of observations to fetch before anchor'),
      after: z.number().min(0).max(100).default(10).describe('Number of observations to fetch after anchor'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      type: z.string().optional().describe('Filter by observation type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list)'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
      project: z.string().optional().describe('Filter by project name')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['get_context_timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_timeline_by_query',
    description: 'Combined search + timeline tool. First searches for observations matching the query, then returns timeline around the best match. Useful for finding specific observations and viewing their context.',
    inputSchema: z.object({
      query: z.string().describe('Natural language query to find anchor observation'),
      before: z.number().min(0).max(100).default(10).describe('Number of observations to fetch before anchor'),
      after: z.number().min(0).max(100).default(10).describe('Number of observations to fetch after anchor'),
      format: z.enum(['index', 'full']).default('index').describe('Output format: "index" for titles/dates only (default, RECOMMENDED), "full" for complete details'),
      type: z.string().optional().describe('Filter by observation type (single value or comma-separated list: decision,bugfix,feature,refactor,discovery,change)'),
      concepts: z.string().optional().describe('Filter by concept tags (single value or comma-separated list)'),
      files: z.string().optional().describe('Filter by file paths (single value or comma-separated list for partial match)'),
      project: z.string().optional().describe('Filter by project name'),
      dateStart: z.union([z.string(), z.number()]).optional().describe('Start date for filtering (ISO string or epoch timestamp)'),
      dateEnd: z.union([z.string(), z.number()]).optional().describe('End date for filtering (ISO string or epoch timestamp)')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['get_timeline_by_query'];
      return await callWorkerAPI(endpoint, args);
    }
  }
];

// Create the MCP server
const server = new Server(
  {
    name: 'claude-mem-search-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>
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
  } catch (error: any) {
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error.message}`
      }],
      isError: true
    };
  }
});

// Cleanup function
async function cleanup() {
  happy_path_error__with_fallback('[mcp-server] Shutting down...');
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
  happy_path_error__with_fallback('[mcp-server] Claude-mem search server started');

  // Check Worker availability in background
  setTimeout(async () => {
    const workerAvailable = await verifyWorkerConnection();
    if (!workerAvailable) {
      happy_path_error__with_fallback('[mcp-server] WARNING: Worker not available at', WORKER_BASE_URL);
      happy_path_error__with_fallback('[mcp-server] Tools will fail until Worker is started');
      happy_path_error__with_fallback('[mcp-server] Start Worker with: npm run worker:restart');
    } else {
      happy_path_error__with_fallback('[mcp-server] Worker available at', WORKER_BASE_URL);
    }
  }, 0);
}

main().catch((error) => {
  happy_path_error__with_fallback('[mcp-server] Fatal error:', error);
  process.exit(1);
});
