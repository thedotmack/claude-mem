# Remove Session Management - Implementation Plan

**Goal**: Delete all session "management" code. The session ID from the hook is all we need.

**Context**: We've tried to simplify this 7+ times and always added complexity back. This time we delete the sdk_sessions table entirely.

---

## Current Architecture (BAD)

```
Hook → createSDKSession() → sdk_sessions table → observations/summaries reference sdk_session_id
                                ↓
                    Auto-create logic in 3 places:
                    1. /api/sessions/init
                    2. /api/sessions/observations
                    3. storeObservation/storeSummary
```

**Problems:**
- 3 places create sessions (race conditions, duplicates)
- sdk_sessions stores redundant data (claude_session_id === sdk_session_id)
- Complex INSERT OR IGNORE patterns
- Session "status" tracking we don't use
- worker_port tracking for unclear reasons
- Auto-create logic that papers over bugs

---

## Target Architecture (GOOD)

```
Hook (sends session_id) → Worker saves to session_id_from_hook column
```

That's it. No session table. No session management. No createSDKSession().

**Naming conventions:**
- Database column: `session_id_from_hook` (descriptive, shows source)
- TypeScript variable: `sessionIdFromHook` (camelCase)
- JSON body field: `sessionId` (simple, what the hook sends)

---

## Schema Changes

### DELETE: sdk_sessions table entirely

**Current:**
```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,
  sdk_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT,
  worker_port INTEGER,
  prompt_counter INTEGER DEFAULT 0
);
```

**GONE. Deleted. Nuked from orbit.**

### UPDATE: observations table

**Before:**
```sql
CREATE TABLE observations (
  ...
  sdk_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  ...
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);
```

**After:**
```sql
CREATE TABLE observations (
  ...
  session_id_from_hook TEXT NOT NULL,  -- Changed from sdk_session_id
  project TEXT NOT NULL,                -- Still here, stored per observation
  ...
  -- NO FOREIGN KEY (session isn't in database)
);

-- Update index
CREATE INDEX idx_observations_session_from_hook ON observations(session_id_from_hook);
```

### UPDATE: session_summaries table

**Before:**
```sql
CREATE TABLE session_summaries (
  ...
  sdk_session_id TEXT NOT NULL,
  ...
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);
```

**After:**
```sql
CREATE TABLE session_summaries (
  ...
  session_id_from_hook TEXT NOT NULL,  -- Changed from sdk_session_id
  ...
  -- NO FOREIGN KEY
);

-- Update index
CREATE INDEX idx_session_summaries_session_from_hook ON session_summaries(session_id_from_hook);
```

### UPDATE: pending_messages table

**Before:**
```sql
CREATE TABLE pending_messages (
  ...
  session_db_id INTEGER NOT NULL,
  claude_session_id TEXT NOT NULL,
  ...
  FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
);
```

**After:**
```sql
CREATE TABLE pending_messages (
  ...
  session_id_from_hook TEXT NOT NULL,  -- Keep this, remove session_db_id
  ...
  -- NO FOREIGN KEY
);
```

### KEEP: user_prompts table (just remove foreign key)

```sql
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id_from_hook TEXT NOT NULL,  -- Rename from claude_session_id
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
  -- Remove FOREIGN KEY
);

-- Update index
CREATE INDEX idx_user_prompts_session_from_hook ON user_prompts(session_id_from_hook);
CREATE INDEX idx_user_prompts_lookup ON user_prompts(session_id_from_hook, prompt_number);
```

---

## Code Changes

### 1. Delete SessionStore methods (src/services/sqlite/SessionStore.ts)

**DELETE these methods entirely:**
- `createSDKSession()` (lines 1142-1178)
- `updateSDKSessionId()` (lines 1185-1205)
- `findActiveSDKSession()` (lines 1043-1057)
- `findAnySDKSession()` (lines 1062-1071)
- `reactivateSession()` (lines 1076-1084)
- `incrementPromptCounter()` (lines 1089-1103)
- `getPromptCounter()` (lines 1108-1114)
- `setWorkerPort()` (lines 1210-1218)
- `getWorkerPort()` (lines 1223-1233)
- `markSessionCompleted()` (lines 1419-1430)
- `markSessionFailed()` (lines 1435-1446)
- `getSessionById()` (lines 993-1008)
- `getSdkSessionsBySessionIds()` (lines 1014-1038)

### 2. Update storeObservation() (SessionStore.ts:1272)

**DELETE auto-create logic (lines 1291-1312):**
```typescript
// DELETE THIS ENTIRE BLOCK:
const checkStmt = this.db.prepare(`
  SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
`);
const existingSession = checkStmt.get(sdkSessionId) as { id: number } | undefined;

if (!existingSession) {
  const insertSession = this.db.prepare(`
    INSERT INTO sdk_sessions
    (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `);
  insertSession.run(sdkSessionId, sdkSessionId, project, now.toISOString(), nowEpoch);
}
```

**UPDATE signature and implementation:**
```typescript
storeObservation(
  sessionIdFromHook: string,  // Changed from sdkSessionId
  project: string,
  observation: {
    type: string;
    title: string | null;
    subtitle: string | null;
    facts: string[];
    narrative: string | null;
    concepts: string[];
    files_read: string[];
    files_modified: string[];
  },
  promptNumber?: number,
  discoveryTokens: number = 0
): { id: number; createdAtEpoch: number } {
  const now = new Date();
  const nowEpoch = now.getTime();

  const stmt = this.db.prepare(`
    INSERT INTO observations
    (session_id_from_hook, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    sessionIdFromHook,
    project,
    observation.type,
    observation.title,
    observation.subtitle,
    JSON.stringify(observation.facts),
    observation.narrative,
    JSON.stringify(observation.concepts),
    JSON.stringify(observation.files_read),
    JSON.stringify(observation.files_modified),
    promptNumber || null,
    discoveryTokens,
    now.toISOString(),
    nowEpoch
  );

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: nowEpoch
  };
}
```

### 3. Update storeSummary() (SessionStore.ts:1348)

**Same pattern - delete auto-create, update signature:**
```typescript
storeSummary(
  sessionIdFromHook: string,  // Changed from sdkSessionId
  project: string,
  summary: {
    request: string;
    investigated: string;
    learned: string;
    completed: string;
    next_steps: string;
    notes: string | null;
  },
  promptNumber?: number,
  discoveryTokens: number = 0
): { id: number; createdAtEpoch: number }
```

### 4. Update SessionManager (src/services/worker/SessionManager.ts)

**Change ActiveSession interface:**
```typescript
interface ActiveSession {
  sessionIdFromHook: string;    // Renamed from claudeSessionId
  // DELETE: sessionDbId - no longer needed
  project: string;              // Keep
  sdkSessionId: string | null;  // Keep (for now, from SDK init message)
  lastPromptNumber: number;     // Keep
  pendingMessages: PendingMessage[];  // Keep
  generatorPromise: Promise<void> | null;  // Keep
}
```

**Update initializeSession():**
```typescript
initializeSession(sessionIdFromHook: string, project: string, userPrompt: string, promptNumber: number): ActiveSession {
  let session = this.sessions.get(sessionIdFromHook);

  if (!session) {
    session = {
      sessionIdFromHook,
      project,
      sdkSessionId: null,
      lastPromptNumber: promptNumber,
      pendingMessages: [],
      generatorPromise: null
    };
    this.sessions.set(sessionIdFromHook, session);
    this.sessionQueues.set(sessionIdFromHook, new EventEmitter());
  } else {
    session.lastPromptNumber = promptNumber;
  }

  return session;
}
```

**Update queueObservation():**
```typescript
queueObservation(sessionIdFromHook: string, data: ObservationData): void {
  let session = this.sessions.get(sessionIdFromHook);
  if (!session) {
    // This should never happen - new-hook creates session first
    throw new Error(`Session ${sessionIdFromHook} not initialized before queueObservation`);
  }

  const message: PendingMessage = {
    type: 'observation',
    tool_name: data.tool_name,
    tool_input: data.tool_input,
    tool_response: data.tool_response,
    prompt_number: data.prompt_number,
    cwd: data.cwd
  };

  // Persist to database
  const messageId = this.getPendingStore().enqueue(sessionIdFromHook, message);

  // Add to in-memory queue
  session.pendingMessages.push(message);

  // Notify generator
  const emitter = this.sessionQueues.get(sessionIdFromHook);
  emitter?.emit('message');
}
```

### 5. Update SessionRoutes (src/services/worker/http/routes/SessionRoutes.ts)

**DELETE handleSessionInit** (old sessionDbId-based endpoint) entirely

**UPDATE handleSessionInitByClaudeId:**
```typescript
private handleSessionInitByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
  const { sessionId, project, prompt } = req.body;

  if (!this.validateRequired(req, res, ['sessionId', 'project', 'prompt'])) {
    return;
  }

  const store = this.dbManager.getSessionStore();

  // Increment prompt counter (derive from user_prompts count)
  const promptNumber = this.getNextPromptNumber(sessionId);

  // Strip privacy tags from prompt
  const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);

  // Check if prompt is entirely private
  if (!cleanedPrompt || cleanedPrompt.trim() === '') {
    res.json({
      promptNumber,
      skipped: true,
      reason: 'private'
    });
    return;
  }

  // Save user prompt
  store.saveUserPrompt(sessionId, promptNumber, cleanedPrompt);

  // Initialize session in SessionManager
  const session = this.sessionManager.initializeSession(sessionId, project, cleanedPrompt, promptNumber);

  // Sync prompt to Chroma
  const latestPrompt = store.getLatestUserPrompt(sessionId);
  if (latestPrompt) {
    this.dbManager.getChromaSync().syncUserPrompt(
      latestPrompt.id,
      sessionId,
      project,
      latestPrompt.prompt_text,
      promptNumber,
      latestPrompt.created_at_epoch
    ).catch(error => {
      logger.warn('CHROMA', 'Prompt sync failed', { sessionId, promptNumber }, error);
    });
  }

  // Start generator if not already running
  this.ensureGeneratorRunning(session);

  res.json({
    promptNumber,
    skipped: false
  });
});

private getNextPromptNumber(sessionIdFromHook: string): number {
  const store = this.dbManager.getSessionStore();
  const stmt = store.db.prepare(`
    SELECT COUNT(*) as count FROM user_prompts WHERE session_id_from_hook = ?
  `);
  const result = stmt.get(sessionIdFromHook) as { count: number };
  return result.count + 1;
}
```

**UPDATE handleObservationsByClaudeId:**
```typescript
private handleObservationsByClaudeId = this.wrapHandler((req: Request, res: Response): void => {
  const { sessionId, tool_name, tool_input, tool_response, cwd } = req.body;

  if (!sessionId) {
    return this.badRequest(res, 'Missing sessionId');
  }

  // Privacy checks...
  const store = this.dbManager.getSessionStore();
  const promptNumber = this.getCurrentPromptNumber(sessionId);

  // Get project from most recent observation or user_prompt for this session
  const project = this.getProjectForSession(sessionId);
  if (!project) {
    return this.badRequest(res, 'Session not initialized - call /api/sessions/init first');
  }

  // Strip privacy tags...
  const cleanedToolInput = stripMemoryTagsFromJson(JSON.stringify(tool_input));
  const cleanedToolResponse = stripMemoryTagsFromJson(JSON.stringify(tool_response));

  // Queue observation
  this.sessionManager.queueObservation(sessionId, {
    tool_name,
    tool_input: cleanedToolInput,
    tool_response: cleanedToolResponse,
    prompt_number: promptNumber,
    cwd
  });

  res.json({ status: 'queued' });
});

private getCurrentPromptNumber(sessionIdFromHook: string): number {
  // Check in-memory session first
  const session = this.sessionManager.sessions.get(sessionIdFromHook);
  if (session) {
    return session.lastPromptNumber;
  }

  // Fallback to counting user_prompts
  return this.getNextPromptNumber(sessionIdFromHook) - 1;
}

private getProjectForSession(sessionIdFromHook: string): string | null {
  // Check in-memory session first
  const session = this.sessionManager.sessions.get(sessionIdFromHook);
  if (session) {
    return session.project;
  }

  // Fallback to querying latest observation or user_prompt
  const store = this.dbManager.getSessionStore();
  const stmt = store.db.prepare(`
    SELECT project FROM observations
    WHERE session_id_from_hook = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `);
  const result = stmt.get(sessionIdFromHook) as { project: string } | undefined;
  return result?.project || null;
}
```

### 6. Update PendingMessageStore (src/services/sqlite/PendingMessageStore.ts)

**UPDATE enqueue() signature:**
```typescript
enqueue(sessionIdFromHook: string, message: PendingMessage): number {
  const now = Date.now();
  const stmt = this.db.prepare(`
    INSERT INTO pending_messages (
      session_id_from_hook, message_type,
      tool_name, tool_input, tool_response, cwd,
      last_user_message, last_assistant_message,
      prompt_number, status, retry_count, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `);

  const result = stmt.run(
    sessionIdFromHook,
    message.type,
    message.tool_name || null,
    message.tool_input ? JSON.stringify(message.tool_input) : null,
    message.tool_response ? JSON.stringify(message.tool_response) : null,
    message.cwd || null,
    message.last_user_message || null,
    message.last_assistant_message || null,
    message.prompt_number || null,
    now
  );

  return result.lastInsertRowid as number;
}
```

**UPDATE other methods to use sessionIdFromHook parameter naming**

### 7. Create Migration (src/services/sqlite/migrations.ts)

```typescript
// Migration 17: Remove sdk_sessions table and rename to session_id_from_hook

export function migration017_remove_sdk_sessions(db: Database): void {
  console.log('[Migration 17] Removing sdk_sessions table and renaming to session_id_from_hook...');

  db.run('BEGIN TRANSACTION');

  try {
    // Step 1: Create new observations table
    db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id_from_hook TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    // Copy data (sdk_session_id → session_id_from_hook, they're identical anyway)
    db.run(`
      INSERT INTO observations_new
      SELECT id, sdk_session_id as session_id_from_hook, project, text, type, title, subtitle,
             facts, narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch
      FROM observations
    `);

    db.run('DROP TABLE observations');
    db.run('ALTER TABLE observations_new RENAME TO observations');

    // Recreate indexes
    db.run('CREATE INDEX idx_observations_session_from_hook ON observations(session_id_from_hook)');
    db.run('CREATE INDEX idx_observations_project ON observations(project)');
    db.run('CREATE INDEX idx_observations_type ON observations(type)');
    db.run('CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC)');

    // Step 2: Create new session_summaries table
    db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id_from_hook TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    db.run(`
      INSERT INTO session_summaries_new
      SELECT id, sdk_session_id as session_id_from_hook, project, request, investigated,
             learned, completed, next_steps, notes, prompt_number,
             discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `);

    db.run('DROP TABLE session_summaries');
    db.run('ALTER TABLE session_summaries_new RENAME TO session_summaries');

    db.run('CREATE INDEX idx_session_summaries_session_from_hook ON session_summaries(session_id_from_hook)');
    db.run('CREATE INDEX idx_session_summaries_project ON session_summaries(project)');
    db.run('CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC)');

    // Step 3: Create new pending_messages table
    db.run(`
      CREATE TABLE pending_messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id_from_hook TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER
      )
    `);

    db.run(`
      INSERT INTO pending_messages_new
      SELECT id, claude_session_id as session_id_from_hook, message_type, tool_name, tool_input, tool_response,
             cwd, last_user_message, last_assistant_message, prompt_number,
             status, retry_count, created_at_epoch, started_processing_at_epoch,
             completed_at_epoch
      FROM pending_messages
    `);

    db.run('DROP TABLE pending_messages');
    db.run('ALTER TABLE pending_messages_new RENAME TO pending_messages');

    db.run('CREATE INDEX idx_pending_messages_session_from_hook ON pending_messages(session_id_from_hook)');
    db.run('CREATE INDEX idx_pending_messages_status ON pending_messages(status)');

    // Step 4: Update user_prompts (rename column, remove foreign key)
    db.run(`
      CREATE TABLE user_prompts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id_from_hook TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      )
    `);

    db.run(`
      INSERT INTO user_prompts_new
      SELECT id, claude_session_id as session_id_from_hook, prompt_number, prompt_text, created_at, created_at_epoch
      FROM user_prompts
    `);

    db.run('DROP TABLE user_prompts');
    db.run('ALTER TABLE user_prompts_new RENAME TO user_prompts');

    db.run('CREATE INDEX idx_user_prompts_session_from_hook ON user_prompts(session_id_from_hook)');
    db.run('CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC)');
    db.run('CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number)');
    db.run('CREATE INDEX idx_user_prompts_lookup ON user_prompts(session_id_from_hook, prompt_number)');

    // Recreate FTS5 triggers
    db.run(`
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `);

    db.run(`
      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;
    `);

    db.run(`
      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `);

    // Step 5: Drop sdk_sessions table
    db.run('DROP TABLE sdk_sessions');

    db.run('COMMIT');
    console.log('[Migration 17] Successfully removed sdk_sessions table');

  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}
```

---

## CRITICAL GOTCHAS - READ THIS 100 TIMES

### GOTCHA #1: "But what about when we need to..."
**STOP.** The answer is: use the session_id_from_hook.

Examples of things you'll want to add:
- ❌ "Track which sessions are active" → NO, Claude Code tracks this
- ❌ "Know when a session started" → Get min(created_at_epoch) from observations
- ❌ "Group observations by session" → WHERE session_id_from_hook = ?
- ❌ "Get the project for a session" → Get project from any observation in that session
- ❌ "Count prompts in a session" → COUNT(*) FROM user_prompts WHERE session_id_from_hook = ?
- ❌ "Check if session exists" → NO, if it doesn't exist that's a bug in the hook

**If the hook hasn't created session data yet, that's a BUG, not something to paper over.**

### GOTCHA #2: "But the worker might receive observations before init"
**NO.** The new-hook ALWAYS fires before save-hook. Timeline:
1. User submits prompt
2. new-hook fires → calls /api/sessions/init
3. Claude uses tools
4. save-hook fires → calls /api/sessions/observations

If observations arrive before init, the hook is broken. Fix the hook, don't add defensive code.

### GOTCHA #3: "But what if the session doesn't exist in SessionManager?"
**Throw an error.** If SessionManager doesn't have the session, something is catastrophically wrong. Crashing loudly is better than silently creating broken data.

```typescript
// GOOD:
const session = this.sessions.get(claudeSessionId);
if (!session) {
  throw new Error(`Session ${claudeSessionId} not initialized`);
}

// BAD (what we used to do):
let session = this.sessions.get(claudeSessionId);
if (!session) {
  session = this.initializeSession(claudeSessionId); // Auto-create
}
```

### GOTCHA #4: "But we need to track worker_port for..."
**NO.** Worker port tracking was for some unclear worker management. If we need it later, we'll add a separate workers table. Don't put it in session management.

### GOTCHA #5: "But the database needs foreign keys for integrity"
**NO.** Foreign keys to a session table we don't manage make no sense. The claude_session_id is the foreign key - it references Claude Code's session, not our database.

### GOTCHA #6: "But INSERT OR IGNORE is elegant!"
**Not when applied to everything.** INSERT OR IGNORE is for createSDKSession which we're DELETING. Regular observation inserts should just INSERT and fail loudly if something is wrong.

### GOTCHA #7: "But we need to validate that project is correct"
**NO.** The hook gives us the project. We store it. If it's wrong, the hook is broken.

### GOTCHA #8: "This seems risky, we should add validation..."
**This is where we always fail.** The "risk" is that our code might crash if the hook is broken. THAT'S GOOD. Crashing is better than silently creating corrupt data.

---

## Testing Strategy

### Test 1: Normal flow
1. Submit prompt → new-hook → /api/sessions/init
2. Use tools → save-hook → /api/sessions/observations
3. Stop → summary-hook → /api/sessions/summarize
4. Verify all observations have correct session_id_from_hook

### Test 2: Multi-prompt session
1. Prompt #1 → creates user_prompt, observations
2. Prompt #2 → creates user_prompt, more observations
3. Verify all observations share same session_id_from_hook
4. Verify prompt_number increments correctly

### Test 3: Error cases
1. Call /api/sessions/observations before /api/sessions/init
   - Should return 400 error, NOT auto-create
2. Call with invalid sessionId
   - Should fail, NOT auto-create

### Test 4: Migration
1. Backup existing database
2. Run migration
3. Verify data integrity:
   - All observations have session_id_from_hook (was sdk_session_id)
   - All summaries have session_id_from_hook
   - All user_prompts have session_id_from_hook
   - Count matches before/after
4. Test normal operations

---

## Success Criteria

- [ ] sdk_sessions table deleted
- [ ] No createSDKSession() method exists
- [ ] No auto-create logic exists anywhere
- [ ] All tables use session_id_from_hook column
- [ ] All code uses sessionIdFromHook variable naming
- [ ] Migration preserves all data
- [ ] Tests pass
- [ ] No "but what about..." code added

---

## If You're About to Add Session Management...

**STOP. RE-READ THE GOTCHAS.**

Ask yourself:
1. Is this papering over a hook bug? (If yes, fix the hook)
2. Am I being "defensive" against something that can't happen? (If yes, delete the code)
3. Can I get this from session_id_from_hook directly? (If yes, do that)
4. Am I about to call this "KISS" or "elegant"? (If yes, you're adding complexity)

**The session ID from the hook is all we need. Period.**
