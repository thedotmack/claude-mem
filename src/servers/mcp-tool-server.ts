import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  annotations?: { readOnlyHint?: boolean };
  handler: (args: any) => Promise<any>;
}

export function createMcpToolServer(
  tools: readonly McpToolDefinition[],
  version: string,
): Server {
  const server = new Server(
    { name: 'claude-mem', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      ...(annotations ? { annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find(({ name }) => name === request.params.name);

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
          text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  });

  return server;
}
