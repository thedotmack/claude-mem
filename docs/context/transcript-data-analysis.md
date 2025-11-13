# Transcript Data Analysis: Available Context for Memory Worker

**Generated:** 2025-11-13
**Purpose:** Document what contextual data exists in Claude Code transcripts and identify opportunities to improve memory worker observation generation.

---

## Executive Summary

**Current State:** The memory worker receives isolated tool executions via `save-hook.ts`:
- Tool name
- Tool input (parameters)
- Tool output (results)

**Available in Transcripts:** Rich contextual data that could dramatically improve observation quality:
- User's original request/intent
- Assistant's reasoning (thinking blocks)
- Full conversation context
- Tool result data
- Token usage and performance metrics
- Session metadata (timestamps, UUIDs, CWD)

**Recommendation:** Enhance the memory worker to receive full conversation context for each tool execution, not just isolated tool data.

---

## Transcript Structure

### Entry Types

The transcript file (`~/.claude/projects/-{project}/session-id.jsonl`) contains:

```
- summary entries (149 in sample)
- file-history-snapshot entries (18 in sample)
- user entries (86 in sample)
- assistant entries (155 in sample)
```

### Conversation Turn Pattern

Each conversation turn consists of:
1. **User Entry** - User's request
2. **Assistant Entry** - Assistant's response
3. **User Entry** - Tool results submitted back (automatic)
4. **Assistant Entry** - Assistant processes results and continues

This creates a pattern: User → Assistant → User (tool results) → Assistant (continues) → ...

---

## Available Data by Entry Type

### 1. User Entries

**Current Save-Hook Access:**
- Tool name
- Tool input
- Tool output

**Additional Data Available in User Entries:**

```typescript
interface UserTranscriptEntry {
  type: 'user';
  timestamp: string;           // ISO timestamp
  uuid: string;                // Unique entry ID
  sessionId: string;           // Session identifier
  cwd: string;                 // Working directory
  parentUuid?: string;         // Parent entry reference
  isSidechain: boolean;        // Is this a side conversation?
  userType: string;            // 'human' or 'system'
  version: string;             // Claude Code version

  message: {
    role: 'user';
    content: string | ContentItem[];  // Can be text or structured
  };

  toolUseResult?: ToolUseResult;  // Legacy field, may contain results
}
```

**When `content` is an array, it contains:**
- Text blocks with user's actual request
- Tool result blocks with complete output data

**Example Structure:**
```json
{
  "type": "user",
  "timestamp": "2025-11-13T17:10:31.963Z",
  "uuid": "364676a7-51c3-4036-afc3-7ff8f7301a8f",
  "sessionId": "57dcc12f-4751-46bb-82b4-2aa96a3e226d",
  "cwd": "/Users/alexnewman/Scripts/claude-mem",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01T477WUra1sDR6gHaqZHhKT",
        "content": "[actual tool output data]"
      }
    ]
  }
}
```

### 2. Assistant Entries

**Current Save-Hook Access:**
- Nothing from assistant entries (they happen after tool execution)

**Available Data in Assistant Entries:**

```typescript
interface AssistantTranscriptEntry {
  type: 'assistant';
  timestamp: string;
  uuid: string;
  sessionId: string;
  cwd: string;
  parentUuid?: string;
  isSidechain: boolean;
  userType: string;
  version: string;
  requestId?: string;  // API request ID

  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;              // e.g., "claude-sonnet-4-5-20250929"
    content: ContentItem[];     // Array of content blocks
    stop_reason?: string;       // 'tool_use' | 'end_turn' | etc.
    stop_sequence?: string;
    usage?: UsageInfo;          // Token usage stats
  };
}
```

**Content Block Types in `message.content`:**

1. **Thinking Blocks** - Internal reasoning before acting
   ```typescript
   {
     type: 'thinking';
     thinking: string;  // Full reasoning text
     signature?: string;
   }
   ```

2. **Text Blocks** - Assistant's visible response
   ```typescript
   {
     type: 'text';
     text: string;  // Response text
   }
   ```

3. **Tool Use Blocks** - Tool invocations
   ```typescript
   {
     type: 'tool_use';
     id: string;              // Tool use ID
     name: string;            // Tool name (e.g., 'Read', 'Edit')
     input: Record<string, any>;  // Complete tool parameters
   }
   ```

**Token Usage Data:**
```typescript
interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}
```

### 3. Summary Entries

```typescript
interface SummaryTranscriptEntry {
  type: 'summary';
  summary: string;     // Generated summary text
  leafUuid: string;    // UUID of summarized entry
  cwd?: string;
}
```

These appear frequently (149 in sample) and provide high-level summaries of work done.

---

## Data Flow: Current vs Potential

### Current Flow (Save-Hook Only)

```
User: "Fix the bug in login.ts"
  ↓
Assistant: [uses Edit tool]
  ↓
Tool Execution: Edit(file_path: "login.ts", old_string: "...", new_string: "...")
  ↓
Save-Hook receives:
  - toolName: "Edit"
  - toolInput: { file_path: "login.ts", old_string: "...", new_string: "..." }
  - toolOutput: { success: true }
  ↓
Memory Worker generates observation from ONLY tool data
  - No user intent
  - No assistant reasoning
  - No context about WHY this change was made
```

### Enhanced Flow (With Transcript Context)

```
User: "Fix the authentication bug - users getting logged out randomly"
  ↓
Assistant (thinking): "This sounds like a token expiration issue.
                       Let me check the JWT handling in login.ts..."
  ↓
Assistant (uses Edit tool)
  ↓
Save-Hook receives:
  - toolName: "Edit"
  - toolInput: { file_path: "login.ts", ... }
  - toolOutput: { success: true }
  - PLUS:
    - userRequest: "Fix the authentication bug - users getting logged out randomly"
    - assistantReasoning: "This sounds like a token expiration issue..."
    - conversationContext: Previous 2-3 turns
    - sessionMetadata: { cwd, timestamp, sessionId }
  ↓
Memory Worker generates richer observation:
  - "Fixed authentication bug causing random logouts"
  - "Problem: JWT tokens expiring too quickly"
  - "Solution: Updated token expiration to 24h in login.ts"
  - "Files: src/auth/login.ts"
  - "Concepts: authentication, token-management, bugfix"
```

---

## Specific Opportunities

### 1. User Intent Extraction

**Problem:** Current observations lack user intent.

**Solution:** Parse the most recent user text entry before the tool execution.

**Implementation:**
- Walk backward from tool execution entry
- Find first user entry with text content
- Extract text blocks (filter out tool_result blocks)

**Example:**
```typescript
// In save-hook.ts
const userEntries = parser.getUserEntries();
const recentUserMessage = findUserMessageBeforeTool(userEntries, toolExecutionTimestamp);
const userIntent = extractTextFromContent(recentUserMessage.content);
```

### 2. Assistant Reasoning

**Problem:** We don't capture WHY the assistant chose to use a tool.

**Solution:** Extract thinking blocks from assistant entry immediately before tool use.

**Implementation:**
- Find assistant entry that contains the tool_use block
- Extract thinking blocks from same entry
- Include first ~500 chars of thinking in observation context

**Example:**
```typescript
const assistantEntry = findAssistantEntryWithToolUse(toolUseId);
const thinkingBlocks = assistantEntry.message.content.filter(c => c.type === 'thinking');
const reasoning = thinkingBlocks.map(b => b.thinking).join('\n');
```

### 3. Tool Results Context

**Problem:** Tool output alone doesn't show what was found or changed.

**Solution:** Access full tool result content from next user entry.

**Implementation:**
- Tool execution happens in assistant entry
- Results come back in next user entry as tool_result content
- Save-hook can access both

**Current Structure:**
```
Assistant Entry:
  { type: 'tool_use', id: 'toolu_123', name: 'Read', input: {...} }
    ↓
User Entry (automatic):
  { type: 'tool_result', tool_use_id: 'toolu_123', content: "file contents..." }
```

**Opportunity:** Match tool_use_id to tool_result and include full result content.

### 4. Conversation Context

**Problem:** Isolated tool executions miss the larger conversation flow.

**Solution:** Include last N conversation turns (2-3 turns is usually sufficient).

**Implementation:**
- Get entries from transcript within time window (e.g., last 5 minutes)
- Include user messages and assistant text responses
- Exclude thinking blocks to save tokens

**Example Context:**
```
Turn 1:
User: "I need to add dark mode support"
Assistant: "I'll help you add dark mode. Let me start by..."

Turn 2:
User: [tool results]
Assistant: "Now I'll update the theme configuration..."

Turn 3: [current tool execution]
```

### 5. Session Metadata

**Problem:** Observations lack temporal and project context.

**Solution:** Include session metadata in observation generation.

**Available Fields:**
- `cwd` - Working directory (project path)
- `timestamp` - Exact time of execution
- `sessionId` - Session identifier
- `uuid` - Entry identifier
- `version` - Claude Code version

**Use Case:** Helps with project-specific context and temporal queries.

### 6. Token Usage Metrics

**Problem:** No visibility into performance and cost.

**Solution:** Track token usage per observation.

**Available Data:**
- Input tokens
- Output tokens
- Cache creation tokens
- Cache read tokens

**Use Case:**
- Performance monitoring
- Cost attribution
- Cache effectiveness analysis

---

## Recommended Implementation Strategy

### Phase 1: User Intent (High Impact, Low Effort)

**Change:** Modify save-hook to extract user's most recent message.

**Implementation:**
```typescript
// In save-hook.ts
import { TranscriptParser } from '../utils/transcript-parser';

const parser = new TranscriptParser(transcriptPath);
const userIntent = parser.getLastUserMessage();

// Send to worker
await workerService.saveToolExecution({
  ...existingData,
  userIntent,  // NEW
});
```

**Impact:** Observations now include "what the user wanted to do".

### Phase 2: Assistant Reasoning (High Impact, Medium Effort)

**Change:** Extract thinking blocks from assistant entry containing tool use.

**Implementation:**
```typescript
const assistantEntries = parser.getAssistantEntries();
const toolUseEntry = findEntryWithToolUse(assistantEntries, toolUseId);
const thinking = extractThinkingBlocks(toolUseEntry);

await workerService.saveToolExecution({
  ...existingData,
  userIntent,
  assistantReasoning: thinking,  // NEW
});
```

**Impact:** Observations include "why the assistant chose this approach".

### Phase 3: Conversation Context (Medium Impact, High Effort)

**Change:** Include last 2-3 conversation turns.

**Implementation:**
```typescript
const recentTurns = getRecentConversationTurns(parser, 3);

await workerService.saveToolExecution({
  ...existingData,
  userIntent,
  assistantReasoning: thinking,
  conversationContext: recentTurns,  // NEW
});
```

**Impact:** Observations understand multi-turn workflows.

### Phase 4: Enhanced Metadata (Low Impact, Low Effort)

**Change:** Include session and performance metadata.

**Implementation:**
```typescript
await workerService.saveToolExecution({
  ...existingData,
  userIntent,
  assistantReasoning: thinking,
  conversationContext: recentTurns,
  metadata: {  // NEW
    cwd: entry.cwd,
    timestamp: entry.timestamp,
    sessionId: entry.sessionId,
    tokenUsage: entry.message.usage,
  },
});
```

**Impact:** Better analytics and debugging.

---

## Example: Before and After

### Current Observation (Tool Data Only)

```json
{
  "type": "feature",
  "title": "Updated login.ts",
  "narrative": "Modified authentication logic in src/auth/login.ts",
  "files": ["src/auth/login.ts"],
  "concepts": ["authentication"],
  "facts": []
}
```

### Enhanced Observation (With Transcript Context)

```json
{
  "type": "bugfix",
  "title": "Fixed authentication bug causing random logouts",
  "narrative": "Users were experiencing random logouts due to JWT token expiration. Updated token expiration from 1h to 24h in token validation logic. Modified src/auth/login.ts to use longer-lived tokens and improved error handling for expired tokens.",
  "files": ["src/auth/login.ts"],
  "concepts": ["authentication", "jwt", "token-management", "bugfix"],
  "facts": [
    "JWT token expiration was too short (1h)",
    "Updated expiration to 24h",
    "Added error handling for expired tokens"
  ]
}
```

**Improvement:**
- Clear problem statement
- Explicit solution
- Specific technical details
- Better concept tagging
- Actionable facts

---

## Technical Considerations

### 1. Performance

**Concern:** Parsing entire transcript on every tool execution.

**Solution:**
- TranscriptParser already loads full file (unavoidable)
- Use caching for transcript parsing within same session
- Only parse once per session, reuse parsed entries

**Benchmark:**
- Current: ~10ms to parse 408-line transcript
- Impact: Negligible (save-hook already reads transcript)

### 2. Token Usage

**Concern:** Sending more context to worker increases tokens.

**Solution:**
- Thinking blocks: Limit to first 500 chars
- Conversation context: Only last 2-3 turns
- Tool results: Truncate large outputs to 500 chars
- User intent: Full text (usually short)

**Estimate:**
- Current: ~200 tokens per observation generation
- Enhanced: ~500 tokens per observation generation
- Increase: ~150%
- Cost: Still < $0.001 per observation with Haiku

### 3. Implementation Complexity

**Concern:** Matching tool executions to transcript entries.

**Solution:**
- Tool use IDs are in both places
- Timestamps provide ordering
- UUID chains provide parent-child relationships

**Example Matching:**
```typescript
function findToolContext(parser: TranscriptParser, toolUseId: string) {
  // 1. Find assistant entry with tool_use block
  const assistantEntry = parser.getAssistantEntries()
    .find(entry =>
      entry.message.content.some(c =>
        c.type === 'tool_use' && c.id === toolUseId
      )
    );

  // 2. Find next user entry with tool_result
  const userEntry = parser.getUserEntries()
    .find(entry =>
      entry.message.content.some(c =>
        c.type === 'tool_result' && c.tool_use_id === toolUseId
      )
    );

  return { assistantEntry, userEntry };
}
```

---

## Next Steps

1. **Validate Approach**
   - Review this analysis with project team
   - Confirm data availability in all transcript scenarios
   - Identify any privacy concerns

2. **Implement Phase 1**
   - Update save-hook.ts to extract user intent
   - Modify worker service to accept new fields
   - Update observation prompt to use user intent

3. **Test and Measure**
   - Compare observation quality before/after
   - Measure token usage increase
   - Validate performance impact

4. **Iterate**
   - Roll out Phase 2 (assistant reasoning)
   - Roll out Phase 3 (conversation context)
   - Monitor improvements at each phase

---

## Appendix: Data Samples

### Complete Markdown Representation

See `/Users/alexnewman/Scripts/claude-mem/docs/context/transcript-complete-readable.md` for a full 1:1 markdown representation of the first 10 conversation turns from the sample transcript, including:
- Complete user messages
- Full assistant responses
- Thinking blocks (truncated to 2000 chars)
- Tool uses with complete input JSON
- Tool results with actual output data (truncated to 500 chars)
- Token usage stats
- All metadata (timestamps, UUIDs, session IDs, CWD)

### Sample Tool Result Structure

```typescript
// User entry containing tool result
{
  "type": "user",
  "message": {
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01T477WUra1sDR6gHaqZHhKT",
        "content": [
          {
            "type": "text",
            "text": "{\n  \"thoughtNumber\": 1,\n  \"totalThoughts\": 8,\n  \"nextThoughtNeeded\": true,\n  \"branches\": [],\n  \"thoughtHistoryLength\": 1\n}"
          }
        ]
      }
    ]
  }
}
```

---

## Conclusion

The Claude Code transcript files contain a wealth of contextual data that is currently unused by the memory worker. By extracting:

1. User intent (the "what" and "why")
2. Assistant reasoning (the "how" and "because")
3. Tool results (the "outcome")
4. Conversation context (the "flow")
5. Session metadata (the "when" and "where")

We can generate significantly richer, more useful observations that better capture the intent, decisions, and outcomes of each coding session.

**The data is already there - we just need to read it.**
