# SDKAgent.ts - Complete Removal List

**Principle:** If it's not in the canonical session-based examples, DELETE IT.

---

## SIMPLIFY

### 1. Token Tracking (Lines 87-90, 121-124)

**V2 API doesn't provide usage data. Hardcode to 0 for now.**

```typescript
// REPLACE (appears twice - observation and summarize blocks):
// Extract token counts from SDK message usage
const tokensUsed = (msg.message.usage?.input_tokens || 0) + (msg.message.usage?.output_tokens || 0);
session.cumulativeInputTokens += msg.message.usage?.input_tokens || 0;
session.cumulativeOutputTokens += msg.message.usage?.output_tokens || 0;

// WITH:
// TODO: Not sure if V2 exposes token usage, so we are setting to 0 for now to be able to get this thing working
const tokensUsed = 0;
```

**Impact:**
- Simplifies code (removes usage extraction)
- Tokens persist to DB as 0 (reporting still works)
- Clear TODO for when we figure out V2 token tracking
- Keep cumulative counters in session (can stay at 0)

---

## DELETE / SIMPLIFY

### 2. Text Content Fallbacks (Lines 85, 119)

```typescript
// WRONG:
const textContent = text?.text || '';

// RIGHT:
const textContent = text?.text;
```

---

### 3. Text Guard Before Conversation History (Lines 157-159)

```typescript
// DELETE the if check:
if (text) {
  session.conversationHistory.push({ role: 'assistant', content: text });
}

// REPLACE with:
session.conversationHistory.push({ role: 'assistant', content: textContent });
```

---

### 4. Worker Defensive Checks (Lines 214-236, 288-305, 345-347)

**Option 1 - Make worker required:**
```typescript
// Remove all if checks, call directly:
worker.sseBroadcaster.broadcast({...});
worker.broadcastProcessingStatus();

// Update method signature:
async startSession(session: ActiveSession, worker: WorkerService): Promise<void>
```

**Option 2 - Use optional chaining:**
```typescript
worker?.sseBroadcaster?.broadcast({...});
worker?.broadcastProcessingStatus?.();
```

**Choose one. Don't use if blocks.**

---

### 5. Empty Set Check (Line 321)

```typescript
// DELETE:
if (session.pendingProcessingIds.size > 0) {
  for (const messageId of session.pendingProcessingIds) {
    pendingMessageStore.markProcessed(messageId);
  }
  // ...
}

// REPLACE with:
for (const messageId of session.pendingProcessingIds) {
  pendingMessageStore.markProcessed(messageId);
}
```

---

### 6. Deleted Count Guard (Lines 336-341)

```typescript
// DELETE:
if (deletedCount > 0) {
  logger.debug('SDK', 'Cleaned up old processed messages', { deletedCount });
}

// REPLACE with:
logger.debug('SDK', 'Cleaned up old processed messages', { deletedCount });
```

---

### 7. Prompt Number Guard (Lines 66-68)

**Verify schema first:**
- If prompt_number is ALWAYS present → Remove guard
- If sometimes absent → Fix the schema, don't guard

```typescript
// Probably DELETE:
if (message.prompt_number !== undefined) {
  session.lastPromptNumber = message.prompt_number;
}

// REPLACE with:
session.lastPromptNumber = message.prompt_number;
```

---

### 8. Dead Code (Lines 363-378)

```typescript
// DELETE ENTIRE METHOD:
private async findClaudeExecutable(): Promise<string> {
  // ... 15 lines
}
```

---

## KEEP (In canonical examples)

### ✅ Message Type Routing
```typescript
if (message.type === 'observation') {
  // ...
} else if (message.type === 'summarize') {
  // ...
}
```

### ✅ Assistant Message Filter
```typescript
for await (const msg of sdkSession.receive()) {
  if (msg.type === 'assistant') {
    // ...
  }
}
```

### ✅ Summary Null Check
```typescript
if (summary) {
  // store summary
}
```

---

## Summary

**Lines to remove:** ~60-70
**Conditionals to remove:** 8
**Features to remove:** Token tracking (not in canonical pattern)
**Dead code to remove:** findClaudeExecutable()

**After cleanup:**
- Code matches canonical examples exactly
- No defensive programming
- Fails fast on unexpected data
- ~20% shorter
