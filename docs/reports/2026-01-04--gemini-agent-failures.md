# GeminiAgent Test Failures Analysis Report

**Date:** 2026-01-04
**Category:** GeminiAgent Tests
**Total Failures:** 6 of 6 tests
**Status:** Critical - All tests failing

---

## 1. Executive Summary

All 6 GeminiAgent tests are failing due to a combination of:

1. **Missing session data** - Test fixtures lack required `memorySessionId` field
2. **Mock module scoping issues** - `SettingsDefaultsManager` mocks not applying correctly
3. **Global fetch not being mocked** - Real API calls being made in some tests
4. **Async expectation syntax** - Incorrect usage of `rejects.toThrow()` pattern

The primary root cause is that the test session fixtures are incomplete. The `ActiveSession` type requires `memorySessionId` to be set before observations can be stored, but all test sessions set it to undefined/missing, triggering the validation error: "Cannot store observations: memorySessionId not yet captured".

---

## 2. Test Analysis

### Test 1: "should initialize with correct config"
**Status:** FAIL
**Expected Behavior:** Initialize GeminiAgent, make API call with correct URL containing model and API key
**Actual Result:** Error - "Cannot store observations: memorySessionId not yet captured"
**Root Cause:** Test session fixture missing `memorySessionId` field

### Test 2: "should handle multi-turn conversation"
**Status:** FAIL (Timeout after 5001ms)
**Expected Behavior:** Handle conversation history and send correct multi-turn format to Gemini
**Actual Result:** Test times out
**Root Cause:** Likely hanging on unresolved Promise due to mock issues. The mock fetch returns a response without valid observation XML, causing `processAgentResponse` to fail before completing.

### Test 3: "should process observations and store them"
**Status:** FAIL
**Expected Behavior:** Parse observation XML from Gemini response, call `storeObservation` and `syncObservation`
**Actual Result:** Error - "Cannot store observations: memorySessionId not yet captured"
**Root Cause:** Test session fixture missing `memorySessionId` field

### Test 4: "should fallback to Claude on rate limit error"
**Status:** FAIL
**Expected Behavior:** When Gemini returns 429, reset stuck messages and call fallback agent
**Actual Result:** Real API call made - "Gemini API error: 400 - API key not valid"
**Root Cause:**
- `mock.module()` for SettingsDefaultsManager not scoping correctly
- Real `fetch` is called instead of mock because the mock is set AFTER agent initialization
- Test mock key `'test-api-key'` is being used against real Gemini API

### Test 5: "should NOT fallback on other errors"
**Status:** FAIL (Timeout after 5001ms)
**Expected Behavior:** When Gemini returns 400, throw error without calling fallback
**Actual Result:** Times out, then throws assertion error with wrong message
**Root Cause:**
- Incorrect async expectation pattern: `expect(agent.startSession(session)).rejects.toThrow()` should be `await expect(agent.startSession(session)).rejects.toThrow()`
- The missing `await` causes the test to not wait for rejection, timing out instead

### Test 6: "should respect rate limits when billing disabled"
**Status:** FAIL
**Expected Behavior:** When `CLAUDE_MEM_GEMINI_BILLING_ENABLED` is 'false', enforce rate limiting via setTimeout
**Actual Result:** Error - "Cannot store observations: memorySessionId not yet captured"
**Root Cause:**
- Test session fixture missing `memorySessionId` field
- Rate limiting test never reaches the code path because session validation fails first

---

## 3. Current Implementation Status

### GeminiAgent.ts
- Located at: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/GeminiAgent.ts`
- Uses shared `processAgentResponse()` from ResponseProcessor module
- Properly validates `memorySessionId` before storage (line 71 in ResponseProcessor.ts)

### ResponseProcessor.ts
- Located at: `/Users/alexnewman/Scripts/claude-mem/src/services/worker/agents/ResponseProcessor.ts`
- Contains strict validation at lines 70-73:
  ```typescript
  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }
  ```

### FallbackErrorHandler.ts
- Contains `FALLBACK_ERROR_PATTERNS` that trigger Claude fallback: `['429', '500', '502', '503', 'ECONNREFUSED', 'ETIMEDOUT', 'fetch failed']`
- 400 errors are intentionally NOT in this list (should throw, not fallback)

---

## 4. Root Cause Analysis

### 4.1 Session Fixture Incomplete

**All test sessions are missing `memorySessionId`:**

```typescript
const session = {
  sessionDbId: 1,
  claudeSessionId: 'test-session',  // Wrong field name
  sdkSessionId: 'test-sdk',         // Wrong field name
  // ... other fields
} as any;  // Type assertion masks the error
```

The `ActiveSession` type defines:
- `contentSessionId: string` (user's Claude Code session)
- `memorySessionId: string | null` (memory agent's session ID)

But tests use:
- `claudeSessionId` (deprecated name)
- `sdkSessionId` (deprecated name)
- No `memorySessionId` field at all

### 4.2 Mock Module Scoping

The `mock.module()` call appears before imports but may not be correctly intercepting:

```typescript
mock.module('../src/shared/SettingsDefaultsManager', () => ({...}));
```

Evidence: Test 4 makes a real API call to Gemini with the mock API key `'test-api-key'`, receiving:
```
"message": "API key not valid. Please pass a valid API key."
```

This indicates `getGeminiConfig()` is reading the mock settings, but `global.fetch` is not being mocked before the agent initialization.

### 4.3 Async Assertion Syntax Error

Test 5 uses incorrect async rejection pattern:

```typescript
// WRONG - missing await
expect(agent.startSession(session)).rejects.toThrow('Gemini API error: 400 - Invalid argument');

// CORRECT
await expect(agent.startSession(session)).rejects.toThrow('Gemini API error: 400 - Invalid argument');
```

Without `await`, the test continues and times out instead of catching the rejection.

### 4.4 Mock Ordering Issue

The `global.fetch` mock is set AFTER agent construction in `beforeEach`:

```typescript
beforeEach(() => {
  // ... mock setup
  agent = new GeminiAgent(mockDbManager, mockSessionManager);
  originalFetch = global.fetch;  // Save original
});
```

But tests set the fetch mock in the test body AFTER agent exists. While this should work for the API call, the timing may cause race conditions.

---

## 5. Recommended Fixes

### 5.1 Fix Session Fixtures (Priority: HIGH, Effort: LOW)

Add `memorySessionId` and use correct field names in all test sessions:

```typescript
const session = {
  sessionDbId: 1,
  contentSessionId: 'test-session',     // Correct field name
  memorySessionId: 'mem-session-123',   // REQUIRED - add this
  project: 'test-project',
  userPrompt: 'test prompt',
  conversationHistory: [],
  lastPromptNumber: 1,
  cumulativeInputTokens: 0,
  cumulativeOutputTokens: 0,
  pendingProcessingIds: new Set(),
  pendingMessages: [],                   // Add missing field
  abortController: new AbortController(), // Add missing field
  generatorPromise: null,                // Add missing field
  earliestPendingTimestamp: null,        // Add missing field
  currentProvider: null,                 // Add missing field
  startTime: Date.now()
} satisfies ActiveSession;  // Use satisfies instead of 'as any'
```

### 5.2 Fix Mock Module Path (Priority: HIGH, Effort: LOW)

The mock path may be incorrect. Test imports use:
```typescript
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';
```

But the agent imports:
```typescript
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
```

Consider creating a shared test fixture or using dependency injection.

### 5.3 Fix Async Assertion (Priority: MEDIUM, Effort: LOW)

In test 5 "should NOT fallback on other errors":

```typescript
// Change from:
expect(agent.startSession(session)).rejects.toThrow('Gemini API error: 400 - Invalid argument');

// To:
await expect(agent.startSession(session)).rejects.toThrow('Gemini API error: 400');
```

### 5.4 Move Fetch Mock to beforeEach (Priority: MEDIUM, Effort: LOW)

Set default mock in beforeEach, override in specific tests:

```typescript
beforeEach(() => {
  originalFetch = global.fetch;

  // Default successful mock
  global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '<observation><type>discovery</type><title>Test</title></observation>' }] } }],
    usageMetadata: { totalTokenCount: 100 }
  }))));

  // ... rest of setup
});
```

### 5.5 Add Logger Mock (Priority: LOW, Effort: LOW)

The logger is trying to load settings during test execution:

```
TypeError: undefined is not an object (evaluating 'SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_LOG_LEVEL.toUpperCase')
```

Mock the logger or extend SettingsDefaultsManager mock to handle `get()` calls:

```typescript
mock.module('../src/shared/SettingsDefaultsManager', () => ({
  SettingsDefaultsManager: {
    loadFromFile: () => ({
      CLAUDE_MEM_GEMINI_API_KEY: 'test-api-key',
      CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
      CLAUDE_MEM_GEMINI_BILLING_ENABLED: billingEnabled,
      CLAUDE_MEM_LOG_LEVEL: 'INFO',  // Add this
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true'  // Add this
    }),
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_LOG_LEVEL') return 'INFO';
      if (key === 'CLAUDE_MEM_DATA_DIR') return '/tmp/test-claude-mem';
      return '';
    }
  }
}));
```

---

## 6. Priority/Effort Matrix

| Fix | Priority | Effort | Impact |
|-----|----------|--------|--------|
| 5.1 Add memorySessionId to fixtures | HIGH | LOW | Fixes 4/6 tests immediately |
| 5.2 Fix mock module path | HIGH | LOW | Ensures mocks apply correctly |
| 5.3 Fix async assertion syntax | MEDIUM | LOW | Fixes test 5 timeout |
| 5.4 Move fetch mock to beforeEach | MEDIUM | LOW | Prevents race conditions |
| 5.5 Add logger mock | LOW | LOW | Cleaner test output |

### Recommended Order of Implementation:

1. **Fix session fixtures** (5.1) - This alone will likely fix tests 1, 3, and 6
2. **Fix async assertion** (5.3) - Will fix test 5 timeout
3. **Add logger mock** (5.5) - Prevents spurious errors in test output
4. **Fix mock module path** (5.2) - May fix test 4 if mocks aren't applying
5. **Move fetch mock** (5.4) - Prevents future flakiness

---

## 7. Appendix: Full Error Output

### Test 1 Error:
```
error: Cannot store observations: memorySessionId not yet captured
      at processAgentResponse (ResponseProcessor.ts:72:11)
```

### Test 4 Error:
```
error: Gemini API error: 400 - {
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT"
  }
}
```

### Test 5 Error:
```
error: Test "should NOT fallback on other errors" timed out after 5001ms
Expected substring: "Gemini API error: 400 - Invalid argument"
Received message: "Gemini API error: 400 - {...API key not valid...}"
```

---

## 8. Related Files

- `/Users/alexnewman/Scripts/claude-mem/tests/gemini_agent.test.ts` - Test file
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/GeminiAgent.ts` - Implementation
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/agents/ResponseProcessor.ts` - Shared processor
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker/agents/FallbackErrorHandler.ts` - Fallback logic
- `/Users/alexnewman/Scripts/claude-mem/src/services/worker-types.ts` - ActiveSession type definition
