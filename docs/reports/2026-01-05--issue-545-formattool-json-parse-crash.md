# Issue #545: formatTool Crashes on Non-JSON Tool Input Strings

## Summary

**Issue**: `formatTool` method in `src/utils/logger.ts` crashes when `toolInput` is a string that is not valid JSON
**Type**: Bug (Critical - Silent Data Loss)
**Status**: Open
**Author**: @Rob-van-B
**Created**: January 4, 2026

The `formatTool` method unconditionally calls `JSON.parse()` on string inputs without error handling. When tool inputs are raw strings (not JSON), this throws an exception that propagates up the call stack, causing 400 errors for valid observation requests and silently stopping claude-mem from recording tool usage.

## Root Cause Analysis

### Verified Issue Location

**File**: `/Users/alexnewman/Scripts/claude-mem/src/utils/logger.ts`
**Line**: 139
**Method**: `formatTool`

```typescript
formatTool(toolName: string, toolInput?: any): string {
  if (!toolInput) return toolName;

  const input = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput;
  // ... rest of method
}
```

### The Problem

The code assumes that if `toolInput` is a string, it must be valid JSON. This assumption is incorrect. Tool inputs can be:

1. **Already-parsed objects** (no parsing needed)
2. **JSON strings** (need parsing)
3. **Raw strings that are not JSON** (will crash on parse)

When a raw string is passed (e.g., a Bash command like `ls -la`), `JSON.parse("ls -la")` throws:
```
SyntaxError: Unexpected token 'l', "ls -la" is not valid JSON
```

### Existing Correct Pattern in Codebase

The issue is notable because the **correct pattern already exists** in `src/sdk/prompts.ts` (lines 96-102):

```typescript
try {
  toolInput = typeof obs.tool_input === 'string' ? JSON.parse(obs.tool_input) : obs.tool_input;
} catch (error) {
  logger.debug('SDK', 'Tool input is plain string, using as-is', {
    toolName: obs.tool_name
  }, error as Error);
  toolInput = obs.tool_input;
}
```

This demonstrates the correct defensive approach was implemented elsewhere but missed in `logger.ts`.

## Call Sites Affected

The `formatTool` method is called from 4 locations:

| File | Line | Context | Impact |
|------|------|---------|--------|
| `src/hooks/save-hook.ts` | 38 | PostToolUse hook logging | Hook crashes, observation lost |
| `src/services/worker/http/middleware.ts` | 110 | HTTP request logging | 400 error returned to client |
| `src/services/worker/SessionManager.ts` | 220 | Observation queue logging | Observation not queued |

All call sites pass `tool_input` directly from Claude Code's PostToolUse hook, which can be any type including raw strings.

## Impact Assessment

### Severity: High

1. **Silent Data Loss**: Observations fail to save without user notification
2. **No Error Visibility**: Worker runs as background process - errors go unnoticed
3. **Intermittent Failures**: Only affects certain tool types with string inputs
4. **Cascading Effect**: One failed observation can disrupt session tracking

### Affected Tool Types

Tools most likely to trigger this bug:

- **Bash**: Command strings like `git status`, `npm install`
- **Grep**: Search patterns
- **Glob**: File patterns like `**/*.ts`
- **Custom MCP tools**: May pass raw strings

### Data Flow Path

```
Claude Code
    |
    v
PostToolUse Hook (save-hook.ts:38)
    |-- logger.formatTool() <-- CRASH HERE
    |
    v [if crash, never reaches]
Worker HTTP Endpoint
    |-- middleware.ts:110 logger.formatTool() <-- CRASH HERE TOO
    |
    v [if crash, 400 returned]
SessionManager
    |-- SessionManager.ts:220 logger.formatTool() <-- CRASH HERE TOO
    |
    v [if crash, not queued]
Database
```

## Recommended Fix

### Option 1: User's Proposed Fix (Minimal)

```typescript
let input = toolInput;
if (typeof toolInput === 'string') {
  try {
    input = JSON.parse(toolInput);
  } catch {
    input = { raw: toolInput };
  }
}
```

**Pros**: Simple, encapsulates raw strings in an object
**Cons**: Changes the shape of input for raw strings (may affect downstream logic)

### Option 2: Consistent with prompts.ts Pattern (Recommended)

```typescript
formatTool(toolName: string, toolInput?: any): string {
  if (!toolInput) return toolName;

  let input = toolInput;
  if (typeof toolInput === 'string') {
    try {
      input = JSON.parse(toolInput);
    } catch {
      // Input is a raw string, not JSON - use as-is
      input = toolInput;
    }
  }

  // Bash: show full command
  if (toolName === 'Bash' && input.command) {
    return `${toolName}(${input.command})`;
  }

  // Handle raw string inputs (e.g., from Bash commands passed as strings)
  if (typeof input === 'string') {
    return `${toolName}(${input.length > 50 ? input.slice(0, 50) + '...' : input})`;
  }

  // ... rest of existing logic
}
```

**Pros**: Consistent with existing pattern, handles raw strings gracefully
**Cons**: Requires additional check for string display formatting

### Option 3: Extract Shared Utility (Best Long-term)

Create a shared utility in `src/shared/json-utils.ts`:

```typescript
/**
 * Safely parse JSON that might be a raw string
 * Returns the parsed object if valid JSON, otherwise the original value
 */
export function safeJsonParse<T>(value: T): T | object {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
```

Then use in both `logger.ts` and `prompts.ts` for consistency.

## Similar Patterns to Review

Other `JSON.parse` calls that may need similar protection:

| File | Line | Current Protection |
|------|------|-------------------|
| `src/sdk/prompts.ts` | 97, 106 | Has try-catch |
| `src/services/sqlite/PendingMessageStore.ts` | 373-374 | No try-catch (lower risk - DB data should be valid) |
| `src/utils/logger.ts` | 139 | **No try-catch (BUG)** |

## Testing Considerations

### Unit Tests Needed

1. `formatTool` with valid JSON string input
2. `formatTool` with object input (already parsed)
3. `formatTool` with raw string input (the bug case)
4. `formatTool` with null/undefined input
5. `formatTool` with empty string input

### Integration Tests Needed

1. PostToolUse hook with Bash command string
2. Observation storage with raw string tool input
3. Full pipeline from hook through worker to database

### Test Cases

```typescript
// Should handle raw string input without crashing
expect(logger.formatTool('Bash', 'ls -la')).toBe('Bash(ls -la)');

// Should handle JSON string input
expect(logger.formatTool('Read', '{"file_path": "/foo"}'))
  .toBe('Read(/foo)');

// Should handle object input
expect(logger.formatTool('Read', { file_path: '/foo' }))
  .toBe('Read(/foo)');

// Should handle empty/null input
expect(logger.formatTool('Bash')).toBe('Bash');
expect(logger.formatTool('Bash', null)).toBe('Bash');
```

## Complexity

**Low** - 30 minutes to 1 hour

- Single file change (`src/utils/logger.ts`)
- Clear fix pattern exists in codebase
- No breaking API changes
- Unit tests straightforward

## References

- GitHub Issue: #545
- Related file with correct pattern: `src/sdk/prompts.ts` (lines 96-102)
- Logger source: `src/utils/logger.ts` (lines 136-197)
