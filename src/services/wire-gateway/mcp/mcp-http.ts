// SPDX-License-Identifier: Apache-2.0
//
// claude-mem's MCP tools over Streamable HTTP at the gateway's /mcp (plan
// Phase 12 task 3, D8: one port for everything "wire"). The same tool table
// the stdio server answers from (src/servers/mcp-tool-table.ts).
//
// Stateless, as the SDK's web-standard transport documents it: a new server
// and a new transport per request (`sessionIdGenerator: undefined`; a
// reused stateless transport would mix JSON-RPC ids of different clients),
// answering in JSON rather than SSE (`enableJsonResponse: true`). The
// transport itself answers a POST whose Accept lacks application/json or
// text/event-stream with 406, and a body that is not JSON with 415
// (@modelcontextprotocol/sdk 1.32.1 server/webStandardStreamableHttp.js
// handlePostRequest). A stateless server has no stream to resume and no
// session to end, so GET and DELETE get 405.
//
// The server is the low-level `Server` with tools/list and tools/call
// handlers, as the stdio server and the server runtime's /v1/mcp
// (src/server/mcp/recall-mcp-server.ts) are built: McpServer.registerTool
// takes Zod shapes (server/mcp.d.ts registerTool: ZodRawShapeCompat |
// AnySchema), and the table's tools are JSON Schema.
//
// Loopback only: the gateway's network guard refuses anything else before
// routing (router.ts).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { logger } from '../../../utils/logger.js';

export interface WireMcpToolRegistrar {
  /** Answer tools/list and tools/call on `server`. */
  registerOn(server: Server): void;
}

export interface WireMcpHandlerOptions {
  /** The tool table; loaded on the first request (it reads settings). */
  toolTable: () => WireMcpToolRegistrar | Promise<WireMcpToolRegistrar>;
  version: string;
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function createWireMcpHandler(options: WireMcpHandlerOptions) {
  let toolTable: Promise<WireMcpToolRegistrar> | null = null;
  return async function handleWireMcpRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonRpcError(405, 'Method not allowed: the claude-mem wire gateway serves MCP statelessly; send JSON-RPC by POST', { allow: 'POST' });
    }
    if (!toolTable) {
      const loading = Promise.resolve().then(() => options.toolTable());
      toolTable = loading;
      // A table that failed to load is asked for again by the next request.
      loading.catch(error => {
        if (toolTable === loading) toolTable = null;
        logger.warn('WIRE', 'The MCP tool table could not be loaded', { error: error instanceof Error ? error.message : String(error) });
      });
    }
    const server = new Server({ name: 'claude-mem', version: options.version }, { capabilities: { tools: {} } });
    (await toolTable).registerOn(server);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transport.onerror = error => logger.debug('WIRE', 'MCP request refused or failed', { error: error.message });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  };
}
