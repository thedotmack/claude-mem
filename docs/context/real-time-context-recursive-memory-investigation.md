# Real-Time Context: Recursive Memory Investigation

**Date:** 2025-11-13
**Branch:** `feature/real-time-context`
**Issue:** [#98](https://github.com/thedotmack/claude-mem/issues/98)
**Investigator:** @basher83

## Problem

The real-time context feature injects past observations into new prompts. These injected observations flow through tool executions to the memory agent, which creates duplicate observations about the same work.

**Example:**

- Session 1: Creates observation #100 about "Context injection system"
- Session 2: Injects #100 as context, then stores it again as observation #101
- Session 3: Injects both #100 and #101 (both about the same work)
- The spiral continues

## Root Cause

Context injection wraps observations in markdown and returns them via `hookSpecificOutput` (new-hook.ts:166-188). Claude uses this context to respond. The tool executions contain references to injected context. These references flow through save-hook.ts to the worker service, which sends them to the memory agent. The memory agent treats them as new work and creates observations.

## Architecture Analysis (Core 4 Framework)

Every agent operates on four pillars: Context, Model, Prompt, Tools. Understanding these reveals why the recursive storage happens.

**Context:**
- Real-time feature injects 50 recent observations into each prompt
- Problem: Injected observations flow through tool executions back to memory storage
- Result: Same observations stored multiple times

**Model:**
- Memory agent (Claude Haiku) processes tool observations from hooks
- Selection agent (configurable) chooses relevant context from timeline
- Both operate via Agent SDK

**Prompt:**
- Context injection: Markdown-formatted past observations (new-hook.ts:151-164)
- Memory storage: XML-formatted tool observations (prompts.ts:159-164)
- Gap: No instruction to distinguish injected context from new work

**Tools (Hooks):**
- UserPromptSubmit (new-hook.ts) - Injects context before Claude responds
- PostToolUse (save-hook.ts) - Captures tool executions after Claude responds
- Worker service - Orchestrates SDK agents for processing

**The architectural flaw:** Context flows in at UserPromptSubmit, gets used by Claude, appears in tool executions, and flows back out through PostToolUse to storage—with no mechanism to filter the injected portion.

### Data Flow

**Injection path:**

1. `new-hook.ts:122-137` calls `/api/context/select-from-timeline`
2. `worker-service.ts:1022-1121` selects relevant observation IDs
3. `new-hook.ts:143-164` fetches full observations from database
4. `new-hook.ts:166` formats as markdown, returns untagged

**Storage path:**

1. `save-hook.ts:62-72` sends tool_input/tool_response to worker
2. `worker-service.ts` forwards to SDKAgent
3. `SDKAgent.ts:64-86` processes responses
4. `prompts.ts:142-165` builds observation prompt
5. Memory agent creates observations

**The gap:** Nothing strips injected context before storage.

## Solution: Dual-Tag System

Wrap injected context in XML tags. Strip tags before sending to memory agent.

This follows the **edge processing pattern** from hooks-in-composition: process data at the hook layer before sending to the worker service. The hook becomes a filter, stripping injected context before it reaches the memory agent.

### Pattern: One-Way Data Stream with Edge Filtering

```text
Current (broken):
UserPrompt → new-hook → inject → Claude → tool use → save-hook → worker → memory agent
                                                                         ↓
                                                            Creates duplicate observations

Fixed (edge filtering):
UserPrompt → new-hook → inject tagged → Claude → tool use → save-hook → strip tags → worker → memory agent
                                                                    ↑                        ↓
                                                              Filter at edge        Only new work stored
```

**Principle:** "Process at edge, send clean data to server." The save-hook strips tags before data leaves the hook layer, preventing recursive storage without adding complexity to the memory agent.

### Tag 1: `<claude-mem-context>`

Wraps automatically injected past observations. Signals to Claude: "This is reference material from your memory system." Gets stripped before memory processing.

### Tag 2: `<private>`

Wraps user content that shouldn't persist. Signals: "This is between you and me." Gets stripped before memory processing.

**Why `<private>` works:** Other alternatives (`<ephemeral>`, `<scratch>`, `<sensitive>`) describe content quality or state, which affects Claude's response behavior. Private describes relationship to content, which doesn't.

## Implementation

### File 1: src/hooks/new-hook.ts

**Line 166**, change from:

```typescript
realtimeContext = `# Relevant Context from Past Sessions\n\n${obsContext}`;
```

**To:**

```typescript
realtimeContext = `<claude-mem-context>
# Relevant Context from Past Sessions

${obsContext}
</claude-mem-context>`;
```

### File 2: src/hooks/save-hook.ts

**After imports** (line 11), add:

```typescript
/**
 * Strip memory tags to prevent recursive storage
 */
function stripMemoryTags(content: string): string {
  if (typeof content !== 'string') return content;

  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .trim();
}
```

**Lines 65-68**, change from:

```typescript
body: JSON.stringify({
  tool_name,
  tool_input: tool_input !== undefined ? JSON.stringify(tool_input) : '{}',
  tool_response: tool_response !== undefined ? JSON.stringify(tool_response) : '{}',
```

**To:**

```typescript
body: JSON.stringify({
  tool_name,
  tool_input: tool_input !== undefined
    ? stripMemoryTags(JSON.stringify(tool_input))
    : '{}',
  tool_response: tool_response !== undefined
    ? stripMemoryTags(JSON.stringify(tool_response))
    : '{}',
```

## Testing

1. Enable real-time context: `export CLAUDE_MEM_REALTIME_CONTEXT=true`
2. Submit prompt triggering context injection
3. Check `~/.claude-mem/silent.log` for context selection success
4. Check database: injected context should NOT appear in new observations
5. Test `<private>` tag: Submit `<private>test data</private>`
6. Verify: Claude sees it, observations don't contain it
7. Compare token usage: observation sizes should decrease

## Expected Results

**Before fix:**

- Token usage grows with each session
- Duplicate observations accumulate
- Context becomes polluted with recursive copies

**After fix:**

- Token usage remains stable
- No duplicate observations created
- Context stays clean and relevant

## Files Modified

- `src/hooks/new-hook.ts` (1 line changed)
- `src/hooks/save-hook.ts` (10 lines added, 4 lines modified)

## Technical Notes

- Tags use XML format (matches existing observation/summary XML)
- `stripMemoryTags()` handles non-string inputs defensively
- Primary Claude sees all content; memory agent sees filtered content
- Solution is minimal and surgical (~18 lines total)

### Design Principles Applied

**Never Block the Agent** (hooks-in-composition best practice):
```typescript
function stripMemoryTags(content: string): string {
  if (typeof content !== 'string') return content;  // Defensive: won't crash
  return content.replace(...).trim();
}
```

The function protects against unexpected input. If stripping fails, the agent continues working—observability may suffer, but execution doesn't stop.

**Edge Processing** (hooks-in-composition pattern):
- Filter at save-hook (edge) before sending to worker (server)
- Keeps worker service simple—no tag-stripping logic needed
- Follows one-way data stream: hook → worker → database

**Small, Surgical Change** (YAGNI principle):
- Changes only what's necessary
- No new dependencies
- No architectural rewrites
- Fixes root cause without overengineering

## Next Steps

1. Implement changes on `feature/real-time-context` branch
2. Build and sync: `npm run build && npm run sync-marketplace`
3. Restart worker: `npm run worker:restart`
4. Test with real-time context enabled
5. Verify no recursive storage occurs
6. Report results to maintainer

## Verification Results

**Date:** 2025-11-13
**Status:** ✅ All tests passed
**Commit:** ee58eac

### Test Environment

- Plugin installed: `~/.claude/plugins/marketplaces/thedotmack/`
- Real-time context enabled: `CLAUDE_MEM_REALTIME_CONTEXT=true`
- Worker running: PM2 on port 37777
- Database: `~/.claude-mem/claude-mem.db`

### Tests Performed

**Test 1: Context Injection**
- Started fresh session with existing observations
- Submitted prompt: "Can you explain how the dual-tag system works?"
- **Result:** ✅ Log shows `"✓ Injected 1 observations as context"`

**Test 2: Tag Stripping**
- Checked database for tag presence
- Query: `SELECT COUNT(*) FROM observations WHERE [fields] LIKE '%<claude-mem-context>%'`
- **Result:** ✅ 0 rows found (tags stripped successfully)

**Test 3: No Duplicate Observations**
- Session 1: Created observation #1 about dual-tag system
- Session 2: Injected observation #1, asked about dual-tag system
- Checked database after session 2
- **Result:** ✅ Still only 1 observation (no duplicate created)

**Test 4: Edge Case - Repeated Content**
- Session 1: Asked to read package.json, created observation #2
- Session 2: Observation #2 injected as context
- Session 3: Asked about package.json again
- **Result:** ✅ Observation count: 3 total, no duplicates of #2

**Test 5: Tag Presence in Built Files**
- Checked: `~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/new-hook.js`
- Search: `grep "claude-mem-context"`
- **Result:** ✅ 2 occurrences found (tags present in wrapped context)

**Test 6: stripMemoryTags Function**
- Checked: `~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/save-hook.js`
- Search: `grep "claude-mem-context.*private.*trim"`
- **Result:** ✅ Function exists (minified as `k`), both replacements present

### Evidence

**Context injection log:**
```
[2025-11-13T18:01:38.639Z] [new-hook] ✓ Injected 1 observations as context
[2025-11-13T18:15:27.967Z] [new-hook] ✓ Injected 1 observations as context
```

**Database verification:**
```bash
# No tags in any observations
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE narrative LIKE '%<claude-mem-context>%';"
# Output: 0

# Observation count stable (no duplicates)
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations;"
# Output: 3 (expected: #1 dual-tag, #2 package, #3 package metadata - no duplicates)
```

**Built files verification:**
```bash
# Tags present in new-hook
grep -o "claude-mem-context" ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/new-hook.js | wc -l
# Output: 2

# stripMemoryTags function present in save-hook
grep "claude-mem-context.*private.*trim" ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/save-hook.js
# Output: function k(a){return typeof a!="string"?a:a.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g,"").replace(/<private>[\s\S]*?<\/private>/g,"").trim()}
```

### Key Findings

1. **Context injection works reliably** - Selection agent chooses relevant observations and wraps them in tags
2. **Tags are invisible to database** - Zero tag occurrences in observations, summaries, or prompts tables
3. **No recursive storage** - Injected context doesn't create duplicate observations
4. **Edge processing effective** - save-hook strips tags before data reaches worker
5. **Defensive coding works** - `stripMemoryTags()` handles non-string inputs safely

### Edge Cases Tested

**Scenario: Injected content prevents tool use**
- Session injects observation about file content
- User asks about same file in new session
- Claude might skip Read tool (already has content from context)
- **Result:** No duplicate observation created from the injected content

**Scenario: Multiple sessions with overlapping context**
- Session 1: Creates observation A
- Session 2: Injects A, creates observation B
- Session 3: Injects A and B
- **Result:** No duplicates of A or B created

### Verification Conclusion

The dual-tag system prevents recursive memory storage as designed. All verification criteria met:

✅ Context injection activates when observations exist
✅ Tags wrap injected content in new-hook
✅ Tags are stripped before storage in save-hook
✅ No duplicate observations created from injected context
✅ Edge cases handled correctly
✅ Worker processes clean data without tag content

Implementation verified and ready for production.

## Known Limitations

### Testing Methodology

**Manual verification, not automated:**
- Testing was performed manually via database queries and log inspection
- No automated test suite for the complete feature (only unit tests for stripMemoryTags function)
- Integration testing was done in active development environment

**Small data set:**
- Verification performed with only 3 observations in database
- Long-term behavior (100+ sessions) not tested
- Scale testing (1000+ observations in timeline) not performed

**"Before fix" evidence:**
- No direct measurements of token growth before the fix
- Problem was identified through architectural analysis, not observed in production
- Impact claims are based on expected behavior, not measured behavior

### Edge Cases Not Tested

1. **Nested tags:** Behavior with `<claude-mem-context>...<private>...</private>...</claude-mem-context>` not explicitly tested
2. **Multiple injections per session:** What happens if context is injected multiple times in one session?
3. **Malformed tags:** Regex replacement failure scenarios not covered
4. **Large context:** No testing with >1MB JSON.stringify() output
5. **Backwards compatibility:** No verification that old observations with these tag names won't cause issues

### Future Testing Recommendations

**Automated integration tests:**
- Test that context injection doesn't create duplicate observations over 100 sessions
- Verify observation count stability with multiple concurrent sessions
- Test edge cases (nested tags, malformed tags, large content)

**Performance testing:**
- Measure actual token usage before/after fix over extended period
- Test with 10,000+ observations in timeline
- Verify regex performance doesn't degrade with very large content

**Regression testing:**
- Ensure existing functionality (non-real-time-context sessions) still works
- Verify feature can be safely disabled/re-enabled without data corruption

## References

### Issue & Branch
- Issue: https://github.com/thedotmack/claude-mem/issues/98
- Maintainer analysis: Issue #98, comment 3 (dual-tag solution proposal)
- Branch: `upstream/feature/real-time-context`
- Commit: ee58eac

### Multi-Agent Composition Patterns Applied
- **Core 4 Framework** (.claude/skills/multi-agent-composition/reference/core-4-framework.md) - Context, Model, Prompt, Tools analysis
- **Hooks-in-Composition** (.claude/skills/multi-agent-composition/patterns/hooks-in-composition.md) - Edge processing pattern, "never block the agent" principle
- **One-Way Data Stream** (hooks pattern) - Hook processes data before sending to server
