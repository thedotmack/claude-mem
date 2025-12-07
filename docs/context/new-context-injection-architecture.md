# New Context Injection Architecture for Endless Mode

**Date**: 2024-12-07  
**Version**: 7.1.0+  
**Status**: Implemented, Ready for Testing

## Overview

This document describes the new context injection strategy for Endless Mode, which replaces the old transcript transformation approach with a more natural, tool-use-based injection mechanism.

## Problem with Old Architecture

The previous implementation (v7.0.0) had several issues:

1. **Complex Transcript Manipulation**: Replaced tool_use/tool_result pairs with assistant messages containing observations
2. **Manual Context Injection**: Required complex parsing and rewriting of JSONL transcript files
3. **Fragile State Management**: Had to track "cycles" of tool uses and coordinate replacement zones
4. **Unnatural Flow**: Observations appeared as assistant messages, not as responses to actual tool uses

## New Architecture

### Core Concept

Instead of replacing existing transcript entries, we now:
1. **Clear tool inputs** (not outputs) to save tokens
2. **Inject observation fetches** as natural tool_use entries
3. **Observations appear as tool results**, maintaining natural conversation flow

### Lifecycle Flow

#### 1. PreToolUse Hook (`src/hooks/pre-tool-use-hook.ts`)

**When**: Before each tool execution  
**Purpose**: Track timing and prepare for context injection

```typescript
PreToolUse {
  tool_name: string
  tool_input: any
  transcript_path: string
}
```

**Actions**:
- Notifies worker service of tool start time
- Currently just tracking (can be extended for metrics)
- Non-blocking, lightweight operation

#### 2. PostToolUse Hook (`src/hooks/save-hook.ts`)

**When**: After each tool execution  
**Purpose**: Queue observation, clear input, inject context

**Endless Mode Enabled Flow**:

```typescript
1. Send observation request to worker (wait_until_obs_is_saved=true)
2. Worker queues observation and processes with Claude Agent SDK
3. Hook blocks up to 90s waiting for observation
4. When observation ready:
   a. Clear tool input from transcript
   b. Inject observation fetch as new tool_use
5. Return success
```

**Actions** (when observation is created):

```typescript
// Step 1: Clear tool input
clearToolInputInTranscript(transcript_path, tool_use_id)
// Replaces: { input: {...large object...} }
// With:     { input: { _cleared: true, message: "[Input removed to save ~X tokens]" } }

// Step 2: Inject observation fetch
injectObservationFetchInTranscript(transcript_path, session_id, cwd, observations)
// Adds to transcript:
// - Assistant message with tool_use: 'claude-mem-fetch-observations'
// - User message with tool_result containing observation markdown
```

#### 3. Worker Service Changes

**Removed**:
- `transformTranscriptWithAgents()` - No longer called from worker
- Old rolling replacement logic
- Complex cycle tracking for transformation

**Added**:
- `/sessions/:sessionDbId/pre-tool-use` endpoint for tracking
- Simplified observation flow (just return observation data)

## Benefits

### 1. Natural Context Flow

Observations now appear as responses to explicit tool uses:

```json
// Assistant asks to fetch observations
{
  "type": "assistant",
  "message": {
    "content": [{
      "type": "tool_use",
      "id": "toolu_mem_12345",
      "name": "claude-mem-fetch-observations",
      "input": { "observation_ids": [1, 2, 3] }
    }]
  }
}

// User provides observations as tool result
{
  "type": "user",
  "message": {
    "content": [{
      "type": "tool_result",
      "tool_use_id": "toolu_mem_12345",
      "content": "## Observation 1\n\n..."
    }]
  }
}
```

### 2. Simpler Implementation

- No complex zone tracking
- No recursive parsing of tool results
- No agent file discovery logic
- Single-pass transcript modification

### 3. Token Savings Still Achieved

Tool inputs can be large (especially for file contents, bash output). By clearing them:

```typescript
// Before: 10KB tool input
{ "type": "tool_use", "input": { "file_text": "...10KB..." } }

// After: 100 bytes placeholder
{ "type": "tool_use", "input": { "_cleared": true, "message": "[Input removed to save ~2500 tokens]" } }
```

### 4. Sequential Injection Maintains Itself

No need for complex cycle management - observations are injected at the point they're created:

```
User prompt
  → Tool 1 (input cleared, observation injected)
  → Tool 2 (input cleared, observation injected)
  → Tool 3 (input cleared, observation injected)
```

Each tool's observation is injected immediately after it completes, maintaining natural sequential flow.

## Implementation Files

### New Files

1. **`src/hooks/pre-tool-use-hook.ts`**
   - Tracks tool execution start
   - Notifies worker service
   - Lightweight, non-blocking

2. **`src/hooks/context-injection.ts`**
   - `clearToolInputInTranscript()` - Clears tool inputs
   - `injectObservationFetchInTranscript()` - Injects observation fetch
   - `formatObservationAsMarkdown()` - Formats observations

### Modified Files

1. **`src/hooks/save-hook.ts`**
   - Uses new context injection functions
   - Removed old transformation logic
   - Simplified observation handling

2. **`src/services/worker-service.ts`**
   - Added `/sessions/:sessionDbId/pre-tool-use` endpoint
   - Removed `transformTranscriptWithAgents()` import
   - Simplified `waitForObservation()` method

3. **`plugin/hooks/hooks.json`**
   - Registered PreToolUse hook

4. **`scripts/build-hooks.js`**
   - Added pre-tool-use-hook to build list

## Configuration

Enable in `~/.claude-mem/settings.json`:

```json
{
  "env": {
    "CLAUDE_MEM_ENDLESS_MODE": true,
    "CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS": 90000
  }
}
```

## Testing Checklist

- [ ] Build completes without errors ✅
- [ ] PreToolUse hook executes before tools
- [ ] PostToolUse clears tool inputs correctly
- [ ] Observations are injected as tool_use entries
- [ ] Token savings are calculated correctly
- [ ] Transcript remains valid JSONL after modifications
- [ ] Agent transcripts are handled (if needed)
- [ ] Fallback to async mode on timeout works
- [ ] Error handling is graceful

## Metrics

Monitor with existing tools:
```bash
npm run endless-mode:metrics
```

Should show:
- Tool input token savings
- Observation injection count
- Processing times

## Migration Notes

### From v7.0.0 to v7.1.0

**Breaking Changes**: None - new architecture coexists with old code

**Behavioral Changes**:
- Observations now appear as tool results instead of assistant messages
- Tool inputs are cleared instead of tool outputs
- Transformation happens in save-hook instead of worker service

**Rollback**: If issues occur, disable Endless Mode in settings. Old observation creation logic still works.

## Future Enhancements

1. **Batch Observation Fetching**: Inject multiple observations in a single tool_use
2. **Selective Input Clearing**: Only clear large inputs (>1KB)
3. **Smart Tool Selection**: Learn which tools benefit most from context injection
4. **Compression Metrics**: Better tracking of token savings per tool type

## Questions & Answers

**Q: Why clear inputs instead of outputs?**  
A: Tool outputs are what Claude needs to continue working. Inputs are often redundant (files just read, bash commands just executed). By keeping outputs and clearing inputs, we maintain task continuity while saving tokens.

**Q: What happens if observation creation times out?**  
A: The hook falls back to async mode - observation is still created in the background, but transcript modification is skipped. Session continues normally.

**Q: Can this work with agent transcripts?**  
A: Yes, agent transcript handling can be added using the same `clearToolInputInTranscript` and `injectObservationFetchInTranscript` functions.

**Q: How does this compare to the old rolling replacement?**  
A: Old approach: Batch replace tool_use/tool_result pairs with assistant messages  
New approach: Clear inputs, inject fetches, observations appear as natural results  
Result: Same token savings, simpler code, more natural flow

## References

- Original Problem Statement: See PR description
- Old Implementation: `src/hooks/save-hook.ts` (v7.0.0)
- Context Injection Strategy: `src/hooks/context-injection.ts`
- Worker Service Changes: `src/services/worker-service.ts`
