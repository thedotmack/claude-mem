# Issue #753: Chroma MCP UVX Investigation

**Date:** 2026-01-18
**Issue Author:** thedotmack
**Investigator:** Claude Sonnet 4.5
**Status:** RESOLVED - No code changes needed

---

## Executive Summary

Investigation confirms **we ARE using the MCP package correctly**. The codebase properly implements connection reuse as designed by the MCP SDK. A single uvx subprocess is spawned per worker session and reused for all Chroma operations.

**Verdict:** The architecture is sound and follows MCP SDK best practices. No changes required.

---

## Investigation Findings

### 1. Connection Lifecycle Architecture

#### Single Instance Pattern (✅ Correct)

```typescript
// DatabaseManager.ts line 31
this.chromaSync = new ChromaSync('claude-mem');
```

- **Created:** Once at worker startup in `DatabaseManager.initialize()`
- **Lifetime:** Entire worker process (hours/days)
- **Reuse:** Shared across all search operations via `DatabaseManager.getChromaSync()`

#### Lazy Connection Pattern (✅ Correct)

```typescript
// ChromaSync.ts lines 96-99
private async ensureConnection(): Promise<void> {
  if (this.connected && this.client) {
    return; // Reuses existing connection
  }
  // ... connection logic only runs on first call
}
```

- **First call:** Spawns uvx subprocess, connects MCP client
- **Subsequent calls:** Returns immediately, reuses existing connection
- **State tracking:** `this.connected` flag prevents reconnection

#### Transport Lifecycle (✅ Correct)

```typescript
// ChromaSync.ts lines 128-138
this.transport = new StdioClientTransport({
  command: 'uvx',
  args: ['--python', pythonVersion, 'chroma-mcp', '--client-type', 'persistent', '--data-dir', this.VECTOR_DB_DIR],
  stderr: 'ignore'
});

this.client = new Client({
  name: 'claude-mem-chroma-sync',
  version: packageVersion
}, { capabilities: {} });

await this.client.connect(this.transport);
this.connected = true;
```

- **uvx subprocess:** Spawned ONCE per ChromaSync instance
- **Communication:** JSON-RPC over stdin/stdout (persistent connection)
- **Not HTTP:** No reconnection per request - subprocess stays alive

#### Cleanup Pattern (✅ Correct)

```typescript
// ChromaSync.ts lines 886-907
async close(): Promise<void> {
  if (this.client) {
    await this.client.close();
  }
  if (this.transport) {
    await this.transport.close(); // Terminates uvx subprocess
  }
  this.connected = false;
  this.client = null;
  this.transport = null;
}
```

- **Called by:** `DatabaseManager.close()` on worker shutdown
- **Effect:** Gracefully terminates uvx subprocess
- **State reset:** Clears connection flags for clean state

---

### 2. MCP SDK Design Intent

The Model Context Protocol SDK is designed for **persistent server processes**:

1. Client spawns server subprocess (uvx → chroma-mcp → Python)
2. Server stays alive for client's lifetime
3. Client sends JSON-RPC messages over stdio
4. Server responds without reconnecting

**This is NOT like HTTP where you reconnect per request.** The persistent connection is the intended architecture.

---

### 3. Code Flow Verification

#### Worker Startup
```
WorkerService.constructor()
  → new DatabaseManager()
  → DatabaseManager.initialize()
  → this.chromaSync = new ChromaSync('claude-mem')
     [ChromaSync created, but NOT connected yet]
```

#### First Search Operation
```
SearchManager.search()
  → chromaSync.queryChroma()
  → ensureConnection()
     [First call: spawns uvx subprocess]
  → client.callTool({ name: 'chroma_query_documents', ... })
     [Send JSON-RPC message over stdin]
```

#### Subsequent Search Operations
```
SearchManager.search()
  → chromaSync.queryChroma()
  → ensureConnection()
     [this.connected === true, returns immediately]
  → client.callTool({ name: 'chroma_query_documents', ... })
     [Reuses same subprocess, sends new message]
```

#### Worker Shutdown
```
WorkerService.shutdown()
  → DatabaseManager.close()
  → chromaSync.close()
     [Terminates uvx subprocess]
```

---

### 4. Comparison: Correct vs Anti-Pattern

#### ❌ Anti-Pattern (We Don't Do This)
```typescript
async function search() {
  const sync = new ChromaSync('project'); // NEW subprocess every search
  await sync.queryChroma(...);
  await sync.close(); // KILL subprocess
}
// Result: uvx spawned and killed on EVERY search
```

#### ✅ Correct Pattern (Our Implementation)
```typescript
class DatabaseManager {
  private chromaSync = new ChromaSync('claude-mem'); // ONCE per worker

  getChromaSync() {
    return this.chromaSync; // REUSE same instance
  }
}
// Result: uvx spawned ONCE, reused for all searches
```

---

### 5. Potential Causes of Re-spawning

If users observe multiple uvx processes, possible causes:

#### A. Connection Reset on Error

**Locations:**
- `ChromaSync.ts` lines 180-186 (`ensureCollection()`)
- `ChromaSync.ts` lines 823-830 (`queryChroma()`)

**Trigger conditions:**
```typescript
const isConnectionError =
  errorMessage.includes('Not connected') ||
  errorMessage.includes('Connection closed') ||
  errorMessage.includes('MCP error -32000');

if (isConnectionError) {
  this.connected = false; // Triggers reconnection on next call
  this.client = null;
}
```

**Investigation needed:** Are these errors occurring frequently in production logs?

#### B. Worker Restarts

- Each worker process creates ONE ChromaSync instance
- If worker crashes/restarts → new ChromaSync → new uvx subprocess
- **This is expected behavior**

**Check:**
- Are multiple worker processes running simultaneously?
- Is the worker restarting frequently due to crashes?

#### C. Cleanup Failure

If `ChromaSync.close()` doesn't properly terminate the subprocess:
- Old uvx processes may accumulate
- New processes spawn on worker restart

**Check:**
- Process table for orphaned uvx processes
- Logs for "Chroma client and subprocess closed" message

---

### 6. Verification Steps

To confirm proper behavior:

#### Check Running Processes
```bash
# List all uvx/chroma-mcp processes
ps aux | grep -E "uvx|chroma-mcp"

# Should see ONE process per running worker
# Process should disappear when worker shuts down
```

#### Check Worker Logs
```bash
# Look for connection events
grep "Connecting to Chroma MCP server" worker.log
# Should appear ONCE per worker session

# Look for connection errors
grep "Connection lost" worker.log
# Should be RARE (only on actual network/process failures)

# Look for cleanup
grep "Chroma client and subprocess closed" worker.log
# Should appear on worker shutdown
```

#### Monitor Connection State
```bash
# Enable debug logging in ChromaSync.ts
logger.debug('CHROMA_SYNC', 'ensureConnection called', {
  alreadyConnected: this.connected
});

# Should see:
# - alreadyConnected: false (first call)
# - alreadyConnected: true (all subsequent calls)
```

---

## Conclusion

**The implementation is correct.** Key points:

1. ✅ Single ChromaSync instance per worker
2. ✅ Connection reuse via `ensureConnection()` guard
3. ✅ Lazy initialization (spawn on first use)
4. ✅ Graceful cleanup on shutdown
5. ✅ Follows MCP SDK design intent

**MCP clients are DESIGNED to keep servers open for reuse.** Our architecture does exactly that.

**If multiple uvx processes are observed:**
1. Check for worker restarts (expected: new worker = new subprocess)
2. Check error logs for connection failures (triggers reconnection)
3. Verify subprocess cleanup on worker shutdown

**No code changes recommended.** The architecture is sound.

---

## References

- **ChromaSync:** `src/services/sync/ChromaSync.ts`
- **DatabaseManager:** `src/services/worker/DatabaseManager.ts`
- **WorkerService:** `src/services/worker-service.ts`
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.25.1
- **Related Issue:** #590 (Windows terminal popup - different issue)
