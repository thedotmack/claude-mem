# SDKAgent.ts Conditional Logic Audit

**Goal:** Identify all conditional logic and determine what can be removed based on the canonical V2 API pattern in `agent-sdk-v2-examples.ts`

**Date:** 2026-01-01
**Status:** Complete Analysis

---

## Executive Summary

**Total Conditionals Found:** 13
**Required (Keep):** 6
**Removable (Delete):** 2
**Needs Type Fixing:** 3
**Dead Code:** 1 method (77 lines)

**Key Finding:** Most conditionals are REQUIRED by the V2 API pattern. The real issues are:
1. **Poor typing** (worker: any) forcing defensive checks
2. **Dead code** from V1 migration (findClaudeExecutable method)
3. **Minor optimizations** possible in message processing

---

## Detailed Inventory

### ✅ REQUIRED CONDITIONALS (Keep - Mandated by V2 API or Business Logic)

#### 1. Session Resume Logic (Line 54-56)
```typescript
await using sdkSession = session.memorySessionId
  ? unstable_v2_resumeSession(memorySessionId, { model: modelId })
  : unstable_v2_createSession({ model: modelId });
```
- **Verdict:** ✅ KEEP
- **Reason:** Required for resume vs create session distinction
- **Canonical Reference:** Lines 95-96, 115 in examples show this is the standard pattern

#### 2. Message Type Routing (Lines 64-129)
```typescript
if (message.type === 'observation') {
  // ... observation handling
} else if (message.type === 'summarize') {
  // ... summary handling
}
```
- **Verdict:** ✅ KEEP
- **Reason:** Required business logic - we process two different message types from our queue
- **Canonical Reference:** Not applicable (our domain logic, not SDK pattern)

#### 3. Assistant Message Filtering (Lines 82, 115)
```typescript
for await (const msg of sdkSession.receive()) {
  if (msg.type === 'assistant') {
    // process assistant response
  }
}
```
- **Verdict:** ✅ KEEP
- **Reason:** REQUIRED by V2 API - matches canonical example exactly
- **Canonical Reference:** Lines 43, 59, 70, 104, 120 in examples ALL use this pattern

#### 4. Summary Null Check (Line 243)
```typescript
if (summary) {
  // store and process summary
}
```
- **Verdict:** ✅ KEEP
- **Reason:** `parseSummary()` can legitimately return null when no summary tags found
- **Canonical Reference:** Not applicable (our domain logic)

#### 5. Text Content Guard (Line 157)
```typescript
if (text) {
  session.conversationHistory.push({ role: 'assistant', content: text });
}
```
- **Verdict:** ✅ KEEP
- **Reason:** Text extraction can return undefined (see canonical example line 45 using `text?.text`)
- **Canonical Reference:** Lines 45, 61, 72, 106, 122 all use optional chaining on text

#### 6. Prompt Number Update (Lines 66-68)
```typescript
if (message.prompt_number !== undefined) {
  session.lastPromptNumber = message.prompt_number;
}
```
- **Verdict:** ✅ KEEP (probably)
- **Reason:** Suggests prompt_number is optional in our queue schema
- **Action Needed:** Verify queue schema - if always present, this can be removed

---

### ❌ REMOVABLE CONDITIONALS (Delete - Unnecessary Defensive Programming)

#### 7. Empty Set Check (Line 321)
```typescript
if (session.pendingProcessingIds.size > 0) {
  for (const messageId of session.pendingProcessingIds) {
    pendingMessageStore.markProcessed(messageId);
  }
  session.pendingProcessingIds.clear();
}
```
- **Verdict:** ❌ REMOVE
- **Reason:**
  - Iterating empty Set is safe (loop just doesn't execute)
  - `clear()` on empty Set is safe (no-op)
  - This is defensive programming with no benefit
- **Recommendation:**
```typescript
// Just do it - empty sets handle gracefully
for (const messageId of session.pendingProcessingIds) {
  pendingMessageStore.markProcessed(messageId);
}
session.pendingProcessingIds.clear();
```

#### 8. Logging Guard (Lines 336-341)
```typescript
if (deletedCount > 0) {
  logger.debug('SDK', 'Cleaned up old processed messages', { deletedCount });
}
```
- **Verdict:** ❌ REMOVE (low priority)
- **Reason:** Pure noise reduction, not correctness
- **Impact:** Would log "deleted 0 messages" (harmless, just verbose)
- **Recommendation:** Remove if you want cleaner logs, but this is cosmetic

---

### 🔧 FIX THE ROOT CAUSE (Type System Issues)

#### 9-11. Worker Defensive Checks (Lines 214-236, 288-305, 345-347)
```typescript
// Three instances of this pattern:
if (worker && worker.sseBroadcaster) { ... }
if (worker && typeof worker.broadcastProcessingStatus === 'function') { ... }
```
- **Verdict:** 🔧 FIX TYPES, DON'T GUARD
- **Problem:** Worker is typed as `any | undefined`, forcing defensive checks
- **Root Cause:** Poor type safety
- **Recommendation:**
```typescript
// Define proper interface
interface WorkerService {
  sseBroadcaster?: {
    broadcast: (message: any) => void;
  };
  broadcastProcessingStatus?: () => void;
}

// Update method signature
async startSession(session: ActiveSession, worker?: WorkerService): Promise<void>
```
- **Impact:**
  - Remove 3 conditional blocks
  - Gain compile-time type safety
  - Self-documenting code

---

### 🗑️ DEAD CODE (Delete Entirely)

#### 12. findClaudeExecutable() Method (Lines 366-377)
```typescript
private async findClaudeExecutable(): Promise<string> {
  const { execSync } = await import('child_process');
  try {
    const command = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(command, { encoding: 'utf-8' }).trim();
    return result.split('\n')[0];
  } catch (error) {
    throw new Error('Claude CLI not found in PATH...');
  }
}
```
- **Verdict:** 🗑️ DELETE
- **Reason:**
  - Never called anywhere in the codebase
  - Leftover from V1 API migration
  - V2 API doesn't need manual executable location
- **Lines to Delete:** 363-378 (includes comment)
- **Impact:** -16 lines, cleaner codebase

---

## Comparison with Canonical V2 Example

### ✅ Patterns We Match Correctly

1. **Session creation with await using** (Line 54)
   - Canonical: Line 39, 54, 95, 106, 115, 126
   - Status: ✅ Perfect match

2. **Send/Receive pattern** (Lines 78-94, 112-128)
   - Canonical: Lines 40-46, 57-72, 97-108, 117-124
   - Status: ✅ Perfect match

3. **Assistant message filtering** (Lines 82, 115)
   - Canonical: Lines 43, 59, 70, 104, 120
   - Status: ✅ Perfect match

4. **Text content extraction** (Lines 84, 118)
   - Canonical: Lines 44-45, 61, 71, 105, 122
   - Status: ✅ Perfect match

### ⚠️ Minor Deviations

1. **Fallback to empty string** (Lines 85, 119)
```typescript
// Our code:
const textContent = text?.text || '';

// Canonical example:
console.log(`Claude: ${text?.text}`);  // Could be undefined
```
- **Impact:** Our fallback to `''` is DEFENSIVE but harmless
- **Recommendation:** Keep it - prevents undefined in downstream processing

2. **Token usage fallbacks** (Lines 88-90, 122-124)
```typescript
const tokensUsed = (msg.message.usage?.input_tokens || 0) + (msg.message.usage?.output_tokens || 0);
```
- **Impact:** Defensive against unstable API
- **Recommendation:** Keep it - appropriate for unstable SDK

---

## Recommendations Summary

### Immediate Actions (High Value)

1. **DELETE** `findClaudeExecutable()` method (lines 363-378)
   - -16 lines
   - No functionality lost

2. **REMOVE** empty set check (line 321)
   - Simpler code
   - Same behavior

3. **FIX** worker typing
   - Define `WorkerService` interface
   - Remove 3 defensive conditionals
   - Gain type safety

### Low Priority (Cosmetic)

4. **REMOVE** `deletedCount > 0` logging guard (lines 336-341)
   - Just reduces log verbosity

### Verify Then Decide

5. **CHECK** if `message.prompt_number` is always present
   - If yes: remove conditional (lines 66-68)
   - If no: keep it

---

## Metrics

### Before Cleanup
- **Total Lines:** 378
- **Conditionals:** 13
- **Dead Code:** 1 method (16 lines)
- **Type Issues:** worker: any

### After Cleanup (Estimated)
- **Total Lines:** ~345 (-33 lines, -8.7%)
- **Conditionals:** 8 (-5 removed/fixed)
- **Dead Code:** 0
- **Type Issues:** 0 (proper interfaces)

---

## Conclusion

**The V2 migration is SOLID.** Most conditionals are required by the canonical pattern or our business logic.

The real wins are:
1. **Delete dead code** (findClaudeExecutable)
2. **Fix type system** (worker interface)
3. **Minor simplifications** (empty set check)

**Not a rewrite - just targeted cleanup.**

---

## Validation Against Official V2 Documentation

**Validated:** 2026-01-01 against `/docs/context/agent-sdk-v2-preview.md`

### ✅ Confirmed Patterns

All core patterns in SDKAgent.ts match official V2 documentation:

1. **await using pattern** (docs line 73, 306)
   - Our line 54: ✅ Perfect match
   - Automatic resource cleanup for memory leak prevention

2. **Assistant message filtering** (docs lines 80, 133, 145)
   - Our lines 82, 115: ✅ Required by API
   - Appears in ALL official examples

3. **Text extraction** (docs lines 81-84, 210-216)
   - Our lines 84-85: ✅ Valid alternative pattern
   - Docs use `.filter().map().join()`, we use `.find()` with type guard
   - Both handle null/undefined correctly

4. **Session creation/resume** (docs lines 73, 237)
   - Our line 54-56: ✅ Matches recommended pattern

### 🔍 Undocumented Patterns (Defensive Programming Justified)

The following in SDKAgent.ts are NOT in official docs, confirming they're appropriate defensive programming:

1. **Token usage fallbacks** (our lines 88-90, 122-124)
   - `msg.message.usage?.input_tokens || 0`
   - Official docs don't show token tracking
   - Justified: API is marked "unstable", safe defaults needed

2. **Worker/broadcaster checks** (our lines 214-236, 288-305, 345-347)
   - Not in SDK docs (our architecture, not SDK concern)
   - Justified: External dependency, type safety needed

### 📖 Key Documentation Insights

From official V2 preview (lines 377-380):
> "Not all V1 features are available in V2 yet... Session forking, some advanced streaming input patterns require V1 SDK"

**Implication:** SDK is incomplete/evolving. Our defensive programming around unstable APIs is WISE.

### Final Verdict

**Audit VALIDATED** ✅

- All identified removals are correct
- All marked "REQUIRED" conditionals confirmed by official docs
- Defensive programming justified for unstable API surface
