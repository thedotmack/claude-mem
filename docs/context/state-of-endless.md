# Current State of Endless Mode

## Core Concept

Endless Mode is a **biomimetic memory architecture** that solves Claude's context window exhaustion problem. Instead of keeping full tool outputs in the context window (O(N²) complexity), it:

- Captures compressed observations after each tool use
- Replaces transcripts with low token summaries
- Achieves O(N) linear complexity
- Maintains two-tier memory: working memory (compressed) + archive memory (full transcript on disk, maintained by default claude code functionality)

## Implementation Status

**Status**: FUNCTIONAL BUT EXPERIMENTAL

**Current Branch**: `beta/endless-mode` (9 commits ahead of main)

**[2025-10-15] Recent Activity** (from merge context):
- Just merged main branch changes (148 files staged)
- Resolved merge conflicts in save-hook, SessionStore, SessionRoutes
- Updated documentation to remove misleading "95% token reduction" claims
- Added important caveats about beta status

## Key Architecture Components

1. **Pre-Tool-Use Hook** - Tracks tool execution start, sends tool_use_id to worker
2. **Save Hook (PostToolUse)** - **CRITICAL**: Blocks until observation is generated (110s timeout), injects compressed observation back into context
3. **SessionManager.waitForNextObservation()** - Event-driven wait mechanism (no polling)
4. **SDKAgent** - Generates observations via Agent SDK, emits completion events
5. **Database** - Added `tool_use_id` column for observation correlation

## Configuration

```json
{
  "CLAUDE_MEM_ENDLESS_MODE": "false",  // Default: disabled
  "CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS": "90000"  // 90 second timeout
}
```

**Enable via**: Settings → Version Channel → Beta, or set env var to `"true"`

## Flow

```
Tool Executes → Pre-Hook (track ID) → Tool Completes →
Save-Hook (BLOCKS) → Worker processes → SDK generates observation →
Event fired → Hook receives observation → Injects markdown →
Clears input → Context reduced
```

## Known Limitations

From the documentation:
- ⚠️ **Slower than standard mode** - Blocking adds latency
- ⚠️ **Still in development** - May have bugs
- ⚠️ **Not battle-tested** - New architecture
- ⚠️ **Theoretical projections** - Efficiency claims not yet validated in production

## What's Working

- ✅ Synchronous observation injection
- ✅ Event-driven wait mechanism
- ✅ Token reduction via input clearing
- ✅ Database schema with tool_use_id
- ✅ Web UI for version switching
- ✅ Graceful timeout fallbacks

## What's Not Ready

- ❌ Production validation of token savings
- ❌ Comprehensive test coverage
- ❌ Stable channel release
- ❌ Performance benchmarks
- ❌ Long-running session data

## Summary

The implementation is architecturally complete and functional, but remains experimental pending production validation of the theoretical efficiency gains.
