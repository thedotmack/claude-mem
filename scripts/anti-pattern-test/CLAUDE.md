# Error Handling Anti-Pattern Rules

This folder contains `detect-error-handling-antipatterns.ts` - run it before committing any error handling changes.

## The Try-Catch Problem That Cost 10 Hours

A single overly-broad try-catch block wasted 10 hours of debugging time by silently swallowing errors.
**This pattern is BANNED.**

## BEFORE You Write Any Try-Catch

**RUN THIS TEST FIRST:**
```bash
bun run scripts/anti-pattern-test/detect-error-handling-antipatterns.ts
```

**You MUST answer these 5 questions to the user BEFORE writing try-catch:**

1. **What SPECIFIC error am I catching?** (Name the error type: `FileNotFoundError`, `NetworkTimeout`, `ValidationError`)
2. **Show documentation proving this error can occur** (Link to docs or show me the source code)
3. **Why can't this error be prevented?** (If it can be prevented, prevent it instead)
4. **What will the catch block DO?** (Must include logging + either rethrow OR explicit fallback)
5. **Why shouldn't this error propagate?** (Justify swallowing it rather than letting caller handle)

**If you cannot answer ALL 5 questions with specifics, DO NOT write the try-catch.**

## FORBIDDEN PATTERNS (Zero Tolerance)

### CRITICAL - Never Allowed

```typescript
// FORBIDDEN: Empty catch
try {
  doSomething();
} catch {}

// FORBIDDEN: Catch without logging
try {
  doSomething();
} catch (error) {
  return null;  // Silent failure!
}

// FORBIDDEN: Large try blocks (>10 lines)
try {
  // 50 lines of code
  // Multiple operations
  // Different failure modes
} catch (error) {
  logger.error('Something failed');  // Which thing?!
}

// FORBIDDEN: Promise empty catch
promise.catch(() => {});  // Error disappears into void

// FORBIDDEN: Try-catch to fix TypeScript errors
try {
  // @ts-ignore
  const value = response.propertyThatDoesntExist;
} catch {}
```

### ALLOWED Patterns

```typescript
// GOOD: Specific, logged, explicit handling
try {
  await fetch(url);
} catch (error) {
  if (error instanceof NetworkError) {
    logger.warn('SYNC', 'Network request failed, will retry', { url }, error);
    return null;  // Explicit: null means "fetch failed"
  }
  throw error;  // Unexpected errors propagate
}

// GOOD: Minimal scope, clear recovery
try {
  JSON.parse(data);
} catch (error) {
  logger.error('CONFIG', 'Corrupt settings file, using defaults', {}, error);
  return DEFAULT_SETTINGS;
}

// GOOD: Fire-and-forget with logging
backgroundTask()
  .catch(error => logger.warn('BACKGROUND', 'Task failed', {}, error));

// GOOD: Ignored anti-pattern for genuine hot paths only
try {
  checkIfProcessAlive(pid);
} catch (error) {
  // [ANTI-PATTERN IGNORED]: Tight loop checking 100s of PIDs during cleanup
  return false;
}
```

## Ignoring Anti-Patterns (Rare)

**Only for genuine hot paths** where logging would cause performance problems:

```typescript
// [ANTI-PATTERN IGNORED]: Reason why logging is impossible
```

**Rules:**
- **Hot paths only** - code in tight loops called 1000s of times
- If you can add logging, ADD LOGGING - don't ignore
- Valid examples:
  - "Tight loop checking process exit status during cleanup"
  - "Health check polling every 100ms"
- Invalid examples:
  - "Expected JSON parse failures" - Just add logger.debug
  - "Common fallback path" - Just add logger.debug

## The Meta-Rule

**UNCERTAINTY TRIGGERS RESEARCH, NOT TRY-CATCH**

When you're unsure if a property exists or a method signature is correct:
1. **READ** the source code or documentation
2. **VERIFY** with the Read tool
3. **USE** TypeScript types to catch errors at compile time
4. **WRITE** code you KNOW is correct

Never use try-catch to paper over uncertainty. That wastes hours of debugging time later.

## Critical Path Protection

These files are **NEVER** allowed to have catch-and-continue:
- `SDKAgent.ts` - Errors must propagate, not hide
- `GeminiAgent.ts` - Must fail loud, not silent
- `OpenRouterAgent.ts` - Must fail loud, not silent
- `SessionStore.ts` - Database errors must propagate
- `worker-service.ts` - Core service errors must be visible

On critical paths, prefer **NO TRY-CATCH** and let errors propagate naturally.