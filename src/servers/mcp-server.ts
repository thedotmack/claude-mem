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
import { logger } from '../utils/logger.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';

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
  'timeline': '/api/timeline',
  'get_recent_context': '/api/context/recent',
  'get_context_timeline': '/api/context/timeline',
  'progressive_description': '/api/instructions'
};

/**
 * Call Worker HTTP API endpoint
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('SYSTEM', '→ Worker API', undefined, { endpoint, params });

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

    logger.debug('SYSTEM', '← Worker API success', undefined, { endpoint });

    // Worker returns { content: [...] } format directly
    return data;
  } catch (error: any) {
    logger.error('SYSTEM', '← Worker API error', undefined, { endpoint, error: error.message });
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
 * Call Worker HTTP API with path parameter (GET)
 */
async function callWorkerAPIWithPath(
  endpoint: string,
  id: number
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  happy_path_error__with_fallback('[mcp-server] → Worker API (path)', { endpoint, id });

  try {
    const url = `${WORKER_BASE_URL}${endpoint}/${id}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    happy_path_error__with_fallback('[mcp-server] ← Worker API success (path)', { endpoint, id });

    // Wrap raw data in MCP format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error: any) {
    happy_path_error__with_fallback('[mcp-server] ← Worker API error (path)', { endpoint, id, error: error.message });
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
 * Call Worker HTTP API with POST body
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  happy_path_error__with_fallback('[mcp-server] → Worker API (POST)', { endpoint, body });

  try {
    const url = `${WORKER_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    happy_path_error__with_fallback('[mcp-server] ← Worker API success (POST)', { endpoint });

    // Wrap raw data in MCP format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error: any) {
    happy_path_error__with_fallback('[mcp-server] ← Worker API error (POST)', { endpoint, error: error.message });
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
 * Descriptions removed - use progressive_description tool for parameter documentation
 */
const tools = [
  {
    name: 'search',
    description: 'Search memory',
    inputSchema: z.object({
      query: z.string().optional(),
      type: z.enum(['observations', 'sessions', 'prompts']).optional(),
      obs_type: z.string().optional(),
      concepts: z.string().optional(),
      files: z.string().optional(),
      project: z.string().optional(),
      dateStart: z.union([z.string(), z.number()]).optional(),
      dateEnd: z.union([z.string(), z.number()]).optional(),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      orderBy: z.enum(['relevance', 'date_desc', 'date_asc']).default('date_desc')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'timeline',
    description: 'Timeline context',
    inputSchema: z.object({
      query: z.string().optional(),
      anchor: z.number().optional(),
      depth_before: z.number().min(0).max(100).default(10),
      depth_after: z.number().min(0).max(100).default(10),
      type: z.string().optional(),
      concepts: z.string().optional(),
      files: z.string().optional(),
      project: z.string().optional()
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_recent_context',
    description: 'Recent context',
    inputSchema: z.object({
      limit: z.number().min(1).max(100).default(30),
      type: z.string().optional(),
      concepts: z.string().optional(),
      files: z.string().optional(),
      project: z.string().optional(),
      dateStart: z.union([z.string(), z.number()]).optional(),
      dateEnd: z.union([z.string(), z.number()]).optional()
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['get_recent_context'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_context_timeline',
    description: 'Timeline around ID',
    inputSchema: z.object({
      anchor: z.number(),
      depth_before: z.number().min(0).max(100).default(10),
      depth_after: z.number().min(0).max(100).default(10),
      type: z.string().optional(),
      concepts: z.string().optional(),
      files: z.string().optional(),
      project: z.string().optional()
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['get_context_timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'progressive_description',
    description: 'Usage help',
    inputSchema: z.object({
      topic: z.enum(['workflow', 'search_params', 'examples', 'all']).default('all')
    }),
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['progressive_description'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_observation',
    description: 'Fetch by ID',
    inputSchema: z.object({
      id: z.number()
    }),
    handler: async (args: any) => {
      return await callWorkerAPIWithPath('/api/observation', args.id);
    }
  },
  {
    name: 'get_batch_observations',
    description: 'Batch fetch',
    inputSchema: z.object({
      ids: z.array(z.number()),
      orderBy: z.enum(['date_desc', 'date_asc']).optional(),
      limit: z.number().optional(),
      project: z.string().optional()
    }),
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/observations/batch', args);
    }
  },
  {
    name: 'get_session',
    description: 'Session by ID',
    inputSchema: z.object({
      id: z.number()
    }),
    handler: async (args: any) => {
      return await callWorkerAPIWithPath('/api/session', args.id);
    }
  },
  {
    name: 'get_prompt',
    description: 'Prompt by ID',
    inputSchema: z.object({
      id: z.number()
    }),
    handler: async (args: any) => {
      return await callWorkerAPIWithPath('/api/prompt', args.id);
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

  // Check Worker availability in background
  setTimeout(async () => {
    const workerAvailable = await verifyWorkerConnection();
    if (!workerAvailable) {
      logger.warn('SYSTEM', 'Worker not available', undefined, { workerUrl: WORKER_BASE_URL });
      logger.warn('SYSTEM', 'Tools will fail until Worker is started');
      logger.warn('SYSTEM', 'Start Worker with: npm run worker:restart');
    } else {
      logger.info('SYSTEM', 'Worker available', undefined, { workerUrl: WORKER_BASE_URL });
    }
  }, 0);
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(1);
});
