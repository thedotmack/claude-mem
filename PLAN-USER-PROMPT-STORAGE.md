# Plan: Store Raw User Prompts for Full Context Search

## Problem

Claude-mem currently only captures tool executions (via PostToolUse hook), not the user's actual instructions and requests. This creates a gap:

- We can see WHAT Claude did (observations)
- We can see SUMMARIES of what happened (session_summaries)
- We CANNOT see what the user actually said/requested

**Real Example:**
User repeatedly asked to "remove session validation" with increasing frustration over multiple prompts. The memory system captured the final implementation but not the conversation where the user had to convince Claude 3-4 times.

## Solution

Store ALL raw user prompts in a dedicated table with full-text search capability.

## Database Schema Changes

### 1. Create `user_prompts` table

```sql
CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sdk_session_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_prompts_sdk_session ON user_prompts(sdk_session_id);
CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
```

### 2. Create FTS5 virtual table for full-text search

```sql
CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
  prompt_text,
  content='user_prompts',
  content_rowid='id'
);
```

### 3. Create triggers to sync FTS5

```sql
CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
  INSERT INTO user_prompts_fts(rowid, prompt_text)
  VALUES (new.id, new.prompt_text);
END;

CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
  INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
  VALUES('delete', old.id, old.prompt_text);
END;

CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
  INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
  VALUES('delete', old.id, old.prompt_text);
  INSERT INTO user_prompts_fts(rowid, prompt_text)
  VALUES (new.id, new.prompt_text);
END;
```

## Code Changes

### 1. Update schema migration

**File:** `src/services/sqlite/SessionStore.ts`

Add the user_prompts table creation to the schema initialization (look for the `CREATE TABLE` statements in the constructor).

### 2. Add method to save user prompts

**File:** `src/services/sqlite/SessionStore.ts`

```typescript
/**
 * Save a user prompt
 */
saveUserPrompt(sdkSessionId: string, promptNumber: number, promptText: string): number {
  const now = new Date();
  const nowEpoch = now.getTime();

  const stmt = this.db.prepare(`
    INSERT INTO user_prompts
    (sdk_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(sdkSessionId, promptNumber, promptText, now.toISOString(), nowEpoch);
  return result.lastInsertRowid as number;
}
```

### 3. Update new-hook to save user prompts

**File:** `src/hooks/new.ts`

After creating/getting the session and incrementing prompt counter, save the raw prompt:

```typescript
// Around line 37, after incrementPromptCounter
const sessionDbId = db.createSDKSession(session_id, project, prompt);
const promptNumber = db.incrementPromptCounter(sessionDbId);

// Get sdk_session_id for foreign key
const session = db.findAnySDKSession(session_id);
if (session?.sdk_session_id) {
  db.saveUserPrompt(session.sdk_session_id, promptNumber, prompt);
}

console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);
```

**Note:** We need the sdk_session_id (not just sessionDbId) for the foreign key. May need to adjust the logic to handle prompts before SDK session is fully initialized.

### 4. Add SessionSearch methods

**File:** `src/services/sqlite/SessionSearch.ts`

```typescript
/**
 * Search user prompts with full-text search
 */
searchUserPrompts(query: string, options: SearchOptions = {}): UserPrompt[] {
  const { limit = 20, offset = 0 } = options;

  const stmt = this.db.prepare(`
    SELECT
      up.id,
      up.sdk_session_id,
      up.prompt_number,
      up.prompt_text,
      up.created_at,
      up.created_at_epoch
    FROM user_prompts_fts fts
    JOIN user_prompts up ON fts.rowid = up.id
    WHERE user_prompts_fts MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `);

  return stmt.all(query, limit, offset) as UserPrompt[];
}

/**
 * Get all prompts for a session
 */
getUserPromptsBySession(sdkSessionId: string): UserPrompt[] {
  const stmt = this.db.prepare(`
    SELECT
      id,
      sdk_session_id,
      prompt_number,
      prompt_text,
      created_at,
      created_at_epoch
    FROM user_prompts
    WHERE sdk_session_id = ?
    ORDER BY prompt_number ASC
  `);

  return stmt.all(sdkSessionId) as UserPrompt[];
}
```

Add the `UserPrompt` type:

```typescript
interface UserPrompt {
  id: number;
  sdk_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}
```

### 5. Add MCP search tool

**File:** `src/servers/search-server.ts`

Add a new tool `search_user_prompts`:

```typescript
{
  name: 'search_user_prompts',
  description: 'Search raw user prompts with full-text search. Use this to find what the user actually said/requested across all sessions.',
  inputSchema: zodToJsonSchema(z.object({
    query: z.string().describe('Search query for FTS5 full-text search'),
    limit: z.number().optional().default(20).describe('Maximum results'),
    offset: z.number().optional().default(0).describe('Results to skip'),
  }))
}
```

And implement the handler.

## Benefits

1. **Full context reconstruction:** See exact user language, frustration level, repeated requests
2. **Pattern detection:** Identify when Claude isn't listening (user repeats same request)
3. **Improved summaries:** AI can reference actual user words, not just observations
4. **Debugging:** Trace from user request → Claude actions → outcomes
5. **Search across time:** "How many times did user ask for X feature?"

## Testing

1. Create a new session and submit several prompts
2. Query `user_prompts` table to verify they're saved
3. Test FTS5 search: `SELECT * FROM user_prompts_fts WHERE user_prompts_fts MATCH 'validation'`
4. Test MCP tool: `/claude-mem search_user_prompts "remove validation"`
5. Verify prompt_number increments correctly
6. Test cascade delete: delete a session, verify prompts are deleted

## Migration Notes

- This is a NEW table, no data migration needed
- Existing sessions won't have historical prompts (that's fine)
- FTS5 triggers will auto-populate as new prompts arrive

## Open Questions

1. **sdk_session_id timing:** New-hook runs BEFORE worker initializes SDK session. Need to either:
   - Save prompts with sessionDbId initially, update with sdk_session_id later
   - OR use sessionDbId as the foreign key instead

2. **Storage size:** User prompts can be large. Consider max length or compression?

3. **Privacy:** User prompts may contain sensitive info. Document this clearly.

## Implementation Order

1. Add schema to SessionStore constructor
2. Add saveUserPrompt method to SessionStore
3. Add search methods to SessionSearch
4. Update new-hook to save prompts
5. Add MCP tool to search-server
6. Test end-to-end
7. Update CLAUDE.md documentation
