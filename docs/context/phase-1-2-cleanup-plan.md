# Phase 1 & 2 Cleanup: Delete Stupid Shit

**Date**: 2025-11-17
**Status**: Ready for execution after /clear

## What We're Fixing
Remove ~150 lines of overcomplicated defensive code that violates KISS, DRY, and YAGNI.

## Root Cause
We were searching for tool_use_id by tool NAME instead of using the value that's ALWAYS in hook input, causing UNIQUE constraint violations when multiple uses of the same tool occurred.

---

## Changes

### 1. **DELETE getLatestToolUseId() entirely**
**File**: `src/hooks/save-hook.ts:38-74`

**Current (STUPID)**:
```typescript
function getLatestToolUseId(transcriptPath: string, toolName: string): string | null {
  // 37 lines of file I/O, parsing, iteration, searching by tool NAME
  // Returns WRONG ID when same tool used multiple times
}

// Line 298:
const toolUseId = input.tool_use_id || getLatestToolUseId(transcript_path, tool_name);
```

**What to do**:
- Delete entire function (lines 38-74)
- Change line 298 to: `const toolUseId = input.tool_use_id;`

**Why**: tool_use_id is ALWAYS in PostToolUseInput from Claude Code. We're searching for something we already have.

---

### 2. **Extract array parsing to DRY helper**
**File**: `src/hooks/save-hook.ts:95-145`

**Current (STUPID)**: 50+ lines of copy-pasted try-catch for facts, concepts, files_read, files_modified

**What to do**:
```typescript
// Add helper function:
function parseArrayField(field: any, fieldName: string): string[] {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  try {
    const parsed = JSON.parse(field);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    silentDebug(`[save-hook] Failed to parse ${fieldName}`, { field, error: e }, []);
    return [];
  }
}

// Replace 4 copy-pasted blocks with:
const factsArray = parseArrayField(obs.facts, 'facts');
const conceptsArray = parseArrayField(obs.concepts, 'concepts');
const filesRead = parseArrayField(obs.files_read, 'files_read');
const filesModified = parseArrayField(obs.files_modified, 'files_modified');
```

**Why**: DRY violation. Same logic repeated 4 times.

---

### 3. **Fail fast on malformed transcript lines**
**File**: `src/hooks/save-hook.ts:222-225`

**Current (STUPID)**:
```typescript
} catch (parseError) {
  // Return malformed lines as-is
  return line;
}
```

**What to do**:
```typescript
} catch (parseError) {
  silentDebug('[save-hook] Malformed JSONL line in transcript', {
    lineIndex: i,
    error: parseError
  });
  throw new Error(`Malformed JSONL line at index ${i}: ${parseError.message}`);
}
```

**Why**: Silent errors hide transcript corruption. Fail fast and let outer try-catch rollback (already exists at lines 260-266).

---

### 4. **Simplify pendingObservationResolvers type**
**File**: `src/services/worker-types.ts:25`

**Current (STUPID)**:
```typescript
pendingObservationResolvers: Map<string, {
  resolve: (observation: any) => void,
  reject: (error: Error) => void
}>;
```

**What to do**:
```typescript
pendingObservationResolvers: Map<string, (observation: any) => void>;
```

**Why**: We NEVER call reject(). Only resolve() is used. YAGNI violation.

---

### 5. **Fix redundant Map checks**
**File**: `src/services/worker/SDKAgent.ts:286-288`

**Current (STUPID)**:
```typescript
if (session.currentToolUseId && session.pendingObservationResolvers.has(session.currentToolUseId)) {
  const resolver = session.pendingObservationResolvers.get(session.currentToolUseId)!;
  // ... use resolver
}
```

**What to do**:
```typescript
if (session.currentToolUseId) {
  const resolver = session.pendingObservationResolvers.get(session.currentToolUseId);
  if (resolver) {
    session.pendingObservationResolvers.delete(session.currentToolUseId);
    resolver({
      id: obsId,
      type: obs.type,
      // ... rest of observation data
    });
    logger.debug('SDK', 'Resolved pending observation promise', {
      sessionId: session.sessionDbId,
      obsId,
      toolUseId: session.currentToolUseId
    });
  }
}
```

**Why**: Checking .has() then using .get() with non-null assertion is stupid. Just check once.

---

### 6. **Remove unused reject from promise**
**File**: `src/services/worker-service.ts:508-518`

**Current (STUPID)**:
```typescript
const observationPromise = new Promise<any>((resolve, reject) => {
  session.pendingObservationResolvers.set(tool_use_id, { resolve, reject }); // reject NEVER used

  setTimeout(() => {
    if (session.pendingObservationResolvers.has(tool_use_id)) {
      session.pendingObservationResolvers.delete(tool_use_id);
      reject(new Error('Observation creation timeout (90s exceeded)'));
    }
  }, TIMEOUT_MS);
});
```

**What to do**:
```typescript
const observationPromise = new Promise<any>((resolve, reject) => {
  session.pendingObservationResolvers.set(tool_use_id, resolve); // Just store resolve

  setTimeout(() => {
    if (session.pendingObservationResolvers.has(tool_use_id)) {
      session.pendingObservationResolvers.delete(tool_use_id);
      silentDebug('[worker] Observation timeout', {
        sessionId,
        tool_use_id,
        timeoutMs: TIMEOUT_MS
      });
      reject(new Error('Observation creation timeout (90s exceeded)'));
    }
  }, TIMEOUT_MS);
});
```

**Why**: reject stored in Map is NEVER called by SDKAgent. Only local promise reject is used for timeout.

---

### 7. **Remove redundant backup file**
**File**: `src/hooks/save-hook.ts:164-265`

**Current (STUPID)**:
```typescript
// Line 164-165: Create backup
const backupPath = `${transcriptPath}.backup`;
copyFileSync(transcriptPath, backupPath);

// ... transformation ...

// Line 230-232: Delete backup on success
unlinkSync(backupPath);

// Line 251-252: Delete backup after atomic rename
unlinkSync(backupPath);

// Line 263-264: Rollback on error
copyFileSync(backupPath, transcriptPath);
unlinkSync(backupPath);
```

**What to do**:
```typescript
// Just use temp file + atomic rename (no backup needed):

const tempPath = `${transcriptPath}.tmp`;
writeFileSync(tempPath, transformedLines.join('\n') + '\n', 'utf-8');

// Validate JSONL structure
const validatedContent = readFileSync(tempPath, 'utf-8');
const validatedLines = validatedContent.trim().split('\n');
for (const line of validatedLines) {
  if (line.trim()) {
    JSON.parse(line); // Will throw if invalid, caught by outer try-catch
  }
}

// Atomic rename (original untouched until this succeeds)
renameSync(tempPath, transcriptPath);

logger.success('HOOK', 'Transcript transformation complete', {
  toolUseId,
  originalSize,
  compressedSize,
  savings: `${Math.round((1 - compressedSize / originalSize) * 100)}%`
});
```

**Remove outer try-catch rollback** (lines 260-266) - atomic rename IS the safety mechanism.

**Why**: Temp file + atomic rename is sufficient. Backup file is redundant defensive programming.

---

### 8. **Remove inconsistent null check**
**File**: `src/hooks/save-hook.ts:273-275`

**Current (STUPID)**:
```typescript
if (!input) {
  throw new Error('saveHook requires input');
}

const { session_id, cwd, tool_name, tool_input, tool_response, transcript_path } = input;
// Then uses all fields without null checks
```

**What to do**:
Just delete the `if (!input)` check. TypeScript guarantees the type.

**Why**: Half-assed defensive programming. Either check everything or trust the type system. We chose to trust types for individual fields, so trust it for input too.

---

## Expected Results

### Fixes
- ✅ No more UNIQUE constraint errors (using correct tool_use_id)
- ✅ Summaries save correctly (no session crash from duplicate errors)
- ✅ No more DRY violations (helper function)
- ✅ No more silent errors (fail fast with silentDebug)
- ✅ No more unused code (reject function, backup file)

### Metrics
- **~150 lines deleted**
- **~15 lines added** (helper function)
- **Net: -135 lines**
- **Simpler, more maintainable code**

---

## Testing After Cleanup

1. **Build and restart**:
   ```bash
   npm run build && npm run sync-marketplace && npm run worker:restart
   ```

2. **Test duplicate tool uses**:
   - Run same tool multiple times (Bash, Read, etc.)
   - Verify no UNIQUE constraint errors
   - Check worker logs: `npm run worker:logs`

3. **Test summaries**:
   - Complete a session
   - Verify summary is saved to database
   - Query: `sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 1;"`

4. **Test transcript transformation**:
   - Use endless mode with observation compression
   - Verify transcript is valid JSONL
   - Verify compressed observations appear in transcript

5. **Test error handling**:
   - Check for silentDebug output in logs
   - Verify graceful failures (no crashes)

---

## Rollback Plan

If something breaks:
1. `git stash` or `git checkout HEAD -- <file>`
2. `npm run build && npm run sync-marketplace && npm run worker:restart`
3. File issue with reproduction steps

---

## Notes

### Why silentDebug?
- Allows debugging without polluting logs
- Can enable/disable via log level
- Captures error context for troubleshooting
- Provides fallback values for graceful degradation

### Why atomic rename is safe?
- `renameSync()` is atomic on POSIX systems
- Original file untouched until rename succeeds
- If rename fails, original file still intact
- No need for backup file

### Why trust type system?
- TypeScript guarantees types at compile time
- Claude Code hook contract guarantees input shape
- Runtime checks for things that can't be type-checked (malformed JSON, file I/O)
- Don't check for problems that can't happen

---

## Implementation Order

1. Fix #1 (DELETE getLatestToolUseId) - **CRITICAL: Fixes UNIQUE constraint errors**
2. Fix #4, #5, #6 (Simplify Map type) - **Dependencies on each other**
3. Fix #2 (Extract DRY helper) - **Independent**
4. Fix #3 (Fail fast) - **Independent, but easier after #2**
5. Fix #7 (Remove backup) - **Independent**
6. Fix #8 (Remove null check) - **Trivial**
7. Build, test, iterate

---

**Ready to execute after /clear**
