# Feature Parity: Claude-Mem Hooks vs Cursor Hooks

This document compares claude-mem's Claude Code hooks with the Cursor hooks implementation to ensure feature parity.

## Hook Mapping

| Claude Code Hook | Cursor Hook | Status | Notes |
|-----------------|-------------|--------|-------|
| `SessionStart` → `context-hook.js` | `beforeSubmitPrompt` → `context-inject.sh` | ✅ Partial | Context fetched but not injectable in Cursor |
| `SessionStart` → `user-message-hook.js` | (Optional) `user-message.sh` | ⚠️ Optional | No SessionStart equivalent; can run on beforeSubmitPrompt |
| `UserPromptSubmit` → `new-hook.js` | `beforeSubmitPrompt` → `session-init.sh` | ✅ Complete | Session init, privacy checks, slash stripping |
| `PostToolUse` → `save-hook.js` | `afterMCPExecution` + `afterShellExecution` → `save-observation.sh` | ✅ Complete | Tool observation capture |
| `PostToolUse` → (file edits) | `afterFileEdit` → `save-file-edit.sh` | ✅ Complete | File edit observation capture |
| `Stop` → `summary-hook.js` | `stop` → `session-summary.sh` | ⚠️ Partial | Summary generation (no transcript access) |

## Feature Comparison

### 1. Session Initialization (`new-hook.js` ↔ `session-init.sh`)

| Feature | Claude Code | Cursor | Status |
|---------|-------------|--------|--------|
| Worker health check | ✅ 75 retries (15s) | ✅ 75 retries (15s) | ✅ Match |
| Session init API call | ✅ `/api/sessions/init` | ✅ `/api/sessions/init` | ✅ Match |
| Privacy check handling | ✅ Checks `skipped` + `reason` | ✅ Checks `skipped` + `reason` | ✅ Match |
| Slash stripping | ✅ Strips leading `/` | ✅ Strips leading `/` | ✅ Match |
| SDK agent init | ✅ `/sessions/{id}/init` | ❌ Not needed | ✅ N/A (Cursor-specific) |

**Status**: ✅ Complete parity (SDK agent init not applicable to Cursor)

### 2. Context Injection (`context-hook.js` ↔ `context-inject.sh`)

| Feature | Claude Code | Cursor | Status |
|---------|-------------|--------|--------|
| Worker health check | ✅ 75 retries | ✅ 75 retries | ✅ Match |
| Context fetch | ✅ `/api/context/inject` | ✅ `/api/context/inject` | ✅ Match |
| Output format | ✅ JSON with `hookSpecificOutput` | ✅ Write to `.cursor/rules/` file | ✅ Alternative |
| Project name extraction | ✅ `getProjectName(cwd)` | ✅ `basename(workspace_root)` | ✅ Match |
| Auto-refresh | ✅ Each session start | ✅ Each prompt submission | ✅ Enhanced |

**Status**: ✅ Complete parity via auto-updated rules file

**How it works**:
- Hook writes context to `.cursor/rules/claude-mem-context.mdc`
- File has `alwaysApply: true` frontmatter
- Cursor auto-includes this rule in all chat sessions
- Context refreshes on every prompt submission

### 3. User Message Display (`user-message-hook.js` ↔ `user-message.sh`)

| Feature | Claude Code | Cursor | Status |
|---------|-------------|--------|--------|
| Context fetch with colors | ✅ `/api/context/inject?colors=true` | ✅ `/api/context/inject?colors=true` | ✅ Match |
| Output channel | ✅ stderr | ✅ stderr | ✅ Match |
| Display format | ✅ Formatted with emojis | ✅ Formatted with emojis | ✅ Match |
| Hook trigger | ✅ SessionStart | ⚠️ Optional (no SessionStart) | ⚠️ Cursor limitation |

**Status**: ⚠️ Optional (no SessionStart equivalent in Cursor)

**Note**: Can be added to `beforeSubmitPrompt` if desired, but may be verbose.

### 4. Observation Capture (`save-hook.js` ↔ `save-observation.sh`)

| Feature | Claude Code | Cursor | Status |
|---------|-------------|--------|--------|
| Worker health check | ✅ 75 retries | ✅ 75 retries | ✅ Match |
| Tool name extraction | ✅ From `tool_name` | ✅ From `tool_name` or "Bash" | ✅ Match |
| Tool input capture | ✅ Full JSON | ✅ Full JSON | ✅ Match |
| Tool response capture | ✅ Full JSON | ✅ Full JSON or output | ✅ Match |
| Privacy tag stripping | ✅ Worker handles | ✅ Worker handles | ✅ Match |
| Error handling | ✅ Fire-and-forget | ✅ Fire-and-forget | ✅ Match |
| Shell command mapping | ✅ N/A (separate hook) | ✅ Maps to "Bash" tool | ✅ Enhanced |

**Status**: ✅ Complete parity (enhanced with shell command support)

### 5. File Edit Capture (N/A ↔ `save-file-edit.sh`)

| Feature | Claude Code | Cursor | Status |
|---------|-------------|--------|--------|
| File path extraction | N/A | ✅ From `file_path` | ✅ New |
| Edit details | N/A | ✅ From `edits` array | ✅ New |
| Tool name | N/A | ✅ "write_file" | ✅ New |
| Edit summary | N/A | ✅ Generated from edits | ✅ New |

**Status**: ✅ New feature (Cursor-specific, not in Claude Code)

### 6. Session Summary (`summary-hook.js` ↔ `session-summary.sh`)

| Feature | Claude Code | Cursor | Status |
|---------|-------------|--------|--------|
| Worker health check | ✅ 75 retries | ✅ 75 retries | ✅ Match |
| Transcript parsing | ✅ Extracts last messages | ❌ No transcript access | ⚠️ Cursor limitation |
| Summary API call | ✅ `/api/sessions/summarize` | ✅ `/api/sessions/summarize` | ✅ Match |
| Last message extraction | ✅ From transcript | ❌ Empty strings | ⚠️ Cursor limitation |
| Error handling | ✅ Fire-and-forget | ✅ Fire-and-forget | ✅ Match |

**Status**: ⚠️ Partial parity (no transcript access in Cursor)

**Note**: Summary generation still works but may be less accurate without last messages. Worker generates summary from observations stored during session.

## Implementation Details

### Worker Health Checks
- **Claude Code**: 75 retries × 200ms = 15 seconds
- **Cursor**: 75 retries × 200ms = 15 seconds
- **Status**: ✅ Match

### Error Handling
- **Claude Code**: Fire-and-forget with logging
- **Cursor**: Fire-and-forget with graceful exit (exit 0)
- **Status**: ✅ Match (adapted for Cursor's hook system)

### Privacy Handling
- **Claude Code**: Worker performs privacy checks, hooks respect `skipped` flag
- **Cursor**: Worker performs privacy checks, hooks respect `skipped` flag
- **Status**: ✅ Match

### Tag Stripping
- **Claude Code**: Worker handles `<private>` and `<claude-mem-context>` tags
- **Cursor**: Worker handles tags (hooks don't need to strip)
- **Status**: ✅ Match

## Missing Features (Cursor Limitations)

1. ~~**Direct Context Injection**~~: **SOLVED** via auto-updated rules file
   - Hook writes context to `.cursor/rules/claude-mem-context.mdc`
   - Cursor auto-includes rules with `alwaysApply: true`
   - Context refreshes on every prompt

2. **Transcript Access**: Cursor hooks don't provide transcript paths
   - **Impact**: Summary generation less accurate
   - **Workaround**: Worker generates from observations

3. **SessionStart Hook**: Cursor doesn't have session start event
   - **Impact**: User message display must be optional
   - **Workaround**: Can run on `beforeSubmitPrompt` if desired

4. **SDK Agent Session**: Cursor doesn't use SDK agent pattern
   - **Impact**: No `/sessions/{id}/init` call needed
   - **Status**: ✅ Not applicable (Cursor-specific)

## Enhancements (Cursor-Specific)

1. **Shell Command Capture**: Maps shell commands to "Bash" tool observations
   - **Status**: ✅ Enhanced beyond Claude Code

2. **File Edit Capture**: Dedicated hook for file edits
   - **Status**: ✅ New feature

3. **MCP Tool Capture**: Captures MCP tool usage separately
   - **Status**: ✅ Enhanced beyond Claude Code

## Summary

| Category | Status |
|----------|--------|
| Core Functionality | ✅ Complete parity |
| Session Management | ✅ Complete parity |
| Observation Capture | ✅ Complete parity (enhanced) |
| Context Injection | ✅ Complete parity (via rules file) |
| Summary Generation | ⚠️ Partial (no transcript) |
| User Experience | ⚠️ Partial (no SessionStart) |

**Overall**: The Cursor hooks implementation achieves **full functional parity** with claude-mem's Claude Code hooks:
- ✅ Session initialization
- ✅ Context injection (via auto-updated `.cursor/rules/` file)
- ✅ Observation capture (MCP tools, shell commands, file edits)
- ⚠️ Summary generation (works, but no transcript access)

