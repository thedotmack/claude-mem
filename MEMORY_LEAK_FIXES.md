# Memory Leak Fixes - Process Cleanup

## Problem Summary

Multiple `uvx` and Python processes were accumulating over time, eventually consuming excessive system resources. The root cause was improper cleanup of child processes spawned by:

1. **ChromaSync** - Each instance spawns a `uvx chroma-mcp` process via MCP StdioClientTransport
2. **Search Server** - Spawns a `uvx chroma-mcp` process for semantic search
3. **Worker Service** - Creates an MCP client connection to the search server

## Root Causes

### 1. ChromaSync Not Closed in DatabaseManager
**Location**: `src/services/worker/DatabaseManager.ts:42-52`

**Problem**: The `close()` method did not call `chromaSync.close()`, leaving the uvx process running even after the worker shut down.

**Fix**: Added explicit ChromaSync cleanup in the close() method:
```typescript
async close(): Promise<void> {
  // Close ChromaSync first (terminates uvx/python processes)
  if (this.chromaSync) {
    try {
      await this.chromaSync.close();
      this.chromaSync = null;
    } catch (error) {
      logger.error('DB', 'Failed to close ChromaSync', {}, error as Error);
    }
  }
  // ... rest of cleanup
}
```

### 2. Search Server No Cleanup Handlers
**Location**: `src/servers/search-server.ts:1743-1781`

**Problem**: The search server had no SIGTERM/SIGINT handlers, so child processes were orphaned when the server was terminated (especially during PM2 restarts).

**Fix**: Added comprehensive cleanup function:
```typescript
async function cleanup() {
  console.error('[search-server] Shutting down...');
  
  // Close Chroma client (terminates uvx/python processes)
  if (chromaClient) {
    await chromaClient.close();
  }
  
  // Close database connections
  if (search) search.close();
  if (store) store.close();
  
  process.exit(0);
}

// Register cleanup handlers
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
```

### 3. Worker Service Not Closing MCP Client
**Location**: `src/services/worker-service.ts:214-230`

**Problem**: The worker service connected to the search server via MCP client but never closed the connection, keeping the search server process alive.

**Fix**: Added MCP client cleanup in shutdown:
```typescript
async shutdown(): Promise<void> {
  await this.sessionManager.shutdownAll();
  
  // Close MCP client connection (terminates search server process)
  if (this.mcpClient) {
    try {
      await this.mcpClient.close();
      logger.info('SYSTEM', 'MCP client closed');
    } catch (error) {
      logger.error('SYSTEM', 'Failed to close MCP client', {}, error as Error);
    }
  }
  
  // ... rest of shutdown
}
```

### 4. PM2 Configuration Not Optimized for Graceful Shutdown
**Location**: `ecosystem.config.cjs`

**Problem**: PM2 watch mode was restarting the worker frequently, but without proper configuration for graceful shutdown, child processes could be orphaned.

**Fix**: Enhanced PM2 configuration:
```javascript
{
  kill_timeout: 5000,        // Extra time for cleanup
  wait_ready: true,          // Wait for process to be ready
  kill_signal: 'SIGTERM',    // Use graceful shutdown signal
  ignore_watch: [
    'vector-db',             // Don't restart on Chroma DB changes
    '.claude-mem'            // Don't restart on data changes
  ]
}
```

## Process Lifecycle

### Before Fixes
```
SessionStart -> Worker -> DatabaseManager -> ChromaSync -> uvx (orphaned)
                    \-> MCP Client -> Search Server -> uvx (orphaned)
                                           \-> Chroma Client -> uvx (orphaned)
Worker Restart -> 3 new orphaned processes per restart
```

### After Fixes
```
SessionStart -> Worker -> DatabaseManager -> ChromaSync -> uvx
                                                              ↓
Shutdown -> DatabaseManager.close() -> chromaSync.close() -> terminates uvx

Worker -> MCP Client -> Search Server -> Chroma Client -> uvx
            ↓                              ↓
Worker.shutdown() -> mcpClient.close()     ↓
                              ↓            ↓
                    Search Server cleanup() -> chromaClient.close()
                                                    ↓
                                              terminates uvx
```

## Testing Process Cleanup

### Manual Test
1. Start worker: `pm2 start ecosystem.config.cjs`
2. Check processes: `ps aux | grep -E "(uvx|python.*chroma)" | grep -v grep`
3. Create a session (trigger ChromaSync)
4. Check process count again
5. Restart worker: `pm2 restart claude-mem-worker`
6. Wait 5 seconds for cleanup
7. Check final process count - should return to baseline

### Expected Behavior
- **Baseline**: 0-1 uvx/python processes (persistent PM2 worker)
- **During Session**: +2-3 processes (ChromaSync, Search Server, Chroma)
- **After Restart**: Returns to baseline within 5 seconds

## Verification

Run the test script:
```bash
chmod +x tests/test-process-cleanup.sh
./tests/test-process-cleanup.sh
```

Expected output:
```
=== Process Cleanup Test ===
1. Initial process count: 0
2. Starting test process...
   During execution: 3 processes
3. Final process count: 0
✅ PASS: No process leaks detected
```

## Monitoring

To monitor for leaks in production:

```bash
# Watch process count over time
watch -n 5 'ps aux | grep -E "(uvx|python.*chroma)" | grep -v grep | wc -l'

# Detailed process list
ps aux | grep -E "(uvx|python.*chroma)" | grep -v grep

# PM2 process monitoring
pm2 monit
```

## Additional Safeguards

1. **Error Handling**: All cleanup operations have try-catch blocks to ensure partial cleanup succeeds even if one component fails
2. **Logging**: Comprehensive logging of cleanup operations for debugging
3. **Timeout Configuration**: PM2 kill_timeout ensures enough time for graceful shutdown
4. **Signal Handling**: Both SIGTERM and SIGINT handlers registered for flexibility

## Future Improvements

1. **Process Monitoring**: Add metrics to track child process count over time
2. **Health Checks**: Periodic verification that process count stays within expected bounds
3. **Automatic Cleanup**: Detect and clean up orphaned processes on worker startup
4. **Resource Limits**: Set memory/CPU limits on child processes to prevent runaway resource usage
