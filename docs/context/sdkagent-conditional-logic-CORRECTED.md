# SDKAgent.ts Conditional Logic Audit (CORRECTED)

**Goal:** Remove ALL conditional logic not present in the canonical V2 API examples

**Principle:** TRUST THE CANONICAL EXAMPLE. Don't add defensive code. Fail fast.

---

## The Problem With My Original Analysis

I justified defensive programming as "appropriate for unstable APIs" - **THIS IS WRONG**.

The canonical examples show the CORRECT way. If they don't have defensive checks, **WE SHOULDN'T EITHER**.

---

## ALL DEFENSIVE CODE TO REMOVE

### 1. Text Content Fallback (Lines 85, 119) ❌

**Current (WRONG):**
```typescript
const text = msg.message.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
const textContent = text?.text || '';
```

**Canonical example:**
```typescript
const text = msg.message.content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
console.log(`Claude: ${text?.text}`);  // <- undefined is FINE
```

**Fix:**
```typescript
const textContent = text?.text;  // Remove || ''
```

**Why:** If text is undefined, pass undefined downstream. Don't mask it.

---

### 2. Token Usage Fallbacks (Lines 88-90, 122-124) ❌

**Current (WRONG):**
```typescript
const tokensUsed = (msg.message.usage?.input_tokens || 0) + (msg.message.usage?.output_tokens || 0);
session.cumulativeInputTokens += msg.message.usage?.input_tokens || 0;
session.cumulativeOutputTokens += msg.message.usage?.output_tokens || 0;
```

**What canonical example would do:**
```typescript
const tokensUsed = msg.message.usage.input_tokens + msg.message.usage.output_tokens;
session.cumulativeInputTokens += msg.message.usage.input_tokens;
session.cumulativeOutputTokens += msg.message.usage.output_tokens;
```

**Why:** If usage is undefined, it SHOULD crash. That's a bug in the SDK or our understanding. Don't hide it with `|| 0`.

---

### 3. Text Content Guard (Lines 157-159) ❌

**Current (WRONG):**
```typescript
if (text) {
  session.conversationHistory.push({ role: 'assistant', content: text });
}
```

**Fix:**
```typescript
session.conversationHistory.push({ role: 'assistant', content: text });
```

**Why:** Empty/undefined responses are valid. Just push them. If downstream breaks, fix downstream.

---

### 4. Worker Defensive Checks (Lines 214-236, 288-305, 345-347) ❌

**Current (WRONG):**
```typescript
if (worker && worker.sseBroadcaster) {
  worker.sseBroadcaster.broadcast(...);
}

if (worker && typeof worker.broadcastProcessingStatus === 'function') {
  worker.broadcastProcessingStatus();
}
```

**Two options:**

**Option A - Worker is required:**
```typescript
interface WorkerService {
  sseBroadcaster: { broadcast: (msg: any) => void };
  broadcastProcessingStatus: () => void;
}

// Type parameter as required
async startSession(session: ActiveSession, worker: WorkerService)
```

**Option B - Worker is optional (but methods handle it):**
```typescript
// Just call it, let it handle undefined
worker?.sseBroadcaster?.broadcast(...);
worker?.broadcastProcessingStatus?.();
```

**Why:** Stop guarding. Either require it (Option A) or use optional chaining (Option B). Don't use `if` blocks with type checks.

---

### 5. Empty Set Check (Line 321) ❌

**Current (WRONG):**
```typescript
if (session.pendingProcessingIds.size > 0) {
  for (const messageId of session.pendingProcessingIds) {
    pendingMessageStore.markProcessed(messageId);
  }
  session.pendingProcessingIds.clear();
}
```

**Fix:**
```typescript
for (const messageId of session.pendingProcessingIds) {
  pendingMessageStore.markProcessed(messageId);
}
session.pendingProcessingIds.clear();
```

**Why:** Iterating empty Sets is safe. Clearing empty Sets is safe. No check needed.

---

### 6. Logging Guard (Lines 336-341) ❌

**Current (WRONG):**
```typescript
if (deletedCount > 0) {
  logger.debug('SDK', 'Cleaned up old processed messages', { deletedCount });
}
```

**Fix:**
```typescript
logger.debug('SDK', 'Cleaned up old processed messages', { deletedCount });
```

**Why:** Logging "deleted 0 messages" is fine. Don't guard logs.

---

### 7. Prompt Number Guard (Lines 66-68) ⚠️

**Current:**
```typescript
if (message.prompt_number !== undefined) {
  session.lastPromptNumber = message.prompt_number;
}
```

**Action needed:**
1. Check queue schema - is prompt_number ALWAYS present for observations?
2. If YES: Remove the check
3. If NO: Let it crash and fix the schema

**Why:** Don't guard against "maybe undefined". Either it's always there, or fix the code that creates messages without it.

---

### 8. Summary Null Check (Line 243) ✅

**Current:**
```typescript
if (summary) {
  // store and process
}
```

**Keep this one ONLY IF:**
- parseSummary() legitimately returns null when no summary tags found
- This is expected behavior, not an error case

**Why:** This is the ONLY acceptable conditional - when null is a valid business outcome (no summary to parse).

---

### 9. Message Type Routing (Lines 64-129) ✅

**Current:**
```typescript
if (message.type === 'observation') {
  // ...
} else if (message.type === 'summarize') {
  // ...
}
```

**Verdict:** ✅ KEEP

**Why:** This is business logic routing, not defensive programming.

---

### 10. Assistant Message Filtering (Lines 82, 115) ✅

**Current:**
```typescript
for await (const msg of sdkSession.receive()) {
  if (msg.type === 'assistant') {
    // process
  }
}
```

**Verdict:** ✅ KEEP

**Why:** Required by V2 API pattern. Every canonical example uses this.

---

### 11. Dead Code (Lines 363-378) 🗑️

**findClaudeExecutable() method**

**Verdict:** 🗑️ DELETE ENTIRELY

**Why:** Never called. Leftover from V1. Gone.

---

## Summary of Changes

### REMOVE (Stop defending, start trusting):
1. `|| ''` fallback → Use `text?.text` directly
2. `|| 0` token fallbacks → Use `msg.message.usage.input_tokens` directly
3. `if (text)` guard → Just push to array
4. `if (worker && ...)` guards → Fix types or use optional chaining
5. `if (size > 0)` → Just iterate
6. `if (deletedCount > 0)` → Just log
7. Verify `if (prompt_number !== undefined)` → Probably remove

### KEEP (Required by API or business logic):
- `if (msg.type === 'assistant')` ✅
- `if (message.type === 'observation')` / `else if (...'summarize')` ✅
- `if (summary)` ✅ (if null is valid outcome)

### DELETE:
- `findClaudeExecutable()` method 🗑️

---

## The Mindset Shift

**WRONG:** "The API is unstable, so defensive programming is wise"

**RIGHT:** "Trust the canonical example. If it breaks, it SHOULD break loudly."

**WRONG:** "It's not documented, so I'll add safety checks"

**RIGHT:** "It's not in the example, so I'll REMOVE my checks"

**WRONG:** "What if this is undefined?"

**RIGHT:** "If it's undefined when it shouldn't be, I WANT to know immediately"

---

## Fail Fast Principle

If the SDK returns unexpected data:
- ❌ Don't mask it with `|| 0` or `|| ''`
- ✅ Let it crash
- ✅ Fix the root cause or file a bug

If worker is undefined:
- ❌ Don't guard every call with `if (worker && ...)`
- ✅ Type it properly or use optional chaining
- ✅ If it should always exist, make it required

---

## Estimated Impact

**Lines removed:** ~40-50 lines of defensive code
**Conditionals removed:** 7-8 defensive guards
**Type safety gained:** Worker interface definition
**Clarity gained:** Code matches canonical pattern exactly

**Not just cleanup - this is embracing simplicity and trust.**
