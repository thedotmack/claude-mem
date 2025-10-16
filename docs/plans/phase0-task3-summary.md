# Phase 0 Task 3: Context Hook Logging Implementation

## Summary

Added comprehensive logging to the context hook (`src/hooks/context.ts`) to verify it correctly loads summaries from the database and outputs them as Claude's context. All logging uses `console.error` to avoid polluting stdout, which is reserved for the markdown context output that becomes part of Claude's context.

## Files Modified

- `/Users/alexnewman/Scripts/claude-mem/src/hooks/context.ts`

## Logging Points Added

All log messages use the `[claude-mem context]` prefix for easy searching and filtering.

### 1. Hook Invocation (Line 18-23)
```typescript
console.error('[claude-mem context] Hook fired with input:', JSON.stringify({
  session_id: input?.session_id,
  cwd: input?.cwd,
  source: input?.source,
  has_input: !!input
}));
```
**Purpose:** Logs that the hook was called and shows the input parameters, especially the `source` field which determines if context should be loaded.

### 2. Standalone Mode Detection (Line 27)
```typescript
console.error('[claude-mem context] No input provided - exiting (standalone mode)');
```
**Purpose:** Logs when the hook is run standalone without Claude Code input.

### 3. Source Check - Skip (Line 34)
```typescript
console.error('[claude-mem context] Source is not "startup" (got:', input.source, ') - skipping context load');
```
**Purpose:** Logs when the source is not "startup" (e.g., "resume"), indicating context loading is being skipped.

### 4. Source Check - Proceed (Line 39)
```typescript
console.error('[claude-mem context] Source check passed - proceeding with context load');
```
**Purpose:** Confirms we're proceeding with context loading because source check passed.

### 5. Project Extraction (Line 43)
```typescript
console.error('[claude-mem context] Extracted project name:', project, 'from cwd:', input.cwd);
```
**Purpose:** Shows the project name extracted from the cwd, which is used to query summaries.

### 6. Database Query Start (Line 46)
```typescript
console.error('[claude-mem context] Querying database for recent summaries...');
```
**Purpose:** Indicates we're about to query the database.

### 7. Database Query Results (Line 51)
```typescript
console.error('[claude-mem context] Database query complete - found', summaries.length, 'summaries');
```
**Purpose:** Reports how many summaries were found in the database.

### 8. Summary Previews (Lines 54-60)
```typescript
if (summaries.length > 0) {
  console.error('[claude-mem context] Summary previews:');
  summaries.forEach((summary, idx) => {
    const preview = summary.request?.substring(0, 100) || summary.completed?.substring(0, 100) || '(no content)';
    console.error(`  [${idx + 1}]`, preview + (preview.length >= 100 ? '...' : ''));
  });
}
```
**Purpose:** Shows a preview (first 100 chars) of each summary found, helping verify the correct data was retrieved.

### 9. No Summaries Found (Line 64)
```typescript
console.error('[claude-mem context] No summaries found - outputting empty context message');
```
**Purpose:** Logs when no summaries exist for the project.

### 10. Markdown Building Start (Line 70)
```typescript
console.error('[claude-mem context] Building markdown context from summaries...');
```
**Purpose:** Indicates we're starting to build the markdown output.

### 11. Markdown Output Details (Lines 117-120)
```typescript
console.error('[claude-mem context] Markdown built successfully');
console.error('[claude-mem context] Output length:', markdownOutput.length, 'characters,', output.length, 'lines');
console.error('[claude-mem context] Output preview (first 200 chars):', markdownOutput.substring(0, 200) + '...');
console.error('[claude-mem context] Outputting context to stdout for Claude Code injection');
```
**Purpose:** Reports the markdown was built successfully, shows its length, and provides a preview before sending to stdout.

### 12. Successful Completion (Line 125)
```typescript
console.error('[claude-mem context] Context hook completed successfully');
```
**Purpose:** Confirms the hook completed without errors.

### 13. Error Handling (Lines 130-133)
```typescript
console.error('[claude-mem context] ERROR occurred during context hook execution');
console.error('[claude-mem context] Error message:', error.message);
console.error('[claude-mem context] Error stack:', error.stack);
console.error('[claude-mem context] Exiting gracefully to avoid blocking Claude Code');
```
**Purpose:** Provides detailed error information if anything goes wrong, including stack trace for debugging.

## Critical Implementation Detail: stdout vs stderr

**IMPORTANT:** All logging uses `console.error` (stderr) because:
- The context hook outputs markdown to `console.log` (stdout)
- Claude Code reads stdout to inject context into Claude's conversation
- Any logging to stdout would pollute the context and break the feature
- stderr is safe for logging and will appear in Claude Code's logs/terminal

## How to Test

### Testing with an Existing Project with Summaries

1. **Ensure you have previous summaries saved:**
   ```bash
   # Check if summaries exist for your project
   sqlite3 ~/.config/claude-code/hooks/claude-mem.db "SELECT * FROM summaries WHERE project = 'your-project-name' LIMIT 5;"
   ```

2. **Start a new Claude Code session:**
   ```bash
   cd /path/to/your-project
   claude-code
   ```

3. **Check the logs:**
   - Look for `[claude-mem context]` messages in stderr
   - Claude Code should show these logs during startup
   - The context should appear in Claude's initial knowledge

### Testing with a New Project (No Summaries)

1. **Navigate to a project without previous summaries:**
   ```bash
   cd /path/to/new-project
   claude-code
   ```

2. **Expected behavior:**
   - Hook fires and logs indicate no summaries found
   - Output should be: "No previous sessions found for this project yet."

### Testing Standalone Mode

```bash
# Run the hook directly (not via Claude Code)
tsx src/hooks/context.ts

# Expected output:
# [claude-mem context] Hook fired with input: {...}
# [claude-mem context] No input provided - exiting (standalone mode)
# No input provided - this script is designed to run as a Claude Code SessionStart hook
```

### Testing Source Check (Resume vs Startup)

The hook should only load context on `source: "startup"`, not on session resume. This is harder to test directly but the logs will show:
- On startup: "Source check passed - proceeding with context load"
- On resume: "Source is not 'startup' (got: resume) - skipping context load"

## Expected Log Sequence for a Session with Previous Summaries

When you start Claude Code in a project with existing summaries, you should see this sequence in stderr:

```
[claude-mem context] Hook fired with input: {"session_id":"...","cwd":"/path/to/project","source":"startup","has_input":true}
[claude-mem context] Source check passed - proceeding with context load
[claude-mem context] Extracted project name: project from cwd: /path/to/project
[claude-mem context] Querying database for recent summaries...
[claude-mem context] Database query complete - found 3 summaries
[claude-mem context] Summary previews:
  [1] Added logging to the save hook to track when summaries are being persisted to the database...
  [2] Implemented the worker hook to generate summaries from session transcripts using Claude API...
  [3] Created database schema and initial setup for storing session summaries...
[claude-mem context] Building markdown context from summaries...
[claude-mem context] Markdown built successfully
[claude-mem context] Output length: 1247 characters, 45 lines
[claude-mem context] Output preview (first 200 chars): # Recent Session Context

Here's what happened in recent project sessions:

---

**Request:** Added logging to the save hook to track when summaries are being persisted to the database

**Completed:** ...
[claude-mem context] Outputting context to stdout for Claude Code injection
[claude-mem context] Context hook completed successfully
```

## What to Look For in Logs

### Success Indicators
1. Hook fires with `has_input: true` and `source: "startup"`
2. Source check passes
3. Project name is correctly extracted
4. Database query finds summaries (count > 0)
5. Summary previews show meaningful content
6. Markdown is built with reasonable length (> 100 characters)
7. Hook completes successfully

### Warning Signs
1. Hook fires with `has_input: false` - means Claude Code didn't provide input
2. Source is not "startup" - context won't load (expected on resume)
3. Database query finds 0 summaries - either first session or save hook not working
4. Summary previews show "(no content)" - data might be corrupt
5. Markdown length is very small - formatting might be broken
6. Error messages appear - check stack trace for issues

### Common Issues to Debug

**No summaries found:**
- Check if save hook is configured and working
- Verify worker hook generated summaries
- Ensure project name matches (case-sensitive)

**Hook doesn't fire:**
- Verify hooks are configured in Claude Code settings
- Check that the hook path is correct
- Ensure the built JavaScript exists (`dist/hooks/context.js`)

**Context not appearing in Claude:**
- Check if markdown is being output to stdout (should see in logs)
- Verify stdout isn't being polluted by other logs
- Check Claude Code configuration for SessionStart hooks

## Issues or Concerns Discovered

### None - Implementation is Clean

The implementation is straightforward and follows best practices:

1. **Separation of concerns:** stdout for context, stderr for logging
2. **Comprehensive coverage:** Every critical step is logged
3. **Safe error handling:** Errors are logged but don't block Claude Code
4. **No performance impact:** Logging is lightweight
5. **Easy debugging:** All logs are prefixed and searchable

### Future Enhancements (Optional)

1. **Log levels:** Could add debug/info/error levels for filtering
2. **Timing information:** Could log how long database queries take
3. **Conditional logging:** Could enable/disable via environment variable
4. **Structured logging:** Could output logs as JSON for parsing

## Testing Checklist

- [ ] Start Claude Code in a project with existing summaries
- [ ] Verify logs appear in stderr with `[claude-mem context]` prefix
- [ ] Confirm context appears in Claude's initial knowledge
- [ ] Check summary previews match actual summary content
- [ ] Verify markdown length is reasonable
- [ ] Test with a new project (no summaries)
- [ ] Confirm "No previous sessions found" message appears
- [ ] Run hook standalone and verify it exits gracefully
- [ ] Check that all log points are hit in sequence
- [ ] Verify no logs appear in stdout (only markdown context)

## Conclusion

The context hook now has comprehensive logging at every critical step. This will make it easy to:
- Verify summaries are being loaded from the database
- Debug issues with context not appearing
- Confirm the markdown output is correct
- Track the complete flow from hook invocation to Claude context injection

All logging uses stderr to avoid polluting the stdout channel that carries the actual context markdown to Claude Code.
