# Worker Service Architecture: Object-Oriented Design

**Date**: 2025-11-06
**Purpose**: Clean, DRY class structure for worker-service.ts rewrite
**Target**: ~600-700 lines (down from 1173)

---

## Core Principles

1. **Single Responsibility Principle**: Each class does ONE thing
2. **DRY**: Extract repeated patterns into reusable components
3. **KISS**: Simple, obvious implementations
4. **YAGNI**: Only build what's needed now
5. **Composition over Inheritance**: Use dependency injection
6. **Fail Fast**: No defensive programming for problems that can't occur

---

## Class Hierarchy

```
WorkerService (orchestration, HTTP routing)
├─ DatabaseManager (single long-lived connection)
├─ SessionManager (session lifecycle, event-driven queue)
├─ SSEBroadcaster (SSE client management)
├─ SDKAgent (SDK query loop handling)
├─ PaginationHelper (DRY utility for paginated queries)
└─ SettingsManager (DRY utility for settings CRUD)
```

---

## 1. WorkerService (Orchestration)

### Responsibility
HTTP server setup, route handlers, dependency orchestration. NO business logic.

### Public Interface
```typescript
class WorkerService {
  constructor();
  async start(): Promise<void>;
  async shutdown(): Promise<void>;
}
```

### Dependencies
```typescript
class WorkerService {
  private app: express.Application;
  private server: http.Server | null = null;

  // Composed services
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;
}
```

### Implementation Pattern

```typescript
class WorkerService {
  constructor() {
    this.app = express();

    // Initialize services (dependency injection)
    this.dbManager = new DatabaseManager();
    this.sessionManager = new SessionManager(this.dbManager);
    this.sseBroadcaster = new SSEBroadcaster();
    this.sdkAgent = new SDKAgent(this.dbManager, this.sessionManager);
    this.paginationHelper = new PaginationHelper(this.dbManager);
    this.settingsManager = new SettingsManager(this.dbManager);

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(cors());
  }

  private setupRoutes(): void {
    // Health & Viewer
    this.app.get('/health', this.handleHealth.bind(this));
    this.app.get('/', this.handleViewerUI.bind(this));
    this.app.get('/stream', this.handleSSEStream.bind(this));

    // Session endpoints
    this.app.post('/sessions/:sessionDbId/init', this.handleSessionInit.bind(this));
    this.app.post('/sessions/:sessionDbId/observations', this.handleObservations.bind(this));
    this.app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    this.app.get('/sessions/:sessionDbId/status', this.handleSessionStatus.bind(this));
    this.app.delete('/sessions/:sessionDbId', this.handleSessionDelete.bind(this));

    // Data retrieval
    this.app.get('/api/observations', this.handleGetObservations.bind(this));
    this.app.get('/api/summaries', this.handleGetSummaries.bind(this));
    this.app.get('/api/prompts', this.handleGetPrompts.bind(this));
    this.app.get('/api/stats', this.handleGetStats.bind(this));

    // Settings
    this.app.get('/api/settings', this.handleGetSettings.bind(this));
    this.app.post('/api/settings', this.handleUpdateSettings.bind(this));
  }

  async start(): Promise<void> {
    // Initialize database (once, stays open)
    await this.dbManager.initialize();

    // Cleanup orphaned sessions from previous runs
    const cleaned = this.dbManager.cleanupOrphanedSessions();
    if (cleaned > 0) {
      logger.info('SYSTEM', `Cleaned ${cleaned} orphaned sessions`);
    }

    // Start HTTP server
    const port = getWorkerPort();
    this.server = await new Promise<http.Server>((resolve, reject) => {
      const srv = this.app.listen(port, () => resolve(srv));
      srv.on('error', reject);
    });

    logger.info('SYSTEM', 'Worker started', { port, pid: process.pid });
  }

  async shutdown(): Promise<void> {
    // Shutdown all active sessions
    await this.sessionManager.shutdownAll();

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => err ? reject(err) : resolve());
      });
    }

    // Close database connection
    await this.dbManager.close();

    logger.info('SYSTEM', 'Worker shutdown complete');
  }

  // Route handlers - thin wrappers that delegate to services
  private handleSessionInit(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const session = this.sessionManager.initializeSession(sessionDbId);

      // Start SDK agent in background
      this.sdkAgent.startSession(session).catch(err => {
        logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
      });

      // Broadcast SSE event
      this.sseBroadcaster.broadcast({
        type: 'session_started',
        sessionDbId,
        project: session.project
      });

      res.json({ status: 'initialized', sessionDbId, port: getWorkerPort() });
    } catch (error) {
      logger.failure('HTTP', 'Session init failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  private handleObservations(req: Request, res: Response): void {
    try {
      const sessionDbId = parseInt(req.params.sessionDbId, 10);
      const { tool_name, tool_input, tool_output, prompt_number } = req.body;

      this.sessionManager.queueObservation(sessionDbId, {
        tool_name,
        tool_input,
        tool_output,
        prompt_number
      });

      res.json({ status: 'queued' });
    } catch (error) {
      logger.failure('HTTP', 'Observation queuing failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  private handleGetObservations(req: Request, res: Response): void {
    try {
      const { offset, limit, project } = parsePaginationParams(req);
      const result = this.paginationHelper.getObservations(offset, limit, project);
      res.json(result);
    } catch (error) {
      logger.failure('HTTP', 'Get observations failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  private handleGetSettings(req: Request, res: Response): void {
    try {
      const settings = this.settingsManager.getSettings();
      res.json(settings);
    } catch (error) {
      logger.failure('HTTP', 'Get settings failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  // ... other route handlers follow same pattern
}
```

### Key Points
- **Thin controllers**: Route handlers are 5-10 lines each
- **Delegation**: All business logic delegated to services
- **Error handling**: Centralized try/catch with consistent logging
- **No database access**: WorkerService never touches SessionStore directly

---

## 2. DatabaseManager (Single Connection)

### Responsibility
Manage single long-lived database connection. Provide centralized access to SessionStore and SessionSearch.

### Public Interface
```typescript
class DatabaseManager {
  async initialize(): Promise<void>;
  async close(): Promise<void>;

  // Direct access to stores
  getSessionStore(): SessionStore;
  getSessionSearch(): SessionSearch;

  // High-level operations
  cleanupOrphanedSessions(): number;
  getSessionById(sessionDbId: number): DBSession;
  createSession(data: Partial<DBSession>): number;
  updateSession(sessionDbId: number, updates: Partial<DBSession>): void;
  markSessionComplete(sessionDbId: number): void;

  // ChromaSync integration
  getChromaSync(): ChromaSync;
}
```

### Dependencies
```typescript
class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
}
```

### Implementation Pattern

```typescript
class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;

  async initialize(): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore();
    this.sessionSearch = new SessionSearch();

    // Initialize ChromaSync
    this.chromaSync = new ChromaSync('claude-mem');

    // Start background backfill (fire-and-forget)
    this.chromaSync.ensureBackfilled().catch(() => {});

    logger.info('DB', 'Database initialized');
  }

  async close(): Promise<void> {
    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed');
  }

  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  getChromaSync(): ChromaSync {
    if (!this.chromaSync) {
      throw new Error('ChromaSync not initialized');
    }
    return this.chromaSync;
  }

  cleanupOrphanedSessions(): number {
    return this.getSessionStore().cleanupOrphanedSessions();
  }

  getSessionById(sessionDbId: number): DBSession {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

  createSession(data: Partial<DBSession>): number {
    return this.getSessionStore().createSession(data);
  }

  updateSession(sessionDbId: number, updates: Partial<DBSession>): void {
    this.getSessionStore().updateSession(sessionDbId, updates);
  }

  markSessionComplete(sessionDbId: number): void {
    this.getSessionStore().markSessionComplete(sessionDbId);
  }
}
```

### Key Points
- **Single source of truth**: One connection for entire worker lifetime
- **Fail fast**: Throw if accessed before initialization
- **Encapsulation**: Services use DatabaseManager, not SessionStore directly
- **No open/close churn**: Eliminates 100+ open/close cycles per session

---

## 3. SessionManager (Event-Driven Queue)

### Responsibility
Manage active session lifecycle. Handle event-driven message queues. Coordinate between HTTP requests and SDK agent.

### Public Interface
```typescript
class SessionManager {
  constructor(dbManager: DatabaseManager);

  // Session lifecycle
  initializeSession(sessionDbId: number): ActiveSession;
  getSession(sessionDbId: number): ActiveSession | undefined;
  queueObservation(sessionDbId: number, data: ObservationData): void;
  queueSummarize(sessionDbId: number): void;
  deleteSession(sessionDbId: number): Promise<void>;

  // Bulk operations
  async shutdownAll(): Promise<void>;

  // Queue access (for SDKAgent)
  getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessage>;
}
```

### Dependencies
```typescript
class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
}
```

### Implementation Pattern

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

class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  initializeSession(sessionDbId: number): ActiveSession {
    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      return session;
    }

    // Fetch from database
    const dbSession = this.dbManager.getSessionById(sessionDbId);

    // Create active session
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

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    logger.info('SESSION', 'Session initialized', { sessionDbId, project: session.project });

    return session;
  }

  getSession(sessionDbId: number): ActiveSession | undefined {
    return this.sessions.get(sessionDbId);
  }

  queueObservation(sessionDbId: number, data: ObservationData): void {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not active`);
    }

    session.pendingMessages.push({
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_output: data.tool_output,
      prompt_number: data.prompt_number
    });

    // Notify generator immediately (zero latency)
    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    logger.debug('SESSION', 'Observation queued', {
      sessionDbId,
      queueLength: session.pendingMessages.length
    });
  }

  queueSummarize(sessionDbId: number): void {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not active`);
    }

    session.pendingMessages.push({ type: 'summarize' });

    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    logger.debug('SESSION', 'Summarize queued', { sessionDbId });
  }

  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      return; // Already deleted
    }

    // Abort the SDK agent
    session.abortController.abort();

    // Wait for generator to finish
    if (session.generatorPromise) {
      await session.generatorPromise.catch(() => {});
    }

    // Cleanup
    this.sessions.delete(sessionDbId);
    this.sessionQueues.delete(sessionDbId);

    logger.info('SESSION', 'Session deleted', { sessionDbId });
  }

  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
  }

  // Generator for SDKAgent to consume
  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessage> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not active`);
    }

    const emitter = this.sessionQueues.get(sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    while (!session.abortController.signal.aborted) {
      // Wait for messages if queue is empty
      if (session.pendingMessages.length === 0) {
        await new Promise<void>(resolve => {
          const handler = () => resolve();
          emitter.once('message', handler);

          // Also listen for abort
          session.abortController.signal.addEventListener('abort', () => {
            emitter.off('message', handler);
            resolve();
          }, { once: true });
        });
      }

      // Yield all pending messages
      while (session.pendingMessages.length > 0) {
        const message = session.pendingMessages.shift()!;
        yield message;
      }
    }
  }
}
```

### Key Points
- **Event-driven**: Zero polling, immediate notification via EventEmitter
- **Single responsibility**: Only manages session state and queues
- **Clean separation**: Database access delegated to DatabaseManager
- **Fail fast**: Throws if session doesn't exist (caller handles gracefully)

---

## 4. SSEBroadcaster (SSE Client Management)

### Responsibility
Manage SSE client connections. Broadcast events to all connected clients. Handle disconnections gracefully.

### Public Interface
```typescript
class SSEBroadcaster {
  addClient(res: Response): void;
  removeClient(res: Response): void;
  broadcast(event: SSEEvent): void;
  getClientCount(): number;
}
```

### Dependencies
```typescript
class SSEBroadcaster {
  private sseClients: Set<Response> = new Set();
}
```

### Implementation Pattern

```typescript
interface SSEEvent {
  type: string;
  [key: string]: any;
}

class SSEBroadcaster {
  private sseClients: Set<Response> = new Set();

  addClient(res: Response): void {
    this.sseClients.add(res);
    logger.debug('SSE', 'Client connected', { total: this.sseClients.size });

    // Setup cleanup on disconnect
    res.on('close', () => {
      this.removeClient(res);
    });

    // Send initial event
    this.sendToClient(res, { type: 'connected', timestamp: Date.now() });
  }

  removeClient(res: Response): void {
    this.sseClients.delete(res);
    logger.debug('SSE', 'Client disconnected', { total: this.sseClients.size });
  }

  broadcast(event: SSEEvent): void {
    if (this.sseClients.size === 0) {
      return; // Short-circuit if no clients
    }

    const eventWithTimestamp = { ...event, timestamp: Date.now() };
    const data = `data: ${JSON.stringify(eventWithTimestamp)}\n\n`;

    // Single-pass write + cleanup
    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch (err) {
        // Remove failed client immediately
        this.sseClients.delete(client);
        logger.debug('SSE', 'Client removed due to write error');
      }
    }
  }

  getClientCount(): number {
    return this.sseClients.size;
  }

  private sendToClient(res: Response, event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    try {
      res.write(data);
    } catch (err) {
      this.sseClients.delete(res);
    }
  }
}
```

### Key Points
- **Simple**: Single-pass broadcast, no two-step cleanup
- **Fail gracefully**: Remove dead clients on write errors
- **Zero polling**: Event-driven notifications
- **Encapsulated**: WorkerService never touches SSE internals

---

## 5. SDKAgent (SDK Query Loop)

### Responsibility
Spawn Claude subprocess. Run Agent SDK query loop. Process SDK responses (observations, summaries). Sync to database and Chroma.

### Public Interface
```typescript
class SDKAgent {
  constructor(dbManager: DatabaseManager, sessionManager: SessionManager);
  async startSession(session: ActiveSession): Promise<void>;
}
```

### Dependencies
```typescript
class SDKAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
}
```

### Implementation Pattern

```typescript
class SDKAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession): Promise<void> {
    try {
      // Find Claude executable (inline, called once per session)
      const claudePath = process.env.CLAUDE_CODE_PATH ||
        execSync(process.platform === 'win32' ? 'where claude' : 'which claude', { encoding: 'utf8' })
          .trim().split('\n')[0].trim();

      if (!claudePath) {
        throw new Error('Claude executable not found in PATH');
      }

      // Build SDK config
      const config: AgentSDKConfig = {
        apiKey: getCachedAPIKey(),
        modelId: getModelId(),
        sessionFilePath: getSessionFilePath(session.claudeSessionId)
      };

      // Create message generator
      const messageGenerator = this.createMessageGenerator(session);

      // Run Agent SDK query loop
      const { response } = await claudeAgent.run({
        config,
        userMessages: messageGenerator,
        abortSignal: session.abortController.signal
      });

      // Process SDK responses
      for await (const chunk of response) {
        if (chunk.type === 'text') {
          await this.processSDKResponse(session, chunk.text);
        }
      }

      // Mark session complete
      this.dbManager.markSessionComplete(session.sessionDbId);
      logger.info('SDK', 'Session complete', { sessionDbId: session.sessionDbId });

    } catch (error) {
      logger.failure('SDK', 'Agent error', { sessionDbId: session.sessionDbId }, error as Error);
      this.dbManager.markSessionComplete(session.sessionDbId); // Mark failed
    } finally {
      // Cleanup
      this.sessionManager.deleteSession(session.sessionDbId).catch(() => {});
    }
  }

  private async *createMessageGenerator(session: ActiveSession): AsyncIterableIterator<SDKUserMessage> {
    // Yield initial user prompt
    yield {
      role: 'user',
      content: session.userPrompt
    };

    // Consume pending messages from SessionManager (event-driven)
    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      if (message.type === 'observation') {
        yield {
          role: 'user',
          content: this.buildObservationPrompt(message)
        };
      } else if (message.type === 'summarize') {
        yield {
          role: 'user',
          content: this.buildSummarizePrompt(session)
        };
      }
    }
  }

  private buildObservationPrompt(message: PendingMessage): string {
    return `<observation>
<tool_name>${message.tool_name}</tool_name>
<tool_input>${JSON.stringify(message.tool_input)}</tool_input>
<tool_output>${message.tool_output}</tool_output>
</observation>

Please analyze this tool execution and extract observations.`;
  }

  private buildSummarizePrompt(session: ActiveSession): string {
    return `Please summarize this session.`;
  }

  private async processSDKResponse(session: ActiveSession, text: string): Promise<void> {
    // Parse XML for observations or summaries
    const observations = this.parseObservations(text);
    const summary = this.parseSummary(text);

    // Store observations
    for (const obs of observations) {
      const obsId = this.dbManager.getSessionStore().saveObservation({
        sessionDbId: session.sessionDbId,
        claudeSessionId: session.claudeSessionId,
        project: session.project,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        text: obs.text,
        concepts: obs.concepts,
        files: obs.files,
        prompt_number: session.lastPromptNumber
      });

      // Sync to Chroma (fire-and-forget)
      this.dbManager.getChromaSync().syncObservation(obsId).catch(() => {});

      logger.info('SDK', 'Observation saved', { obsId, type: obs.type });
    }

    // Store summary
    if (summary) {
      const summaryId = this.dbManager.getSessionStore().saveSummary({
        sessionDbId: session.sessionDbId,
        claudeSessionId: session.claudeSessionId,
        project: session.project,
        summary: summary.text
      });

      // Sync to Chroma (fire-and-forget)
      this.dbManager.getChromaSync().syncSummary(summaryId).catch(() => {});

      logger.info('SDK', 'Summary saved', { summaryId });
    }
  }

  private parseObservations(text: string): Array<Partial<Observation>> {
    // XML parsing logic (existing implementation)
    // ...
    return [];
  }

  private parseSummary(text: string): { text: string } | null {
    // XML parsing logic (existing implementation)
    // ...
    return null;
  }
}
```

### Key Points
- **Event-driven**: Consumes SessionManager's async iterator (no polling)
- **Fail fast**: Throws if Claude executable not found
- **Fire-and-forget Chroma**: Don't block on vector sync
- **Clean separation**: Database access via DatabaseManager only

---

## 6. PaginationHelper (DRY Utility)

### Responsibility
DRY helper for paginated queries. Eliminates copy-paste across observations/summaries/prompts endpoints.

### Public Interface
```typescript
class PaginationHelper {
  constructor(dbManager: DatabaseManager);

  getObservations(offset: number, limit: number, project?: string): PaginatedResult<Observation>;
  getSummaries(offset: number, limit: number, project?: string): PaginatedResult<Summary>;
  getPrompts(offset: number, limit: number, project?: string): PaginatedResult<UserPrompt>;
}
```

### Dependencies
```typescript
class PaginationHelper {
  private dbManager: DatabaseManager;
}
```

### Implementation Pattern

```typescript
interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

class PaginationHelper {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  getObservations(offset: number, limit: number, project?: string): PaginatedResult<Observation> {
    return this.paginate<Observation>(
      'observations',
      'id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch',
      offset,
      limit,
      project
    );
  }

  getSummaries(offset: number, limit: number, project?: string): PaginatedResult<Summary> {
    return this.paginate<Summary>(
      'summaries',
      'id, session_db_id, project, summary, created_at, created_at_epoch',
      offset,
      limit,
      project
    );
  }

  getPrompts(offset: number, limit: number, project?: string): PaginatedResult<UserPrompt> {
    return this.paginate<UserPrompt>(
      'user_prompts',
      'id, session_db_id, project, prompt, created_at, created_at_epoch',
      offset,
      limit,
      project
    );
  }

  private paginate<T>(
    table: string,
    columns: string,
    offset: number,
    limit: number,
    project?: string
  ): PaginatedResult<T> {
    const db = this.dbManager.getSessionStore().db;

    let query = `SELECT ${columns} FROM ${table}`;
    const params: any[] = [];

    if (project) {
      query += ' WHERE project = ?';
      params.push(project);
    }

    query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset); // Fetch one extra to check hasMore

    const stmt = db.prepare(query);
    const results = stmt.all(...params) as T[];

    return {
      items: results.slice(0, limit),
      hasMore: results.length > limit,
      offset,
      limit
    };
  }
}
```

### Key Points
- **DRY**: Single pagination implementation for 3 endpoints
- **Efficient**: Uses LIMIT+1 trick to avoid COUNT(*) query
- **Type-safe**: Generic typing preserves type information
- **Simple**: 40 lines replaces 120+ lines of copy-paste

---

## 7. SettingsManager (DRY Utility)

### Responsibility
DRY helper for viewer settings CRUD. Eliminates duplication in settings read/write logic.

### Public Interface
```typescript
class SettingsManager {
  constructor(dbManager: DatabaseManager);

  getSettings(): ViewerSettings;
  updateSettings(updates: Partial<ViewerSettings>): ViewerSettings;
}
```

### Dependencies
```typescript
class SettingsManager {
  private dbManager: DatabaseManager;
}
```

### Implementation Pattern

```typescript
interface ViewerSettings {
  sidebarOpen: boolean;
  selectedProject: string | null;
  theme: 'light' | 'dark' | 'system';
}

class SettingsManager {
  private dbManager: DatabaseManager;
  private readonly defaultSettings: ViewerSettings = {
    sidebarOpen: true,
    selectedProject: null,
    theme: 'system'
  };

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  getSettings(): ViewerSettings {
    const db = this.dbManager.getSessionStore().db;

    try {
      const stmt = db.prepare('SELECT key, value FROM viewer_settings');
      const rows = stmt.all() as Array<{ key: string; value: string }>;

      const settings = { ...this.defaultSettings };
      for (const row of rows) {
        if (row.key in settings) {
          settings[row.key as keyof ViewerSettings] = JSON.parse(row.value);
        }
      }

      return settings;
    } catch (error) {
      logger.debug('SETTINGS', 'Failed to load settings, using defaults', {}, error as Error);
      return { ...this.defaultSettings };
    }
  }

  updateSettings(updates: Partial<ViewerSettings>): ViewerSettings {
    const db = this.dbManager.getSessionStore().db;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO viewer_settings (key, value)
      VALUES (?, ?)
    `);

    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, JSON.stringify(value));
    }

    return this.getSettings();
  }
}
```

### Key Points
- **DRY**: Single source of truth for settings logic
- **Type-safe**: Strong typing for settings object
- **Fail gracefully**: Returns defaults if settings table doesn't exist
- **Simple**: 50 lines replaces scattered settings logic

---

## Dependency Graph

```
WorkerService
├─ DatabaseManager
│  ├─ SessionStore (long-lived)
│  ├─ SessionSearch (long-lived)
│  └─ ChromaSync
├─ SessionManager
│  └─ DatabaseManager (injected)
├─ SSEBroadcaster
│  └─ (no dependencies)
├─ SDKAgent
│  ├─ DatabaseManager (injected)
│  └─ SessionManager (injected)
├─ PaginationHelper
│  └─ DatabaseManager (injected)
└─ SettingsManager
   └─ DatabaseManager (injected)
```

### Initialization Order
1. `DatabaseManager.initialize()` - Opens DB connection
2. `SessionManager(dbManager)` - Injected dependency
3. `SDKAgent(dbManager, sessionManager)` - Injected dependencies
4. `PaginationHelper(dbManager)` - Injected dependency
5. `SettingsManager(dbManager)` - Injected dependency
6. `SSEBroadcaster()` - No dependencies
7. `WorkerService.start()` - Orchestrates all services

---

## File Structure

```
src/services/
├─ worker-service.ts              (WorkerService class - orchestration)
├─ worker/
│  ├─ DatabaseManager.ts          (Single connection manager)
│  ├─ SessionManager.ts           (Event-driven session lifecycle)
│  ├─ SSEBroadcaster.ts           (SSE client management)
│  ├─ SDKAgent.ts                 (SDK query loop)
│  ├─ PaginationHelper.ts         (DRY pagination)
│  └─ SettingsManager.ts          (DRY settings CRUD)
└─ worker-types.ts                (Shared interfaces)
```

---

## Benefits of This Architecture

### 1. Single Responsibility
- Each class does ONE thing
- Easy to understand, test, and modify
- Changes are localized

### 2. DRY
- Pagination logic: 40 lines (down from 120+)
- Settings logic: 50 lines (down from scattered code)
- Database access: Centralized in DatabaseManager

### 3. Testability
- Each class can be unit tested in isolation
- Mock dependencies via constructor injection
- No global state

### 4. Performance
- Single database connection (down from 100+ open/close cycles)
- Event-driven queues (zero polling latency)
- Fire-and-forget Chroma sync (doesn't block)

### 5. Maintainability
- Clear dependency graph
- Explicit interfaces
- Fail-fast error handling
- No defensive programming

---

## Migration Strategy

### Phase 1: Extract Classes
1. Create `src/services/worker/` directory
2. Extract `DatabaseManager.ts` from existing code
3. Extract `SessionManager.ts` with EventEmitter pattern
4. Extract `SSEBroadcaster.ts`
5. Extract `SDKAgent.ts`
6. Extract `PaginationHelper.ts`
7. Extract `SettingsManager.ts`

### Phase 2: Refactor WorkerService
1. Replace inline database access with `DatabaseManager`
2. Replace session map with `SessionManager`
3. Replace SSE logic with `SSEBroadcaster`
4. Replace SDK logic with `SDKAgent`
5. Replace pagination endpoints with `PaginationHelper`
6. Replace settings endpoints with `SettingsManager`

### Phase 3: Delete Dead Code
1. Remove `cachedClaudePath` and `findClaudePath()`
2. Remove `checkAndStopSpinner()` and debounce logic
3. Remove polling loops (replace with EventEmitter)
4. Remove two-pass SSE cleanup
5. Remove verbose Chroma error handling
6. Remove duplicate pagination logic

### Phase 4: Testing
1. Run existing integration tests
2. Performance benchmarks (latency, throughput)
3. Memory profiling (check for EventEmitter leaks)
4. Load testing (100 concurrent sessions)

---

## Success Metrics

### Code Quality
- **Total lines**: ~600-700 (down from 1173)
- **Classes**: 7 focused classes vs 1 monolithic class
- **Duplicate code**: Eliminated (pagination, settings, DB access)
- **Cyclomatic complexity**: <15 per method

### Performance
- **Observation latency**: <5ms (down from 50-100ms)
- **Database open/close**: 1 per worker lifetime (down from 100+)
- **SSE broadcast**: Single-pass (down from two-pass)
- **Polling loops**: 0 (down from 1)

### Maintainability
- **Single Responsibility**: Each class has one clear purpose
- **DRY**: No copy-paste code
- **Testability**: All classes unit-testable
- **Dependencies**: Explicit via constructor injection
