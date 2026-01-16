#!/usr/bin/env node

/**
 * Remote MCP Wrapper for Claude-Mem
 *
 * Enables OpenCode (or other MCP clients) running on a remote machine to connect
 * to the claude-mem worker service over HTTP.
 *
 * Configuration via environment variables:
 * - CLAUDE_MEM_REMOTE_HOST: Host where claude-mem worker is running (default: localhost)
 * - CLAUDE_MEM_REMOTE_PORT: Port where claude-mem worker is running (default: 37777)
 *
 * Usage in OpenCode config:
 * {
 *   "mcp": {
 *     "claude-mem-remote": {
 *       "command": "node",
 *       "args": ["/path/to/remote-mcp-wrapper.js"],
 *       "env": {
 *         "CLAUDE_MEM_REMOTE_HOST": "192.168.1.100",
 *         "CLAUDE_MEM_REMOTE_PORT": "37777"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const REMOTE_HOST = process.env.CLAUDE_MEM_REMOTE_HOST || 'localhost';
const REMOTE_PORT = process.env.CLAUDE_MEM_REMOTE_PORT || '37777';
const BASE_URL = `http://${REMOTE_HOST}:${REMOTE_PORT}`;

// Redirect console to stderr to avoid breaking MCP protocol on stdout
const originalConsole = { ...console };
console.log = (...args) => originalConsole.error('[remote-mcp-wrapper]', ...args);
console.error = (...args) => originalConsole.error('[remote-mcp-wrapper]', ...args);

class RemoteMCPWrapper {
  constructor() {
    this.server = new Server(
      {
        name: 'claude-mem-remote',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.checkConnection();
  }

  async checkConnection() {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (!response.ok) {
        console.error(`Warning: Claude-mem worker may not be running at ${BASE_URL}`);
      }
    } catch (error) {
      console.error(`Error: Cannot connect to claude-mem worker at ${BASE_URL}`);
      console.error(`Make sure the worker is running and accessible from this machine.`);
    }
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: '__IMPORTANT',
          description: '3-LAYER WORKFLOW (ALWAYS FOLLOW):\n1. search(query) → Get index with IDs (~50-100 tokens/result)\n2. timeline(anchor=ID) → Get context around interesting results\n3. get_observations([IDs]) → Fetch full details ONLY for filtered IDs\nNEVER fetch full details without filtering first. 10x token savings.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'search',
          description: 'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, type, obs_type, dateStart, dateEnd, offset, orderBy',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
              project: { type: 'string' },
              type: { type: 'string' },
              obs_type: { type: 'string' },
              dateStart: { type: 'string' },
              dateEnd: { type: 'string' },
              offset: { type: 'number' },
              orderBy: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: true,
          },
        },
        {
          name: 'timeline',
          description: 'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after, project',
          inputSchema: {
            type: 'object',
            properties: {
              anchor: { type: ['string', 'number'] },
              query: { type: 'string' },
              depth_before: { type: 'number' },
              depth_after: { type: 'number' },
              project: { type: 'string' },
            },
            additionalProperties: true,
          },
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
                description: 'Array of observation IDs to fetch (required)',
              },
              orderBy: { type: 'string' },
              limit: { type: 'number' },
              project: { type: 'string' },
            },
            required: ['ids'],
            additionalProperties: true,
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let response;

        switch (name) {
          case '__IMPORTANT':
            return {
              content: [
                {
                  type: 'text',
                  text: 'This is a reminder about the 3-layer workflow. Please follow the pattern described in the tool description.',
                },
              ],
            };

          case 'search': {
            const params = new URLSearchParams();
            Object.entries(args).forEach(([key, value]) => {
              if (value !== undefined && value !== null) {
                params.append(key, String(value));
              }
            });
            response = await fetch(`${BASE_URL}/api/search?${params.toString()}`);
            break;
          }

          case 'timeline': {
            const params = new URLSearchParams();
            Object.entries(args).forEach(([key, value]) => {
              if (value !== undefined && value !== null) {
                params.append(key, String(value));
              }
            });
            response = await fetch(`${BASE_URL}/api/timeline?${params.toString()}`);
            break;
          }

          case 'get_observations': {
            response = await fetch(`${BASE_URL}/api/observations/batch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(args),
            });
            break;
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error calling ${name}: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Remote MCP wrapper connected to ${BASE_URL}`);
  }
}

const wrapper = new RemoteMCPWrapper();
wrapper.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
