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
  'help': '/api/instructions'
};

/**
 * Detailed parameter schemas for each tool
 */
const TOOL_SCHEMAS: Record<string, any> = {
  search: {
    query: { type: 'string', description: 'Full-text search query' },
    type: { type: 'string', description: 'Filter by type: tool_use, tool_result, prompt, summary' },
    obs_type: { type: 'string', description: 'Observation type filter' },
    concepts: { type: 'string', description: 'Comma-separated concept tags' },
    files: { type: 'string', description: 'Comma-separated file paths' },
    project: { type: 'string', description: 'Project name filter' },
    dateStart: { type: ['string', 'number'], description: 'Start date (ISO or timestamp)' },
    dateEnd: { type: ['string', 'number'], description: 'End date (ISO or timestamp)' },
    limit: { type: 'number', description: 'Max results (default: 10)' },
    offset: { type: 'number', description: 'Result offset for pagination' },
    orderBy: { type: 'string', description: 'Sort order: created_at, relevance' }
  },
  timeline: {
    query: { type: 'string', description: 'Search query to find anchor point' },
    anchor: { type: 'number', description: 'Observation ID as timeline center' },
    depth_before: { type: 'number', description: 'Observations before anchor (default: 5)' },
    depth_after: { type: 'number', description: 'Observations after anchor (default: 5)' },
    type: { type: 'string', description: 'Filter by type' },
    concepts: { type: 'string', description: 'Comma-separated concept tags' },
    files: { type: 'string', description: 'Comma-separated file paths' },
    project: { type: 'string', description: 'Project name filter' }
  },
  get_recent_context: {
    limit: { type: 'number', description: 'Max results (default: 20)' },
    type: { type: 'string', description: 'Filter by type' },
    concepts: { type: 'string', description: 'Comma-separated concept tags' },
    files: { type: 'string', description: 'Comma-separated file paths' },
    project: { type: 'string', description: 'Project name filter' },
    dateStart: { type: ['string', 'number'], description: 'Start date' },
    dateEnd: { type: ['string', 'number'], description: 'End date' }
  },
  get_context_timeline: {
    anchor: { type: 'number', description: 'Observation ID (required)', required: true },
    depth_before: { type: 'number', description: 'Observations before anchor' },
    depth_after: { type: 'number', description: 'Observations after anchor' },
    type: { type: 'string', description: 'Filter by type' },
    concepts: { type: 'string', description: 'Comma-separated concept tags' },
    files: { type: 'string', description: 'Comma-separated file paths' },
    project: { type: 'string', description: 'Project name filter' }
  },
  get_observations: {
    ids: { type: 'array', items: { type: 'number' }, description: 'Array of observation IDs (required)', required: true },
    orderBy: { type: 'string', description: 'Sort order' },
    limit: { type: 'number', description: 'Max results' },
    project: { type: 'string', description: 'Project filter' }
  },
  help: {
    operation: { type: 'string', description: 'Operation type: "observations", "timeline", "sessions", etc.' },
    topic: { type: 'string', description: 'Specific topic for help' }
  },
  get_observation: {
    id: { type: 'number', description: 'Observation ID (required)', required: true }
  },
  get_session: {
    id: { type: 'number', description: 'Session ID (required)', required: true }
  },
  get_prompt: {
    id: { type: 'number', description: 'Prompt ID (required)', required: true }
  }
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
  logger.debug('HTTP', 'Worker API request (path)', undefined, { endpoint, id });

  try {
    const url = `${WORKER_BASE_URL}${endpoint}/${id}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    logger.debug('HTTP', 'Worker API success (path)', undefined, { endpoint, id });

    // Wrap raw data in MCP format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error: any) {
    logger.error('HTTP', 'Worker API error (path)', undefined, { endpoint, id, error: error.message });
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
  logger.debug('HTTP', 'Worker API request (POST)', undefined, { endpoint });

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

    logger.debug('HTTP', 'Worker API success (POST)', undefined, { endpoint });

    // Wrap raw data in MCP format
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error: any) {
    logger.error('HTTP', 'Worker API error (POST)', undefined, { endpoint, error: error.message });
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
 * Minimal descriptions - use help() tool with operation parameter for detailed docs
 */
const tools = [
  {
    name: 'get_schema',
    description: 'Get parameter schema for a tool. Call get_schema(tool_name) for details',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' } },
      required: ['tool_name']
    },
    handler: async (args: any) => {
      // Validate tool_name to prevent prototype pollution
      const toolName = args.tool_name;
      if (typeof toolName !== 'string' || !Object.hasOwn(TOOL_SCHEMAS, toolName)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown tool: ${toolName}\n\nAvailable tools: ${Object.keys(TOOL_SCHEMAS).join(', ')}`
          }],
          isError: true
        };
      }

      const schema = TOOL_SCHEMAS[toolName];
      return {
        content: [{
          type: 'text' as const,
          text: `# ${toolName} Parameters\n\n${JSON.stringify(schema, null, 2)}`
        }]
      };
    }
  },
  {
    name: 'search',
    description: 'Search memory. All parameters optional - call get_schema("search") for details',
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
    description: 'Timeline context. All parameters optional - call get_schema("timeline") for details',
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
    name: 'get_recent_context',
    description: 'Recent context. All parameters optional - call get_schema("get_recent_context") for details',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['get_recent_context'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_context_timeline',
    description: 'Timeline around observation ID',
    inputSchema: {
      type: 'object',
      properties: {
        anchor: {
          type: 'number',
          description: 'Observation ID (required). Optional params: get_schema("get_context_timeline")'
        }
      },
      required: ['anchor'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['get_context_timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'help',
    description: 'Get detailed docs. All parameters optional - call get_schema("help") for details',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['help'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_observation',
    description: 'Fetch observation by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Observation ID (required)'
        }
      },
      required: ['id']
    },
    handler: async (args: any) => {
      return await callWorkerAPIWithPath('/api/observation', args.id);
    }
  },
  {
    name: 'get_observations',
    description: 'Batch fetch observations',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of observation IDs (required). Optional params: get_schema("get_observations")'
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
    name: 'get_session',
    description: 'Fetch session by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Session ID (required)'
        }
      },
      required: ['id']
    },
    handler: async (args: any) => {
      return await callWorkerAPIWithPath('/api/session', args.id);
    }
  },
  {
    name: 'get_prompt',
    description: 'Fetch prompt by ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Prompt ID (required)'
        }
      },
      required: ['id']
    },
    handler: async (args: any) => {
      return await callWorkerAPIWithPath('/api/prompt', args.id);
    }
  }
];

// Create the MCP server
const server = new Server(
  {
    name: 'mem-search-server',
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
