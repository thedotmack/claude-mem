# Worker Service Rewrite Blueprint

**Date**: 2025-11-06
**File**: `src/services/worker-service.ts`
**Current State**: 1173 lines with significant technical debt
**Target**: ~600-700 lines of event-driven, connection-pooled architecture

---

## Core Principles

### 1. Event-Driven, Not Polling
- **NEVER** use `setTimeout` in a loop to check for work
- Use EventEmitter or async queues with proper notification
- Connections stay open, work is pushed not pulled
- Zero artificial delays

### 2. Keep Database Connections Open
- Connection pool pattern (or single long-lived connection)
- Pass connections as parameters, don't open/close per request
- Transactions for related operations
- Close only on shutdown

### 3. Fail Fast, Not Defensive
- If database doesn't exist, crash
- If PM2 isn't available, crash
- No "just in case" error handling
- Trust invariants established at startup

### 4. YAGNI - Delete Speculative Code
- No caching for operations that happen once
- No debouncing for problems that don't exist
- No premature optimization
- Write the obvious solution first

### 5. DRY - Extract After Second Duplication
- Not before
- Identify patterns in existing code, don't scaffold frameworks
- Shared logic = helper functions, not inheritance hierarchies

---

## What Gets Deleted

### Complete Removals (0 lines remaining)

1. **Claude Path Caching (Lines 33-70)**
   - `cachedClaudePath` module-level state
   - `findClaudePath()` wrapper function
   - Replace with direct inline logic in `runSDKAgent()`
   - Saves: 37 lines

2. **Spinner Debounce (Lines 338-365)**
   - `checkAndStopSpinner()` entire function
   - `spinnerStopTimer` class field
   - 1.5s artificial delay
   - Replace with immediate status broadcast
   - Saves: 28 lines + class field

3. **Message Polling Loop (Line 942)**
   - `await new Promise(resolve => setTimeout(resolve, MESSAGE_POLL_INTERVAL_MS))`
   - `MESSAGE_POLL_INTERVAL_MS` constant
   - Replace with EventEmitter-based notification
   - Saves: 100ms latency per observation

4. **Two-Pass SSE Cleanup (Lines 303-321)**
   - `clientsToRemove` temporary array
   - Second loop to remove clients
   - Duplicate disconnect logging
   - Replace with single-pass delete in try/catch
   - Saves: 10 lines

5. **Defensive existsSync Checks**
   - Line 382: `if (existsSync(dbPath))` before statSync
   - Any other "just in case" file checks
   - Replace with direct calls that fail fast
   - Saves: 3-5 lines scattered

6. **Verbose Chroma Error Handling**
   - Lines 728-741, 1057-1076, 1114-1133
   - Redundant `.then(() => logger.success(...))` calls
   - Verbose `.catch()` with comments
   - Replace with silent swallow or minimal logging
   - Saves: 40 lines

### Partial Removals (simplifications)

7. **Database Reopening Pattern**
   - Remove all `new SessionStore()` calls except initialization
   - Remove all `db.close()` calls except shutdown
   - Keep single connection pool or long-lived connection
   - Reduces open/close cycles from 100+ to 1 per worker lifetime

8. **Duplicate Pagination Logic**
   - Extract `handleGetObservations`, `handleGetSummaries`, `handleGetPrompts` into single helper
   - Keep only endpoint-specific logic (table names, columns)
   - Saves: 60-80 lines

9. **isProcessing Flag**
   - Derive from `sessions.size > 0` or `sessions.values().some(s => s.pendingMessages.length > 0)`
   - Remove class field
   - Saves: 1 field + related logic

---

## What Gets Replaced

### 1. Database Access Pattern

**Before**: Open/close on every request
```typescript
private getOrCreateSession(sessionDbId: number): ActiveSession {
  const db = new SessionStore();  // Open
  const dbSession = db.getSessionById(sessionDbId);
  db.close();  // Close
  // ...
}

private handleInit(req: Request, res: Response): void {
  const session = this.getOrCreateSession(sessionDbId);  // Open/close #1
  const db = new SessionStore();  // Open #2
  db.setWorkerPort(sessionDbId, port);
  db.close();  // Close #2
}
```

**After**: Connection pool + pass connections
```typescript
class WorkerService {
  private db: SessionStore;  // Long-lived connection

  async start(): Promise<void> {
    this.db = new SessionStore();  // Open once
    // ...
  }

  private getOrCreateSession(sessionDbId: number): ActiveSession {
    // Use this.db, no open/close
    const dbSession = this.db.getSessionById(sessionDbId);
    // ...
  }

  private handleInit(req: Request, res: Response): void {
    const session = this.getOrCreateSession(sessionDbId);
    this.db.setWorkerPort(sessionDbId, port);  // Reuse connection
    // No close
  }

  async shutdown(): Promise<void> {
    this.db.close();  // Close once
  }
}
```

### 2. Message Queue Pattern

**Before**: Polling loop
```typescript
private async* createMessageGenerator(session: ActiveSession): AsyncIterable<SDKUserMessage> {
  yield initPrompt;

  while (true) {
    if (session.pendingMessages.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));  // Poll
      continue;
    }

    while (session.pendingMessages.length > 0) {
      const message = session.pendingMessages.shift()!;
      yield processMessage(message);
    }
  }
}
```

**After**: Event-driven notification
```typescript
class WorkerService {
  private sessionQueues: Map<number, EventEmitter> = new Map();

  private handleObservation(req: Request, res: Response): void {
    // ... existing logic ...
    session.pendingMessages.push(message);

    // Notify generator immediately
    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    res.json({ status: 'queued' });
  }

  private async* createMessageGenerator(session: ActiveSession): AsyncIterable<SDKUserMessage> {
    const emitter = new EventEmitter();
    this.sessionQueues.set(session.sessionDbId, emitter);

    yield initPrompt;

    while (!session.abortController.signal.aborted) {
      if (session.pendingMessages.length === 0) {
        // Wait for notification, not poll
        await new Promise(resolve => emitter.once('message', resolve));
      }

      while (session.pendingMessages.length > 0) {
        const message = session.pendingMessages.shift()!;
        yield processMessage(message);
      }
    }

    this.sessionQueues.delete(session.sessionDbId);
  }
}
```

### 3. Spinner Status Updates

**Before**: 1.5s debounce
```typescript
private checkAndStopSpinner(): void {
  if (this.spinnerStopTimer) {
    clearTimeout(this.spinnerStopTimer);
  }

  const hasPending = Array.from(this.sessions.values()).some(
    s => s.pendingMessages.length > 0
  );

  if (!hasPending) {
    this.spinnerStopTimer = setTimeout(() => {
      // Check again after 1.5s
      const stillEmpty = Array.from(this.sessions.values()).every(
        s => s.pendingMessages.length === 0
      );
      if (stillEmpty) {
        this.broadcastProcessingStatus(false);
      }
    }, 1500);
  }
}
```

**After**: Immediate status update
```typescript
private updateProcessingStatus(): void {
  const hasPending = Array.from(this.sessions.values()).some(
    s => s.pendingMessages.length > 0
  );

  this.broadcastProcessingStatus(hasPending);
}
```

### 4. SSE Broadcast Cleanup

**Before**: Two-pass cleanup
```typescript
private broadcastSSE(event: any): void {
  const clientsToRemove: Response[] = [];

  for (const client of this.sseClients) {
    try {
      client.write(data);
    } catch {
      clientsToRemove.push(client);
    }
  }

  for (const client of clientsToRemove) {
    this.sseClients.delete(client);
  }
}
```

**After**: Single-pass delete
```typescript
private broadcastSSE(event: any): void {
  if (this.sseClients.size === 0) return;

  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of this.sseClients) {
    try {
      client.write(data);
    } catch {
      this.sseClients.delete(client);  // Delete immediately
    }
  }
}
```

### 5. Pagination Logic

**Before**: Copy-paste across 3 endpoints
```typescript
private handleGetObservations(req: Request, res: Response): void {
  const offset = parseInt(req.query.offset as string || '0', 10);
  const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
  const project = req.query.project as string | undefined;

  const db = new SessionStore();

  let query = 'SELECT ... FROM observations';
  let countQuery = 'SELECT COUNT(*) FROM observations';
  const params: any[] = [];
  const countParams: any[] = [];

  if (project) {
    query += ' WHERE project = ?';
    countQuery += ' WHERE project = ?';
    params.push(project);
    countParams.push(project);
  }

  query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = db.db.prepare(query);
  const observations = stmt.all(...params);

  const countStmt = db.db.prepare(countQuery);
  const { total } = countStmt.get(...countParams) as { total: number };
  const hasMore = (offset + limit) < total;

  db.close();

  res.json({ observations, hasMore, total, offset, limit });
}

// Identical pattern in handleGetSummaries and handleGetPrompts
```

**After**: Extract helper function
```typescript
private paginate<T>(
  table: string,
  columns: string,
  project: string | undefined,
  offset: number,
  limit: number
): { items: T[]; hasMore: boolean; total: number } {
  let query = `SELECT ${columns} FROM ${table}`;
  const params: any[] = [];

  if (project) {
    query += ' WHERE project = ?';
    params.push(project);
  }

  query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset);  // Fetch one extra to check hasMore

  const stmt = this.db.db.prepare(query);
  const results = stmt.all(...params) as T[];

  const items = results.slice(0, limit);
  const hasMore = results.length > limit;

  // Optional: Only compute total if needed
  // const total = this.db.db.prepare(`SELECT COUNT(*) as count FROM ${table}...`).get().count;

  return { items, hasMore, total: -1 };  // Or compute total if UI needs it
}

private handleGetObservations(req: Request, res: Response): void {
  const offset = parseInt(req.query.offset as string || '0', 10);
  const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
  const project = req.query.project as string | undefined;

  const { items, hasMore } = this.paginate<Observation>(
    'observations',
    'id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch',
    project,
    offset,
    limit
  );

  res.json({ observations: items, hasMore, offset, limit });
}
```

### 6. Claude Path Resolution

**Before**: 37 lines with caching
```typescript
let cachedClaudePath: string | null = null;

function findClaudePath(): string {
  if (cachedClaudePath) {
    return cachedClaudePath;
  }

  // Check environment variable
  if (process.env.CLAUDE_CODE_PATH) {
    cachedClaudePath = process.env.CLAUDE_CODE_PATH;
    return cachedClaudePath;
  }

  // Find in PATH
  try {
    const command = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(command, { encoding: 'utf8' });
    const paths = result.trim().split('\n');
    const claudePath = paths[0].trim();

    if (!claudePath) {
      throw new Error('Claude executable not found');
    }

    cachedClaudePath = claudePath;
    return cachedClaudePath;
  } catch {
    throw new Error('Failed to find Claude executable');
  }
}
```

**After**: Inline in runSDKAgent (called once per session)
```typescript
private async runSDKAgent(session: ActiveSession): Promise<void> {
  const claudePath = process.env.CLAUDE_CODE_PATH ||
    execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { encoding: 'utf8' })
      .trim().split('\n')[0].trim();

  if (!claudePath) {
    throw new Error('Claude executable not found in PATH');
  }

  // ... rest of runSDKAgent ...
}
```

### 7. Chroma Sync Error Handling

**Before**: Verbose logging
```typescript
this.chromaSync.syncObservation(...)
  .then(() => {
    logger.success('WORKER', 'Observation synced to Chroma', { obsId: id });
  })
  .catch((error: Error) => {
    logger.error('WORKER', 'Observation sync failed - continuing', { obsId: id }, error);
    // Don't crash - SQLite has the data
  });
```

**After**: Silent or minimal
```typescript
// Fire-and-forget (SQLite is source of truth)
this.chromaSync.syncObservation(...).catch(() => {});

// Or minimal logging at debug level
this.chromaSync.syncObservation(...).catch(err =>
  logger.debug('WORKER', 'Chroma sync failed', {}, err)
);
```

---

## New Architecture

### Class Structure

```typescript
class WorkerService {
  // Core services
  private app: express.Application;
  private db: SessionStore;  // Long-lived connection
  private chromaSync: ChromaSync;

  // Session management
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();

  // SSE clients
  private sseClients: Set<Response> = new Set();

  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  async start(): Promise<void> {
    // Initialize database (once)
    this.db = new SessionStore();

    // Initialize ChromaSync
    this.chromaSync = new ChromaSync('claude-mem');

    // Cleanup orphaned sessions
    const cleaned = this.db.cleanupOrphanedSessions();
    if (cleaned > 0) {
      logger.info('SYSTEM', `Cleaned ${cleaned} orphaned sessions`);
    }

    // Start HTTP server
    const port = getWorkerPort();
    await new Promise<void>((resolve, reject) => {
      this.app.listen(port, resolve).on('error', reject);
    });

    logger.info('SYSTEM', 'Worker started', { port, pid: process.pid });

    // Start Chroma backfill (fire-and-forget)
    this.chromaSync.ensureBackfilled().catch(() => {});
  }

  async shutdown(): Promise<void> {
    // Abort all active sessions
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }

    // Wait for generators to finish
    await Promise.all(
      Array.from(this.sessions.values())
        .map(s => s.generatorPromise)
        .filter(Boolean)
    );

    // Close database
    this.db.close();

    logger.info('SYSTEM', 'Worker shutdown complete');
  }
}
```

### ActiveSession Interface

```typescript
interface ActiveSession {
  sessionDbId: number;
  claudeSessionId: string;
  sdkSessionId: string | null;
  project: string;
  userPrompt: string;
  pendingMessages: PendingMessage[];
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number;
  startTime: number;
}

interface PendingMessage {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: any;
  tool_output?: any;
  prompt_number?: number;
}
```

---

## Initialization Flow

```
1. Constructor
   └─ new express()
   └─ setupMiddleware()
   └─ setupRoutes()

2. start()
   ├─ new SessionStore() → this.db (STAYS OPEN)
   ├─ new ChromaSync()
   ├─ db.cleanupOrphanedSessions()
   ├─ app.listen(port)
   └─ chromaSync.ensureBackfilled() (async, fire-and-forget)

3. Ready to accept requests
   └─ Database connection: OPEN
   └─ HTTP server: LISTENING
   └─ ChromaSync: INITIALIZED
```

**Key Changes**:
- Database opened ONCE, stays open for worker lifetime
- No version checks, no npm install logic (move to separate install script)
- ChromaSync backfill doesn't block startup
- Clean startup path: construct → start → ready

---

## Request Flow

### POST /sessions/:sessionDbId/init

```
1. Parse sessionDbId from URL params
2. Get or create session:
   ├─ Check this.sessions.get(sessionDbId)
   ├─ If exists: return existing
   └─ If not exists:
      ├─ Fetch session from this.db (connection already open)
      ├─ Create ActiveSession object
      ├─ Create EventEmitter for queue
      ├─ this.sessions.set(sessionDbId, session)
      ├─ this.sessionQueues.set(sessionDbId, emitter)
      └─ Start runSDKAgent(session) in background

3. Update session in database:
   ├─ this.db.setWorkerPort(sessionDbId, port)
   ├─ Fetch latest user prompt (already have connection)
   └─ NO CLOSE - connection stays open

4. Broadcast SSE event (new session started)

5. Fire-and-forget Chroma sync:
   └─ chromaSync.syncUserPrompt(...).catch(() => {})

6. Return response:
   └─ { status: 'initialized', sessionDbId, port }
```

**Performance**:
- Database: 0 open/close cycles (connection already open)
- Latency: ~1-2ms (just a SELECT and UPDATE)

### POST /sessions/:sessionDbId/observations

```
1. Parse sessionDbId and observation data
2. Get session (from this.sessions, NO database access)
3. Push message to session.pendingMessages queue
4. Notify generator immediately:
   └─ sessionQueues.get(sessionDbId)?.emit('message')
5. Return response:
   └─ { status: 'queued', queueLength: session.pendingMessages.length }
```

**Performance**:
- Database: 0 accesses (session already in memory)
- Latency: <1ms (just queue push + emit)
- Generator latency: 0ms (wakes up immediately on emit, not 0-100ms poll)

### SDK Agent Processing (runSDKAgent)

```
1. Create EventEmitter for this session's queue
2. Create async generator (createMessageGenerator):
   ├─ Yield init prompt
   └─ Loop:
      ├─ If queue empty: await emitter.once('message')
      ├─ If queue has messages: process all
      └─ Yield SDK messages

3. Run Agent SDK with generator:
   └─ For each response from SDK:
      ├─ Parse observations/summary
      ├─ Store in database (this.db, connection open)
      ├─ Broadcast SSE events
      ├─ Fire-and-forget Chroma sync
      └─ Update processing status (immediate, no debounce)

4. On completion or error:
   ├─ Mark session complete in database
   ├─ Delete from this.sessions
   ├─ Delete from this.sessionQueues
   └─ Broadcast final status
```

**Performance**:
- Message latency: 0ms (event-driven, not polled)
- Database overhead: 1 connection for entire session
- Spinner updates: Immediate (no 1.5s delay)

---

## Session Lifecycle

```
[Client] POST /init
   ↓
[Worker] Create ActiveSession
   ├─ Fetch from database (this.db)
   ├─ Store in this.sessions
   ├─ Create EventEmitter in this.sessionQueues
   └─ Start runSDKAgent() background task
   ↓
[Worker] runSDKAgent spawns claude subprocess
   ├─ Creates message generator
   └─ Generator waits for events (not polling)
   ↓
[Client] POST /observations (multiple times)
   ├─ Push to session.pendingMessages
   └─ Emit 'message' event → generator wakes immediately
   ↓
[SDK Agent] Processes observations
   ├─ Stores in database (this.db)
   ├─ Syncs to Chroma (async)
   └─ Broadcasts SSE events
   ↓
[Client] POST /summarize
   ├─ Push to session.pendingMessages
   └─ Emit 'message' event
   ↓
[SDK Agent] Generates summary
   ├─ Stores in database
   ├─ Syncs to Chroma
   └─ Broadcasts SSE event
   ↓
[SDK Agent] Session ends
   ├─ Mark complete in database
   ├─ Delete from this.sessions
   └─ Delete from this.sessionQueues

[Cleanup Hook] DELETE /sessions/:id
   ├─ Abort session (abortController.abort())
   ├─ Wait for generator to finish
   └─ Return success
```

**Key Points**:
- Database connection: Open for entire worker lifetime
- EventEmitter: Created per session, deleted on completion
- No polling loops anywhere
- No artificial delays
- Generator responds to events in real-time

---

## Event System Design

### EventEmitter Per Session

```typescript
class WorkerService {
  private sessionQueues: Map<number, EventEmitter> = new Map();

  private getOrCreateSession(sessionDbId: number): ActiveSession {
    let session = this.sessions.get(sessionDbId);
    if (session) return session;

    // Fetch from database
    const dbSession = this.db.getSessionById(sessionDbId);
    if (!dbSession) {
      throw new Error(`Session ${sessionDbId} not found`);
    }

    // Create session object
    session = {
      sessionDbId,
      claudeSessionId: dbSession.claude_session_id,
      sdkSessionId: null,
      project: dbSession.project,
      userPrompt: dbSession.user_prompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 0,
      startTime: Date.now()
    };

    this.sessions.set(sessionDbId, session);

    // Create EventEmitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    // Start background processing
    session.generatorPromise = this.runSDKAgent(session).catch(err => {
      logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
      this.db.markSessionFailed(sessionDbId);
      this.sessions.delete(sessionDbId);
      this.sessionQueues.delete(sessionDbId);
    });

    return session;
  }

  private handleObservation(req: Request, res: Response): void {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);
    const { tool_name, tool_input, tool_output, prompt_number } = req.body;

    const session = this.getOrCreateSession(sessionDbId);

    session.pendingMessages.push({
      type: 'observation',
      tool_name,
      tool_input,
      tool_output,
      prompt_number
    });

    // Notify generator immediately (no polling delay)
    const emitter = this.sessionQueues.get(sessionDbId);
    if (emitter) {
      emitter.emit('message');
    }

    res.json({ status: 'queued', queueLength: session.pendingMessages.length });
  }

  private async* createMessageGenerator(session: ActiveSession): AsyncIterable<SDKUserMessage> {
    // Get the EventEmitter for this session
    const emitter = this.sessionQueues.get(session.sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter found for session ${session.sessionDbId}`);
    }

    // Yield initial prompt
    yield {
      role: 'user',
      content: session.userPrompt
    };

    // Process messages as they arrive (event-driven)
    while (!session.abortController.signal.aborted) {
      // If queue is empty, wait for notification
      if (session.pendingMessages.length === 0) {
        await new Promise<void>(resolve => {
          const handler = () => resolve();
          emitter.once('message', handler);

          // Also listen for abort signal
          session.abortController.signal.addEventListener('abort', () => {
            emitter.off('message', handler);
            resolve();
          }, { once: true });
        });
      }

      // Process all pending messages
      while (session.pendingMessages.length > 0) {
        const message = session.pendingMessages.shift()!;

        if (message.type === 'observation') {
          yield {
            role: 'user',
            content: `<observation>
<tool_name>${message.tool_name}</tool_name>
<tool_input>${JSON.stringify(message.tool_input)}</tool_input>
<tool_output>${message.tool_output}</tool_output>
</observation>
Please analyze this tool execution and extract observations.`
          };
        } else if (message.type === 'summarize') {
          yield {
            role: 'user',
            content: `Please summarize this session.`
          };
        }
      }
    }
  }
}
```

### Benefits

1. **Zero Polling Delay**: Generator wakes up immediately when work arrives
2. **Clean Separation**: Each session has its own event channel
3. **Abort Handling**: EventEmitter can be aborted cleanly
4. **No Timers**: No `setTimeout`, no `setInterval`, no `MESSAGE_POLL_INTERVAL_MS`
5. **Responsive**: User sees processing start instantly, not after 0-100ms poll delay

### Alternative: Async Queue

If EventEmitter feels too imperative, consider an async queue library:

```typescript
import { Queue } from 'async-queue';  // Or similar library

class WorkerService {
  private sessionQueues: Map<number, Queue<PendingMessage>> = new Map();

  private handleObservation(req: Request, res: Response): void {
    const queue = this.sessionQueues.get(sessionDbId);
    queue.enqueue(message);  // Automatically notifies consumers
    res.json({ status: 'queued' });
  }

  private async* createMessageGenerator(session: ActiveSession): AsyncIterable<SDKUserMessage> {
    const queue = this.sessionQueues.get(session.sessionDbId);

    yield initPrompt;

    while (!session.abortController.signal.aborted) {
      const message = await queue.dequeue();  // Blocks until work available
      yield processMessage(message);
    }
  }
}
```

Choose whichever pattern is clearest for the use case. **The key principle is: events, not polling.**

---

## Helper Functions to Extract

### 1. Pagination Helper

```typescript
private paginate<T>(
  table: string,
  columns: string,
  project: string | undefined,
  offset: number,
  limit: number
): { items: T[]; hasMore: boolean } {
  let query = `SELECT ${columns} FROM ${table}`;
  const params: any[] = [];

  if (project) {
    query += ' WHERE project = ?';
    params.push(project);
  }

  query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset);  // Fetch one extra

  const stmt = this.db.db.prepare(query);
  const results = stmt.all(...params) as T[];

  return {
    items: results.slice(0, limit),
    hasMore: results.length > limit
  };
}
```

### 2. SSE Event Builder

```typescript
private createSSEEvent(type: string, data: any): string {
  return `data: ${JSON.stringify({ type, ...data, timestamp: Date.now() })}\n\n`;
}
```

### 3. Request Parsing

```typescript
private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string } {
  return {
    offset: parseInt(req.query.offset as string || '0', 10),
    limit: Math.min(parseInt(req.query.limit as string || '50', 10), 100),
    project: req.query.project as string | undefined
  };
}
```

---

## Estimated Line Count

### Current: 1173 lines

**Deletions**:
- Claude path caching: -37 lines
- Spinner debounce: -28 lines
- Two-pass SSE cleanup: -10 lines
- Verbose Chroma error handling: -40 lines
- Defensive checks: -5 lines
- **Subtotal deletions**: -120 lines

**Simplifications** (replace verbose with simple):
- Duplicate pagination logic: -80 lines (3 endpoints → 1 helper)
- Database reopening pattern: -50 lines (remove redundant open/close)
- **Subtotal simplifications**: -130 lines

**Additions** (new patterns):
- EventEmitter setup: +20 lines
- Connection pool management: +10 lines
- Helper functions: +30 lines
- **Subtotal additions**: +60 lines

### Target: ~983 lines (1173 - 120 - 130 + 60)

**Realistically**: ~600-700 lines after aggressive cleanup and extraction of helpers.

---

## Testing Strategy

### Before Rewrite
1. Document current behavior with integration tests
2. Capture expected HTTP responses for all endpoints
3. Measure baseline performance (latency, throughput)

### During Rewrite
1. Rewrite in isolated branch
2. Run integration tests after each major change
3. Ensure HTTP contract remains identical

### After Rewrite
1. Performance comparison:
   - Measure latency per observation (should drop from 50-100ms to <5ms)
   - Measure spinner delay (should drop from 1.5s to 0ms)
   - Measure database overhead (should drop 90%+)
2. Load testing: 100 concurrent sessions, 1000 observations
3. Memory profiling: Ensure no EventEmitter leaks

---

## Migration Checklist

- [ ] Extract current integration tests
- [ ] Create new branch: `rewrite/worker-service`
- [ ] Rewrite constructor and initialization
- [ ] Replace database pattern (connection pool)
- [ ] Replace polling with EventEmitter
- [ ] Remove spinner debounce
- [ ] Simplify SSE broadcast
- [ ] Extract pagination helper
- [ ] Simplify Chroma error handling
- [ ] Remove Claude path caching
- [ ] Add shutdown handler
- [ ] Run integration tests
- [ ] Performance benchmarks
- [ ] Code review
- [ ] Merge to main

---

## Success Metrics

### Performance
- **Observation latency**: <5ms (down from 50-100ms)
- **Spinner delay**: 0ms (down from 1500ms)
- **Database open/close cycles**: 1 per worker lifetime (down from 100+ per session)

### Code Quality
- **Total lines**: <700 (down from 1173)
- **Artificial delays**: 0 (down from 2)
- **Polling loops**: 0 (down from 1)
- **Cyclomatic complexity**: <15 per function

### Maintainability
- **DRY**: No copy-paste pagination logic
- **Fail Fast**: No defensive programming for ghosts
- **YAGNI**: No premature optimization or speculative features
- **Event-Driven**: All async work uses proper notification patterns

---

## Appendix: Key Insights from Overhead Analysis

### The Three Deadly Sins

1. **Polling Instead of Events** (Line 942)
   - Adds 0-100ms latency to every observation
   - Wakes CPU every 100ms even when idle
   - Prevents laptop deep sleep → drains battery

2. **Artificial Debouncing** (Lines 338-365)
   - Adds 1.5s delay before spinner stops
   - Solves a problem that doesn't exist (UI flickering)
   - Makes the entire system feel slower

3. **Database Reopening** (Multiple locations)
   - Opens/closes database 4-100+ times per session
   - Adds 1-5ms overhead per cycle
   - Total overhead: 20-500ms per session of pure waste

### Why These Patterns Appeared

- **Training Bias**: "Professional" code often looks more complex
- **Risk Aversion**: "What if X fails?" even when X can't fail
- **Pattern Matching**: Seeing a problem and scaffolding a framework
- **No Real-World Pain**: Not debugging at 2am = not feeling cost of complexity

### The Fix

- Write the obvious solution first
- Add complexity only when you hit the actual problem
- Delete aggressively
- Trust invariants
- Fail fast
