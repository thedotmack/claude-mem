# PR Summary: Fix SDK Agent Missing Working Directory Context (CWD)

## Problem
The SDK agent lacked spatial awareness because working directory (CWD) information was captured at the hook level but deliberately not passed to the worker service. This caused:
- SDK agent searching wrong repositories
- False "file not found" reports even when files existed
- Inability to match user-requested paths to tool execution paths
- Inaccurate observations due to spatial confusion

## Solution
Added CWD propagation through the entire data pipeline from hook to SDK agent, enabling spatial awareness.

## Technical Changes

### Data Flow
```
PostToolUseInput.cwd → save-hook → Worker API → SessionManager → SDK Agent → Prompt XML
```

### Files Modified (8 source + 2 build artifacts + 2 docs)
1. `src/services/worker-types.ts` - Added `cwd?: string` to interfaces
2. `src/hooks/save-hook.ts` - Extract and pass CWD to worker
3. `src/services/worker-service.ts` - Accept CWD in observations endpoint
4. `src/services/worker/SessionManager.ts` - Include CWD in message queue
5. `src/services/worker/SDKAgent.ts` - Pass CWD to prompt builder
6. `src/sdk/prompts.ts` - Include `<tool_cwd>` in XML + spatial awareness docs
7. `tests/cwd-propagation.test.ts` - 8 comprehensive tests (NEW)
8. `docs/CWD_CONTEXT_FIX.md` - Technical documentation (NEW)
9. `CHANGELOG.md` - User-facing changelog entry

### Example Output
Before (no spatial awareness):
```xml
<tool_used>
  <tool_name>ReadTool</tool_name>
  <tool_time>2025-11-10T19:18:03.065Z</tool_time>
  <tool_input>{"path":"src/index.ts"}</tool_input>
  <tool_output>{"content":"..."}</tool_output>
</tool_used>
```

After (with spatial awareness):
```xml
<tool_used>
  <tool_name>ReadTool</tool_name>
  <tool_time>2025-11-10T19:18:03.065Z</tool_time>
  <tool_cwd>/home/user/awesome-project</tool_cwd>
  <tool_input>{"path":"src/index.ts"}</tool_input>
  <tool_output>{"content":"..."}</tool_output>
</tool_used>
```

### Init Prompt Enhancement
Added "SPATIAL AWARENESS" section explaining:
- Tool executions include working directory (tool_cwd)
- Which repository/project is being worked on
- Where files are located relative to project root
- How to match requested paths to actual execution paths

## Testing

### Unit Tests
✅ 8 tests in `tests/cwd-propagation.test.ts` - all passing
- Interface definitions include cwd
- Hook extracts cwd from input
- Worker API accepts cwd
- SessionManager queues cwd
- SDK Agent passes cwd to prompts
- Prompt builder includes tool_cwd element
- End-to-end flow validation

### Build Verification
✅ All builds successful
- `plugin/scripts/save-hook.js` includes `cwd:s||""`
- `plugin/scripts/worker-service.cjs` includes `<tool_cwd>` element
- `plugin/scripts/worker-service.cjs` includes "SPATIAL AWARENESS" section

### Security Scan
✅ CodeQL: 0 vulnerabilities

## Benefits

1. **Spatial Awareness**: SDK agent knows which directory/repository it's observing
2. **Accurate Path Matching**: Can verify if requested paths match executed paths
3. **Better Observations**: Won't search wrong repositories or report false negatives
4. **Universal Model Support**: Works with Haiku, Sonnet, and Opus (no premium workaround needed)

## Backward Compatibility

- ✅ `cwd` is optional (`cwd?: string`) - no breaking changes
- ✅ Missing `cwd` handled gracefully (defaults to empty string)
- ✅ Existing observations without `cwd` continue to work
- ✅ No database migration required (CWD is transient, not persisted)

## Evidence from Issue

**Test Case**: User requested "Review and understand ai_docs/continuous-improvement/rules.md"

**Before Fix**:
1. File exists at `/Users/.../dev/personal/lunar-claude/ai_docs/...` ✅
2. Read tool successfully read the file ✅
3. SDK agent received tool executions but **no CWD** ❌
4. SDK agent searched **claude-mem repository** instead of lunar-claude ❌
5. Summary reported: "File does not exist" ❌

**After Fix**:
1. File exists at `/Users/.../dev/personal/lunar-claude/ai_docs/...` ✅
2. Read tool successfully read the file ✅
3. SDK agent receives tool executions **with CWD** ✅
4. SDK agent searches **correct repository (lunar-claude)** ✅
5. Summary accurate: "Reviewed rules.md in lunar-claude project" ✅

## Validation Checklist

- [x] TypeScript compiles without errors
- [x] All tests pass (8/8)
- [x] Build artifacts include CWD propagation
- [x] No security vulnerabilities
- [x] Documentation complete
- [x] Backward compatible
- [x] Example prompts verified
- [x] CHANGELOG updated

## Ready for Merge

This PR is ready for review and merge. All validation steps passed successfully.
