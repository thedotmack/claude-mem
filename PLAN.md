# Plan: Address PR #856 Review Feedback

## Summary of Review Feedback

Multiple reviewers identified the same core issues:

1. **Race Condition in Idle Detection** (Medium-High Priority)
   - When timeout fires at 3:00 but last message was at 2:59, `idleDuration` is 1 second, check fails
   - Need to either remove redundant check or reset `lastActivityTime` on timeout

2. **Missing Test Coverage** (High Priority)
   - No tests for SessionQueueProcessor timeout logic
   - Critical fix for high-impact bug (79 processes, 13.4GB swap)

3. **Minor: Optional Chaining** (Low Priority)
   - Use `onIdleTimeout?.()` instead of `if (onIdleTimeout) { onIdleTimeout() }`

4. **Minor: Logging Enhancement** (Low Priority)
   - Add timeout threshold to log message for debugging

---

## Phase 0: Documentation Discovery (COMPLETE)

### Sources Consulted
- PR #856 comments from claude, greptile-apps reviewers
- `src/services/queue/SessionQueueProcessor.ts` (current implementation)

### Allowed APIs
- `waitForMessage(signal, timeoutMs)` → Promise<boolean>
- `logger.info('SESSION', ...)` for logging

### The Fix Strategy

The reviewers suggest two options:

**Option A**: Remove redundant check since `waitForMessage` enforces timeout
```typescript
if (!receivedMessage && !signal.aborted) {
  // Timeout occurred - exit gracefully
  const idleDuration = Date.now() - lastActivityTime;
  logger.info('SESSION', 'Exiting queue iterator due to idle timeout', { ... });
  onIdleTimeout?.();
  return;
}
```

**Option B**: Reset `lastActivityTime` on timeout to handle edge cases
```typescript
if (!receivedMessage && !signal.aborted) {
  const idleDuration = Date.now() - lastActivityTime;
  if (idleDuration >= IDLE_TIMEOUT_MS) {
    logger.info('SESSION', 'Exiting...', { ... });
    onIdleTimeout?.();
    return;
  }
  // CRITICAL: Reset timer since we know queue is empty now
  lastActivityTime = Date.now();
}
```

**Decision**: Use Option B - it's defensive and handles spurious wakeups correctly.

---

## Phase 1: Fix Race Condition in SessionQueueProcessor

### What to Implement
Fix the idle timeout logic to reset `lastActivityTime` when timeout occurs but duration check fails.

### Tasks
1. In `createIterator()` at lines 50-62, add `lastActivityTime = Date.now()` after the duration check fails
2. Use optional chaining for `onIdleTimeout?.()`
3. Add timeout threshold to log message

### Pattern to Follow
```typescript
if (!receivedMessage && !signal.aborted) {
  const idleDuration = Date.now() - lastActivityTime;
  if (idleDuration >= IDLE_TIMEOUT_MS) {
    logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
      sessionDbId,
      idleDurationMs: idleDuration,
      thresholdMs: IDLE_TIMEOUT_MS
    });
    onIdleTimeout?.();
    return;
  }
  // Reset timer on spurious wakeup - queue is empty but duration check failed
  lastActivityTime = Date.now();
}
```

### Verification
```bash
npm run build
grep -A10 "idleDuration >= IDLE_TIMEOUT_MS" src/services/queue/SessionQueueProcessor.ts
```

---

## Phase 2: Add Unit Tests for SessionQueueProcessor

### What to Implement
Create test file covering the idle timeout behavior.

### Test Cases Required
1. Iterator exits after idle timeout when no messages arrive
2. `onIdleTimeout` callback is invoked on timeout
3. Message arrival resets the idle timer
4. Abort signal takes precedence over timeout
5. Event listener cleanup happens correctly

### Location
`tests/services/queue/SessionQueueProcessor.test.ts`

### Verification
```bash
npm run test -- SessionQueueProcessor
```

---

## Phase 3: Build and Verify

### Tasks
1. Run `npm run build` - verify no TypeScript errors
2. Run tests to ensure timeout behavior works
3. Commit changes to fix/observer-idle-timeout branch
4. Push to update PR #856

### Verification
```bash
npm run build
npm run test
git diff --stat
```

---

## Phase 4: Update PR Description

### Tasks
1. Update test plan checkboxes in PR description
2. Add note about race condition fix

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/services/queue/SessionQueueProcessor.ts` | Fix race condition, optional chaining, enhanced logging |
| `tests/services/queue/SessionQueueProcessor.test.ts` | New test file for timeout behavior |
