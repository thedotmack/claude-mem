# Issue #598: Conversation History Pollution - Technical Analysis Report

**Issue:** Too many messages, polluting my conversation history
**Author:** abhijit8ganguly-afk
**Created:** 2026-01-07
**Labels:** bug
**Report Date:** 2026-01-07

---

## 1. Executive Summary

Users are experiencing conversation history pollution when using `/resume` in Claude Code. Plugin-generated messages starting with "Hello memory agent" appear in the user's conversation history, making it difficult to resume sessions. This issue stems from a fundamental architectural concern: the Claude Agent SDK's resume mechanism appears to inject messages into the user's transcript when the `resume` parameter is passed with the user's `contentSessionId` instead of the plugin's separate `memorySessionId`.

**Key Finding:** The plugin maintains two separate session IDs for isolation:
- `contentSessionId`: The user's Claude Code session (what appears in `/resume`)
- `memorySessionId`: The plugin's internal SDK session (should NEVER appear in user's history)

When these become conflated, plugin messages pollute the user's conversation history.

---

## 2. Problem Analysis

### 2.1 User-Reported Symptoms

When using `/resume`, users see multiple messages starting with "Hello memory agent" appearing in their conversation history. These messages are internal to the claude-mem plugin and should be invisible to users.

### 2.2 Source of "Hello memory agent" Messages

The message originates from the mode configuration file at `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/plugin/modes/code.json`:

```json
{
  "prompts": {
    "continuation_greeting": "Hello memory agent, you are continuing to observe the primary Claude session.",
    "continuation_instruction": "IMPORTANT: Continue generating observations from tool use messages using the XML structure below."
  }
}
```

This greeting is injected via `buildContinuationPrompt()` in `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/sdk/prompts.ts`:

```typescript
export function buildContinuationPrompt(userPrompt: string, promptNumber: number, contentSessionId: string, mode: ModeConfig): string {
  return `${mode.prompts.continuation_greeting}
...
```

### 2.3 When These Messages Appear

The continuation prompt is used when `session.lastPromptNumber > 1` (any prompt after the initial session start). This is controlled in `SDKAgent.ts`:

```typescript
const initPrompt = isInitPrompt
  ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
  : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);
```

---

## 3. Technical Details

### 3.1 Session ID Architecture

The plugin uses a dual session ID system to maintain isolation between user conversations and plugin operations:

| Session ID | Purpose | Storage | Should Appear in /resume |
|------------|---------|---------|--------------------------|
| `contentSessionId` | User's Claude Code session | From hook context | Yes - this IS the user's session |
| `memorySessionId` | Plugin's internal SDK session | Captured from SDK responses | **NEVER** |

**Critical Code Comments from `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/sqlite/SessionStore.ts`:**

```typescript
// NOTE: memory_session_id starts as NULL. It is captured by SDKAgent from the first SDK
// response and stored via updateMemorySessionId(). CRITICAL: memory_session_id must NEVER
// equal contentSessionId - that would inject memory messages into the user's transcript!
```

### 3.2 SDK Query Flow

The `SDKAgent.startSession()` method at `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/src/services/worker/SDKAgent.ts` controls how the plugin interacts with Claude:

```typescript
const queryResult = query({
  prompt: messageGenerator,
  options: {
    model: modelId,
    // Only resume if BOTH: (1) we have a memorySessionId AND (2) this isn't the first prompt
    // On worker restart, memorySessionId may exist from a previous SDK session but we
    // need to start fresh since the SDK context was lost
    ...(hasRealMemorySessionId && session.lastPromptNumber > 1 && { resume: session.memorySessionId }),
    disallowedTools,
    abortController: session.abortController,
    pathToClaudeCodeExecutable: claudePath
  }
});
```

**Key Point:** The `resume` parameter specifies which session to continue. If this accidentally uses `contentSessionId`, messages appear in the user's history.

### 3.3 Message Generator Architecture

The `createMessageGenerator()` method yields synthetic user messages to the SDK:

```typescript
yield {
  type: 'user',
  message: {
    role: 'user',
    content: initPrompt  // Contains "Hello memory agent" for continuation prompts
  },
  session_id: session.contentSessionId,  // References user's session for context
  parent_tool_use_id: null,
  isSynthetic: true  // Marked as synthetic - should not appear in real history
};
```

### 3.4 Transcript Storage Locations

Claude Code stores conversation transcripts at:
```
~/.claude/projects/{dashed-cwd}/{session_id}.jsonl
```

If the wrong session ID is used, plugin messages get written to the user's transcript file.

---

## 4. Impact Assessment

### 4.1 User Experience Impact

| Severity | Description |
|----------|-------------|
| High | Users cannot effectively use `/resume` due to pollution |
| Medium | Confusion about what messages are "real" vs plugin-generated |
| Low | Increased scrolling/navigation effort |

### 4.2 Functional Impact

- **Session Resume Degraded:** The core `/resume` functionality becomes less useful
- **Context Window Pollution:** Plugin messages consume valuable context window tokens
- **Trust Erosion:** Users may question if the plugin is behaving correctly

### 4.3 Affected Users

All users who:
1. Have claude-mem plugin installed
2. Use `/resume` to continue sessions
3. Have multi-turn conversations where continuation prompts are generated

---

## 5. Root Cause Analysis

### 5.1 Primary Root Cause

The issue likely occurs when the session ID passed to the SDK's `resume` parameter conflates with the user's session. This could happen in several scenarios:

**Scenario A: Stale Session ID Resume (Previously Identified)**

When the worker restarts with a stale `memorySessionId` from a previous session, it may attempt to resume into a non-existent session. The fix at `SDKAgent.ts:109` prevents this:

```typescript
...(hasRealMemorySessionId && session.lastPromptNumber > 1 && { resume: session.memorySessionId }),
```

However, if this logic was not working correctly, or if there was a race condition, the wrong ID could be used.

**Scenario B: Session ID Capture Timing**

The `memorySessionId` is captured from the first SDK response:

```typescript
if (!session.memorySessionId && message.session_id) {
  session.memorySessionId = message.session_id;
  // Persist to database for cross-restart recovery
  this.dbManager.getSessionStore().updateMemorySessionId(
    session.sessionDbId,
    message.session_id
  );
}
```

If this capture fails or is delayed, subsequent messages might use the wrong session context.

**Scenario C: Message Yielding with User Session Context**

The message generator yields messages with `session_id: session.contentSessionId`:

```typescript
yield {
  type: 'user',
  message: { role: 'user', content: initPrompt },
  session_id: session.contentSessionId,  // <-- This is the user's session ID!
  ...
};
```

This field may be used by the SDK to determine where to persist messages. If so, this is a design issue where the plugin's internal messages reference the user's session.

### 5.2 Contributing Factors

1. **Shared Conversation History:** The plugin maintains a `conversationHistory` array that includes plugin messages, used for provider switching (Claude/Gemini/OpenRouter). This history may leak into user-visible contexts.

2. **Continuation Prompt Content:** The "Hello memory agent" greeting is explicitly designed to be internal but has no technical mechanism preventing it from appearing in user transcripts.

3. **Synthetic Message Flag:** Messages are marked `isSynthetic: true` but this flag may not be respected by all downstream components.

---

## 6. Recommended Solutions

### 6.1 Immediate Mitigations

#### Option A: Remove or Minimize Continuation Greeting (Low Effort)

Modify the mode configuration to use a less intrusive greeting:

```json
{
  "continuation_greeting": "",  // Empty or very minimal
}
```

**Pros:** Quick fix, no code changes
**Cons:** Doesn't fix the underlying session ID issue

#### Option B: Verify Session ID Isolation (Medium Effort)

Add runtime validation to ensure `memorySessionId` never equals `contentSessionId`:

```typescript
if (session.memorySessionId === session.contentSessionId) {
  logger.error('SESSION', 'CRITICAL: memorySessionId matches contentSessionId - messages will pollute user history!', {
    contentSessionId: session.contentSessionId,
    memorySessionId: session.memorySessionId
  });
  // Reset memorySessionId to force fresh SDK session
  session.memorySessionId = null;
}
```

### 6.2 Structural Fixes

#### Option C: Remove session_id from Yielded Messages (High Effort)

Investigate if the `session_id` field in yielded messages can be omitted or changed:

```typescript
yield {
  type: 'user',
  message: { role: 'user', content: initPrompt },
  // session_id: session.contentSessionId,  // REMOVE or use memorySessionId
  parent_tool_use_id: null,
  isSynthetic: true
};
```

**Requires:** Understanding of SDK internals and testing

#### Option D: Separate Transcript Storage (High Effort)

Ensure plugin messages are stored in a completely separate transcript path:
- User transcript: `~/.claude/projects/{cwd}/{contentSessionId}.jsonl`
- Plugin transcript: `~/.claude-mem/transcripts/{memorySessionId}.jsonl`

### 6.3 Long-Term Architecture

#### Option E: Agent SDK Isolation Mode

Request or implement an SDK feature that marks certain messages as "agent-internal" and prevents them from appearing in user-facing `/resume` history.

---

## 7. Priority/Severity Assessment

| Dimension | Rating | Justification |
|-----------|--------|---------------|
| **User Impact** | High | Directly affects core user workflow (`/resume`) |
| **Frequency** | High | Affects all users with continuation prompts |
| **Workaround Available** | Partial | Users can ignore messages, but UX degraded |
| **Fix Complexity** | Medium-High | Requires understanding SDK session mechanics |

### Recommended Priority: P1 (High)

This issue should be addressed promptly as it:
1. Degrades a core Claude Code feature (`/resume`)
2. Affects all plugin users
3. May indicate a deeper session isolation problem
4. Could lead to users disabling the plugin

---

## 8. Related Issues and Documentation

### Related Issues
- Previous fix for stale session resume: `.claude/plans/fix-stale-session-resume-crash.md`
- Session ID architecture: `SESSION_ID_ARCHITECTURE.md` (referenced in plans)

### Key Files for Investigation
| File | Relevance |
|------|-----------|
| `src/services/worker/SDKAgent.ts` | SDK query loop and session handling |
| `src/sdk/prompts.ts` | Prompt generation including "Hello memory agent" |
| `plugin/modes/code.json` | Mode configuration with greeting text |
| `src/services/sqlite/SessionStore.ts` | Session ID storage and validation |
| `tests/sdk-agent-resume.test.ts` | Test file for resume logic |

### Test Coverage
The resume parameter logic has unit tests at `/Users/alexnewman/conductor/workspaces/claude-mem/budapest/tests/sdk-agent-resume.test.ts` covering:
- INIT prompt scenarios (should NOT resume)
- Continuation prompt scenarios (should resume with memorySessionId)
- Edge cases (empty/undefined memorySessionId)
- Stale session crash prevention

---

## 9. Appendix: Code References

### A. Continuation Greeting in Mode Config
**File:** `plugin/modes/code.json`
```json
"continuation_greeting": "Hello memory agent, you are continuing to observe the primary Claude session."
```

### B. Prompt Building
**File:** `src/sdk/prompts.ts:174-177`
```typescript
export function buildContinuationPrompt(...): string {
  return `${mode.prompts.continuation_greeting}
...
```

### C. Message Yielding
**File:** `src/services/worker/SDKAgent.ts:283-292`
```typescript
yield {
  type: 'user',
  message: { role: 'user', content: initPrompt },
  session_id: session.contentSessionId,
  parent_tool_use_id: null,
  isSynthetic: true
};
```

### D. Session ID Capture
**File:** `src/services/worker/SDKAgent.ts:120-140`
```typescript
if (!session.memorySessionId && message.session_id) {
  session.memorySessionId = message.session_id;
  this.dbManager.getSessionStore().updateMemorySessionId(
    session.sessionDbId,
    message.session_id
  );
  ...
}
```

---

*Report generated: 2026-01-07*
*Analysis based on codebase at commit: 687146ce (merge main)*
