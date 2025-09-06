# MCP TypeScript SDK Server Implementation Guide

## Documentation Source
- **SDK Version**: @modelcontextprotocol/sdk v1.0.0
- **Last Verified**: 2025-09-01
- **Official Docs**: https://github.com/modelcontextprotocol/typescript-sdk

## Server Creation Patterns

### Low-Level Server vs McpServer

The SDK provides two approaches for creating MCP servers:

1. **Low-Level Server Class** (Used in claude-mem)
   - Direct control over request handling
   - Manual registration with `setRequestHandler`
   - More flexibility for custom routing logic

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server(
  {
    name: 'server-name',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}  // Declare tool capability
    }
  }
);
```

2. **High-Level McpServer Class** (Alternative approach)
   - Simplified API with `registerTool`, `registerResource`, `registerPrompt`
   - Automatic routing and validation
   - Less boilerplate code

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({
  name: 'server-name',
  version: '1.0.0'
});
```

## Tool Handler Registration

### Pattern 1: Single Handler with CallToolRequestSchema (claude-mem approach)

```typescript
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  // Validate arguments exist
  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }
  
  // Route to specific tool implementation
  switch (name) {
    case 'tool-name':
      // Tool implementation
      return {
        content: [{
          type: 'text',
          text: 'Result'
        }]
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});
```

### Pattern 2: Individual Tool Registration (McpServer approach)

```typescript
server.registerTool(
  'tool-name',
  {
    title: 'Tool Title',
    description: 'Tool description',
    inputSchema: { param: z.string() }
  },
  async ({ param }) => ({
    content: [{
      type: 'text',
      text: `Result for ${param}`
    }]
  })
);
```

## Stdio Transport Usage

### Standard Pattern for CLI-based Servers

```typescript
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

async function main() {
  // 1. Initialize backend services first
  await initializeBackend();
  
  // 2. Create transport
  const transport = new StdioServerTransport();
  
  // 3. Connect server to transport
  await server.connect(transport);
  
  // 4. Log to stderr (stdout is for protocol)
  console.error('Server started on stdio');
}
```

### Key Points:
- **Stdin**: Receives MCP protocol messages
- **Stdout**: Sends MCP protocol responses
- **Stderr**: Used for logging and diagnostics

## Error Handling Patterns

### Tool Error Response

```typescript
try {
  // Tool implementation
  return {
    content: [{
      type: 'text',
      text: 'Success result'
    }]
  };
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  // Log to stderr for debugging
  console.error(`[Error] Tool: ${name}, Error: ${errorMessage}`);
  
  // Return error response with isError flag
  return {
    content: [{
      type: 'text',
      text: `Error: ${errorMessage}`
    }],
    isError: true  // Important: Indicates tool failure
  };
}
```

### Startup Error Handling

```typescript
main().catch((error) => {
  console.error('Startup error:', error);
  process.exit(1);  // Exit with error code
});
```

## Response Formatting

### Success Response Structure

```typescript
{
  content: [
    {
      type: 'text',
      text: 'Response text'
    }
  ]
}
```

### Error Response Structure

```typescript
{
  content: [
    {
      type: 'text',
      text: 'Error: Description'
    }
  ],
  isError: true
}
```

### Resource Link Response

```typescript
{
  content: [
    {
      type: 'resource_link',
      uri: 'file:///path/to/resource',
      name: 'Resource Name',
      mimeType: 'text/plain',
      description: 'Resource description'
    }
  ]
}
```

## Lifecycle Management

### Initialization Pattern

```typescript
async function initializeServer(): Promise<void> {
  try {
    // Initialize backend connections
    await backend.connect();
    console.error('Backend initialized');
  } catch (error) {
    console.error('Initialization failed:', error);
    throw error;  // Prevent server startup
  }
}
```

### Shutdown Pattern

```typescript
function setupShutdownHandlers(): void {
  const handleShutdown = async (signal: string) => {
    console.error(`Received ${signal}, shutting down...`);
    
    try {
      await backend.disconnect();
      process.exit(0);  // Clean exit
    } catch (error) {
      console.error('Shutdown error:', error);
      process.exit(1);  // Error exit
    }
  };
  
  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  
  // Handle unexpected errors
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error);
    await backend.disconnect();
    process.exit(1);
  });
}
```

## Best Practices Summary

1. **Server Creation**
   - Use low-level Server for custom routing
   - Use McpServer for standard implementations

2. **Transport Usage**
   - Initialize backends before connecting transport
   - Use StdioServerTransport for CLI tools
   - Log to stderr, not stdout

3. **Error Handling**
   - Always validate tool arguments
   - Include isError flag in error responses
   - Log errors to stderr with context

4. **Response Format**
   - Always return content array
   - Use consistent type/text structure
   - Include isError for failures

5. **Lifecycle**
   - Clean initialization sequence
   - Graceful shutdown handlers
   - Proper exit codes (0 for success, 1 for error)

## References

- [MCP TypeScript SDK README](https://github.com/modelcontextprotocol/typescript-sdk)
- [Low-Level Server Pattern](https://github.com/modelcontextprotocol/typescript-sdk#low-level-server-implementation)
- [Stdio Transport Example](https://github.com/modelcontextprotocol/typescript-sdk#stdio-transport)
- [Error Handling Examples](https://github.com/modelcontextprotocol/typescript-sdk#sqlite-explorer)