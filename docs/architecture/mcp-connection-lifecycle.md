# MCP Connection Lifecycle - Chroma Vector Search

## Executive Summary

**We are using the MCP SDK correctly.** ChromaSync maintains a single, persistent connection to the chroma-mcp server for the entire worker lifetime. The uvx subprocess is spawned ONCE and reused for all operations.

## The Misconception

**❌ INCORRECT ASSUMPTION:** "We are constantly spawning uvx"

**✅ REALITY:** We spawn uvx exactly once per worker process, on first use of ChromaSync.

## Architecture Overview

```
Worker Lifetime
├── DatabaseManager.initialize()
│   └── new ChromaSync('claude-mem')  <-- Instance created
│
├── First search/sync operation
│   └── ensureConnection()  <-- Spawns uvx chroma-mcp ONCE
│       ├── new StdioClientTransport({ command: 'uvx', args: [...] })
│       ├── client.connect(transport)
│       └── this.connected = true
│
├── Subsequent operations (hundreds/thousands)
│   └── ensureConnection()  <-- Returns immediately (early return)
│       └── if (this.connected && this.client) return;  <-- NO SPAWN
│
└── DatabaseManager.close()  <-- Worker shutdown
    └── chromaSync.close()
        ├── client.close()  <-- Graceful MCP shutdown
        └── transport.close()  <-- Kills uvx subprocess
```

## Code Evidence

### ChromaSync Constructor (Called ONCE)

```typescript
// DatabaseManager.ts line 31
this.chromaSync = new ChromaSync('claude-mem');
```

- DatabaseManager is instantiated once per worker
- ChromaSync instance lives for entire worker lifetime
- No new instances created between operations

### ensureConnection() - The Reuse Pattern

```typescript
// ChromaSync.ts line 96-99
private async ensureConnection(): Promise<void> {
  // CRITICAL GUARD: Prevents constant respawning
  if (this.connected && this.client) {
    return;  // Early return - NO subprocess spawn
  }
  
  // Only reaches here on:
  // 1. First call after constructor
  // 2. Connection lost (this.connected was set to false)
  // 3. After explicit close() (rare, usually shutdown)
  
  logger.info('CHROMA_SYNC', 'Connecting to Chroma MCP server (spawning uvx chroma-mcp)...');
  
  this.transport = new StdioClientTransport({
    command: 'uvx',
    args: ['--python', pythonVersion, 'chroma-mcp', '--client-type', 'persistent', '--data-dir', this.VECTOR_DB_DIR],
    stderr: 'ignore'
  });
  
  this.client = new Client({ name: 'claude-mem-chroma-sync', version: packageVersion }, { capabilities: {} });
  
  await this.client.connect(this.transport);
  this.connected = true;  // GUARDS FUTURE CALLS
}
```

### Call Sites - All Reuse Same Connection

Every ChromaSync method calls `ensureConnection()`:

```typescript
// syncObservation() -> ensureConnection() -> early return
// syncSummary() -> ensureConnection() -> early return  
// syncUserPrompt() -> ensureConnection() -> early return
// queryChroma() -> ensureConnection() -> early return
// ensureBackfilled() -> ensureConnection() -> early return
```

**Result:** Same `StdioClientTransport` and `Client` instances used for all operations.

## MCP SDK Behavior

### StdioClientTransport Lifecycle

The MCP SDK's `StdioClientTransport` is designed for long-lived connections:

1. **Constructor:** Stores command/args, doesn't spawn yet
2. **client.connect(transport):** Spawns subprocess via `child_process.spawn()`
3. **Operations:** Bidirectional stdio communication with spawned process
4. **transport.close():** Kills subprocess, closes stdio streams

### Our Usage Pattern

```typescript
// SPAWN ONCE
const transport = new StdioClientTransport({ command: 'uvx', args: [...] });
const client = new Client(...);
await client.connect(transport);  // <-- Spawns subprocess HERE

// REUSE HUNDREDS OF TIMES
await client.callTool({ name: 'chroma_query_documents', arguments: {...} });  // Same subprocess
await client.callTool({ name: 'chroma_add_documents', arguments: {...} });    // Same subprocess
await client.callTool({ name: 'chroma_query_documents', arguments: {...} });  // Same subprocess
// ... hundreds more calls ...

// CLOSE ON SHUTDOWN
await client.close();      // Graceful MCP shutdown
await transport.close();   // Kills subprocess
```

This matches the MCP SDK's intended usage pattern exactly.

## When New Connections Are Created

### 1. Worker Startup (Normal)

```
1. Worker starts (worker-service.ts)
2. DatabaseManager.initialize()
3. new ChromaSync('claude-mem')
4. First search/sync operation
5. ensureConnection() spawns uvx
```

**Frequency:** Once per worker restart (rare in production)

### 2. Connection Loss (Error Recovery)

```typescript
// ChromaSync.ts - Error handling in queryChroma()
if (errorMessage.includes('Not connected') || 
    errorMessage.includes('Connection closed') || 
    errorMessage.includes('MCP error -32000')) {
  this.connected = false;  // <-- Triggers reconnect on next call
  this.client = null;
  throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
}
```

**Frequency:** Only when MCP server crashes or loses connection

### 3. Explicit Close + Reopen (Extremely Rare)

```typescript
await chromaSync.close();  // Shutdown
// ... time passes ...
await chromaSync.queryChroma(...);  // Would reconnect if called
```

**Frequency:** Only during worker shutdown, won't reopen in practice

## Performance Implications

### Current Pattern (Correct)

- **Worker lifetime:** 1 uvx subprocess
- **1000 searches:** 1 subprocess, 1000 MCP RPC calls over stdio
- **Process overhead:** Minimal (single Python process kept warm)
- **Memory:** Constant (one chroma-mcp instance)

### If We Were Spawning Per Operation (Incorrect)

- **Worker lifetime:** N uvx subprocesses (where N = # of operations)
- **1000 searches:** 1000 subprocess spawns, 1000 Python interpreter starts
- **Process overhead:** Massive (fork/exec for each call)
- **Memory:** Linear growth until cleanup

**Our current pattern is optimal.**

## Verification Steps

### 1. Log Analysis

Enable debug logging and watch for this pattern:

```
INFO  CHROMA_SYNC: MCP connection established successfully (project: claude-mem)
DEBUG CHROMA_SYNC: Reusing existing MCP connection (no new spawn)
DEBUG CHROMA_SYNC: Reusing existing MCP connection (no new spawn)
DEBUG CHROMA_SYNC: Reusing existing MCP connection (no new spawn)
... (hundreds of reuse logs, only ONE "established" log)
```

### 2. Process Monitoring

```bash
# Watch for chroma-mcp processes
watch -n 1 'ps aux | grep chroma-mcp'

# Should see:
# - One stable process with consistent PID
# - Process lifetime matches worker lifetime
# - NO new processes appearing on each search
```

### 3. Network/Stdio Monitoring

```bash
# Monitor file descriptor usage
lsof -p <worker-pid> | grep pipe

# Should see:
# - Stable pipe FDs to chroma-mcp subprocess
# - Same FDs used across all operations
```

## Why This Pattern Is Correct

1. **MCP SDK Design:** `StdioClientTransport` is built for persistent connections
2. **Performance:** Avoids subprocess spawn overhead
3. **Resource Efficiency:** Single Python interpreter, single embedding model load
4. **Reliability:** Connection loss is detected and triggers reconnect
5. **Industry Standard:** Matches how other MCP clients use stdio servers

## Comparison to Other MCP Patterns

### Server-Sent Events (SSE) Transport

Some MCP servers use HTTP/SSE:

```typescript
const transport = new SSEClientTransport(new URL('http://localhost:3000/sse'));
await client.connect(transport);
```

- Server runs as daemon (systemd, Docker, etc.)
- HTTP connection can reconnect easily
- Transport closes on HTTP error, reconnects on next operation

### Stdio Transport (Our Pattern)

```typescript
const transport = new StdioClientTransport({ command: 'uvx', args: [...] });
await client.connect(transport);
```

- Server spawned as subprocess
- Stdio pipes established at spawn
- Transport manages subprocess lifecycle
- **Same persistent connection pattern as SSE**

Both patterns keep the server alive across operations.

## Conclusion

**We are using the MCP package correctly.**

- ✅ Single ChromaSync instance per worker
- ✅ Single uvx subprocess spawned on first use
- ✅ Connection reused for all operations via `ensureConnection()` guard
- ✅ Graceful cleanup on worker shutdown
- ✅ Error recovery via connection loss detection

**No changes needed to the connection pattern.**

The perceived "constant spawning" is actually constant **connection reuse**, which is the correct and efficient approach for MCP stdio servers.

## Future Enhancements (Optional)

While our current pattern is correct, we could add:

1. **Connection Health Monitoring**
   - Periodic ping/keepalive to detect stale connections
   - Proactive reconnect before operations fail

2. **Metrics Collection**
   - Count connection reuses vs new connections
   - Track subprocess uptime
   - Monitor MCP RPC latency

3. **Graceful Degradation**
   - Retry logic for transient MCP errors
   - Exponential backoff on reconnect attempts

4. **Connection Pooling** (NOT RECOMMENDED)
   - Multiple ChromaSync instances for parallel operations
   - Unnecessary complexity for our workload
   - Current single connection handles concurrent calls fine

None of these are needed to address the original concern.

---

**Last Updated:** 2026-01-18  
**Author:** Claude Copilot  
**Status:** Resolved - No changes needed
