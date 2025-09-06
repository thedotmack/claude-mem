# MCP TypeScript SDK Stdio Transport Guide

## Documentation Source
- **SDK Version**: @modelcontextprotocol/sdk v1.0.0
- **Last Verified**: 2025-09-01
- **Official Docs**: https://github.com/modelcontextprotocol/typescript-sdk

## Stdio Transport Overview

The StdioServerTransport enables MCP servers to communicate via standard input/output streams, making them ideal for CLI tools and direct integrations with Claude Code.

## Communication Channels

### Stream Usage
- **stdin**: Receives MCP protocol messages (JSON-RPC)
- **stdout**: Sends MCP protocol responses (JSON-RPC)
- **stderr**: Logging and diagnostic output

### Important Rules
1. **Never write non-protocol data to stdout** - This will break the protocol
2. **Always use console.error() for logging** - Goes to stderr
3. **Handle binary data carefully** - Protocol is text-based JSON

## Implementation Patterns

### Basic Stdio Server Setup

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Create server
const server = new Server(
  { name: 'my-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Create and connect transport
const transport = new StdioServerTransport();
await server.connect(transport);

// Server is now listening on stdin/stdout
console.error('Server started'); // Note: console.error for logging
```

### With McpServer (High-Level API)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({
  name: 'my-server',
  version: '1.0.0'
});

// Register tools, resources, prompts...
server.registerTool(...);

// Connect to stdio
const transport = new StdioServerTransport();
await server.connect(transport);
```

## CLI Entry Point Pattern

### Proper Module Detection (ES Modules)

```typescript
#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Only run if executed directly
if (process.argv[1] === __filename || 
    process.argv[1].endsWith('server.js')) {
  main().catch((error) => {
    console.error('Startup error:', error);
    process.exit(1);
  });
}
```

### Main Function Pattern

```typescript
async function main(): Promise<void> {
  try {
    // 1. Initialize dependencies
    await initializeDatabase();
    
    // 2. Create server
    const server = createServer();
    
    // 3. Create transport
    const transport = new StdioServerTransport();
    
    // 4. Connect
    await server.connect(transport);
    
    // 5. Setup shutdown handlers
    setupShutdownHandlers();
    
    // 6. Log readiness to stderr
    console.error('MCP server ready on stdio');
    
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}
```

## Shutdown Handling

### Graceful Shutdown Pattern

```typescript
function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    console.error(`\nReceived ${signal}, shutting down...`);
    
    try {
      // Clean up resources
      await cleanupResources();
      
      // Note: Transport cleanup is handled automatically
      process.exit(0);
    } catch (error) {
      console.error('Shutdown error:', error);
      process.exit(1);
    }
  };
  
  // Handle termination signals
  process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => shutdown('SIGTERM')); // Kill
  process.on('SIGHUP', () => shutdown('SIGHUP'));   // Terminal closed
  
  // Handle errors
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    process.exit(1);
  });
}
```

## Logging Best Practices

### Do's and Don'ts

```typescript
// ✅ DO: Log to stderr
console.error('Server initialized');
console.error('Processing request:', requestId);
console.error('Debug info:', { data });

// ❌ DON'T: Log to stdout
console.log('This breaks the protocol!'); // NEVER DO THIS

// ✅ DO: Use structured logging to stderr
const log = (level: string, message: string, data?: any) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  }));
};

log('info', 'Server started', { port: 'stdio' });
```

### Debug Mode Pattern

```typescript
const DEBUG = process.env.DEBUG === 'true';

const debug = (message: string, ...args: any[]) => {
  if (DEBUG) {
    console.error(`[DEBUG] ${message}`, ...args);
  }
};

// Usage
debug('Request received:', request);
```

## Testing Stdio Servers

### Manual Testing

```bash
# Start server and interact manually
node dist/server.js

# With debug logging
DEBUG=true node dist/server.js

# Pipe test input
echo '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}' | node dist/server.js
```

### Automated Testing Pattern

```typescript
import { spawn } from 'child_process';

function testServer() {
  const server = spawn('node', ['dist/server.js']);
  
  // Capture stderr for logs
  server.stderr.on('data', (data) => {
    console.log('Server log:', data.toString());
  });
  
  // Capture stdout for protocol
  let response = '';
  server.stdout.on('data', (data) => {
    response += data.toString();
    // Parse and validate response
  });
  
  // Send test request
  server.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {},
    id: 1
  }));
  server.stdin.end();
}
```

## Common Issues and Solutions

### Issue 1: Protocol Corruption

**Problem**: Random text in stdout breaks communication
**Solution**: Always use console.error() for logging

```typescript
// Wrong
console.log('Debug:', data); // Breaks protocol

// Right
console.error('Debug:', data); // Safe for debugging
```

### Issue 2: Server Not Responding

**Problem**: Server starts but doesn't respond to requests
**Solution**: Ensure transport is connected

```typescript
// Check connection is awaited
await server.connect(transport); // Must await!
console.error('Transport connected');
```

### Issue 3: Premature Exit

**Problem**: Server exits immediately
**Solution**: Don't close stdin/stdout

```typescript
// Wrong
process.stdin.end(); // Don't do this

// Right
// Let the transport manage streams
```

## Integration with Claude Code

### Configuration in .claude.json

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/dist/server.js"],
      "env": {
        "DEBUG": "false"
      }
    }
  }
}
```

### Best Practices for Claude Code Integration

1. **Startup Messages**: Log clear startup messages to stderr
2. **Error Messages**: Provide actionable error messages
3. **Ready Signal**: Log when server is ready to accept requests
4. **Version Info**: Include version in startup logs

```typescript
console.error(`Starting ${serverName} v${version}`);
console.error('Initializing...');
// ... initialization ...
console.error(`${serverName} ready on stdio`);
```

## Performance Considerations

### Buffering and Streaming

```typescript
// For large responses, consider streaming
import { Transform } from 'stream';

class ResponseStream extends Transform {
  _transform(chunk: any, encoding: string, callback: Function) {
    // Process chunk
    this.push(JSON.stringify(chunk));
    callback();
  }
}
```

### Memory Management

```typescript
// Clear large objects after use
let largeData = await processData();
// Use data...
largeData = null; // Allow GC
```

## References

- [StdioServerTransport Docs](https://github.com/modelcontextprotocol/typescript-sdk#stdio-transport)
- [Server Examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/src/examples/server)
- [MCP Protocol Specification](https://modelcontextprotocol.io/docs)