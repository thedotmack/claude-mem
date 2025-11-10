# Plan: Fix Summary Context to Include Claude's Final Message

## Problem Statement

Summaries currently feel disconnected from the actual conversation because the Stop hook fires BEFORE Claude's final message is added to the SDK agent's conversation context. When the summary is generated, the SDK agent only sees:

1. The init prompt with the user's original goal
2. Tool execution observations (`<tool_used>` prompts)
3. The summary request prompt

The SDK agent does NOT see Claude's actual responses to the user, which contain:
- The reasoning and explanations Claude provided
- The final deliverables and what was accomplished
- The conclusions and recommendations Claude made

This explains why summaries are high-level and feel like they're missing the final outcome - they literally don't have access to Claude's final message that describes what was completed.

## Current Flow (BROKEN)

1. **User sends prompt** → `UserPromptSubmit` hook → new-hook.ts saves prompt
2. **Claude processes and responds** → Uses tools, PostToolUse hook captures them
3. **Stop hook fires** → summary-hook.ts triggers summary generation
4. **SDK agent generates summary** → Only sees: init prompt + tool observations + summary request
   - ❌ **MISSING**: Claude's actual response messages

## Root Cause

The SDK agent runs in a separate Claude subprocess using the Agent SDK's `query()` function. The SDK agent's conversation context is built from our prompts:
- `buildInitPrompt()` - Session initialization
- `buildObservationPrompt()` - Tool executions
- `buildSummaryPrompt()` - Summary request

**Claude's responses to the user are NEVER sent to the SDK agent.** The SDK agent is observing tool usage, not the full conversation.

## Solution Architecture

We need to capture Claude's final message from the main session and inject it into the SDK agent's context before generating the summary.

### Where to Get Claude's Final Message

The Stop hook receives hook input that includes the session context. We need to:
1. Extract Claude's final assistant message from the Stop hook input
2. Pass it to the worker service's `/summarize` endpoint
3. Queue it as a new message type in the SDK agent
4. Build a prompt that includes Claude's final response

### Message Flow (FIXED)

1. User prompt → new-hook.ts saves prompt
2. Claude responds → Stop hook fires with **full conversation context**
3. Stop hook extracts Claude's final message → sends to worker `/summarize` with final_message
4. Worker queues: `{ type: 'final_response', content: '...' }`
5. SDK agent sees: init + observations + **Claude's final response** + summary request
6. ✅ Summary now has complete context

---

## Phase 1: Investigation - Understand Stop Hook Input Structure

**WHY**: We need to understand exactly what data the Stop hook receives from Claude Code. This determines whether we can access Claude's final message at all, and if so, what the data structure looks like. We cannot design the solution without knowing the API surface.

**HOW**:
- Read Claude Code hooks documentation to understand Stop hook input schema
- Add debug logging to summary-hook.ts to inspect actual input received
- Test in a real session to see what data is available
- Document the structure of the conversation context (if available)

**WHAT**:
1. Add temporary debug logging to `src/hooks/summary-hook.ts`:
   - Log the full `input` object structure to a temp file
   - Log specifically what conversation/message data is available

2. Test the debug logging:
   - Run a simple Claude Code session (ask a question, get a response)
   - Let it hit the Stop hook
   - Examine the logged input structure

3. Document findings in this plan:
   - Does Stop hook input include conversation messages?
   - If yes, what's the structure? (array of messages? specific fields?)
   - Where is Claude's final assistant message located?
   - Is it already parsed or do we need to extract it?

4. Decision point:
   - ✅ If conversation context IS available → proceed to Phase 2
   - ❌ If NOT available → investigate alternative approaches (see Contingency Plan below)

**DONE WHEN**: We have documented proof of what data Stop hook receives and whether Claude's final message is accessible.

---

## Phase 2: Modify Summary Hook to Extract Final Message

**WHY**: Once we know the data structure (from Phase 1), we need to extract Claude's final assistant message and pass it to the worker service. This is the critical link that currently doesn't exist - without this, the SDK agent will continue generating summaries without knowing what Claude actually said to the user.

**HOW**:
- Parse the Stop hook input to find the final assistant message
- Extract the text content (handling both string and structured content formats)
- Modify the `/summarize` API call to include this final message
- Handle edge cases (empty message, no assistant message, etc.)

**WHAT**:
1. Update `src/hooks/summary-hook.ts`:
   - Add function `extractFinalAssistantMessage(input)` that:
     - Traverses the conversation structure (based on Phase 1 findings)
     - Finds the last message where `role === 'assistant'`
     - Extracts text content (may be string or array of content blocks)
     - Returns the concatenated text

2. Modify the fetch call to `/sessions/${sessionDbId}/summarize`:
   - Add `final_message` field to request body
   - Keep backward compatibility (if extraction fails, send empty string)
   ```typescript
   body: JSON.stringify({
     prompt_number: promptNumber,
     final_message: extractFinalAssistantMessage(input) || ''
   })
   ```

3. Add error handling:
   - If extraction fails, log warning but continue (graceful degradation)
   - Don't break existing summary functionality if final message is unavailable

**DONE WHEN**:
- summary-hook.ts successfully extracts Claude's final message
- The message is sent to the worker's `/summarize` endpoint
- Summary generation still works even if extraction fails

---

## Phase 3: Update Worker Service to Accept Final Message

**WHY**: The worker service needs to receive and queue the final message so the SDK agent can include it in its conversation context. Without this plumbing, the extracted message (from Phase 2) has nowhere to go.

**HOW**:
- Modify the `/summarize` endpoint to accept `final_message` parameter
- Create a new pending message type for final responses
- Ensure SessionManager can queue and deliver this message type

**WHAT**:
1. Update `src/services/worker-service.ts` - `handleSummarize()`:
   - Parse `final_message` from request body
   - Pass it to `sessionManager.queueSummarize()`
   ```typescript
   const { prompt_number, final_message } = req.body;
   this.sessionManager.queueSummarize(sessionDbId, final_message || '');
   ```

2. Update `src/services/worker/SessionManager.ts`:
   - Modify `queueSummarize()` signature: `queueSummarize(sessionDbId: number, finalMessage?: string)`
   - Queue the final message BEFORE the summarize message:
   ```typescript
   if (finalMessage) {
     session.pendingMessages.push({
       type: 'final_response',
       content: finalMessage
     });
   }
   session.pendingMessages.push({ type: 'summarize' });
   ```

3. Update `src/services/worker-types.ts`:
   - Add new message type to `PendingMessage` union:
   ```typescript
   | { type: 'final_response'; content: string }
   ```

**DONE WHEN**:
- Worker service accepts `final_message` parameter
- SessionManager queues final_response message before summarize message
- Types are updated to reflect new message structure

---

## Phase 4: Update SDK Agent to Handle Final Response Messages

**WHY**: The SDK agent needs to recognize the new `final_response` message type and convert it into a prompt that provides Claude's response as context. This is where the extracted message (from Phase 2) actually becomes visible to the SDK agent that generates summaries. Without this, the queued message would be ignored.

**HOW**:
- Add a new prompt builder for final responses
- Modify the message generator in SDKAgent to yield final response prompts
- Ensure it's positioned correctly (after observations, before summary request)

**WHAT**:
1. Create `buildFinalResponsePrompt()` in `src/sdk/prompts.ts`:
   ```typescript
   export function buildFinalResponsePrompt(finalMessage: string): string {
     return `CONTEXT: Claude's Final Response to User
   ==========================================
   The following is what Claude said to the user in their final message. Use this to understand what was actually completed and delivered.

   ${finalMessage}

   Now generate the summary based on the tools used AND this final response.`;
   }
   ```

2. Update `src/services/worker/SDKAgent.ts` - `createMessageGenerator()`:
   - Add case for `final_response` message type
   - Yield the final response prompt before summarize prompt
   ```typescript
   } else if (message.type === 'final_response') {
     yield {
       type: 'user',
       message: {
         role: 'user',
         content: buildFinalResponsePrompt(message.content)
       },
       session_id: session.claudeSessionId,
       parent_tool_use_id: null,
       isSynthetic: true
     };
   } else if (message.type === 'summarize') {
     // ... existing summarize code
   ```

3. Update imports:
   - Import `buildFinalResponsePrompt` from prompts.ts

**DONE WHEN**:
- SDK agent recognizes `final_response` messages
- Final response content is injected into SDK agent's conversation
- Message ordering is correct: observations → final_response → summarize

---

## Phase 5: Testing and Validation

**WHY**: We need to verify that summaries now include information from Claude's final message and feel more connected to the actual conversation outcome. This is the proof that our fix works as intended.

**HOW**:
- Run test sessions with various types of requests
- Compare summaries before and after the fix
- Verify the final message is correctly captured and used
- Test edge cases (no final message, very long messages, multi-turn conversations)

**WHAT**:
1. Build and sync the changes:
   ```bash
   npm run build
   npm run sync-marketplace
   npm run worker:restart
   ```

2. Test Case 1 - Simple Task:
   - Ask: "Create a hello world function in Python"
   - Verify: Summary mentions the specific function/code that was created
   - Check: Summary references Claude's explanation of how it works

3. Test Case 2 - Investigation:
   - Ask: "Explain how the SessionManager works"
   - Verify: Summary captures the architectural insights Claude provided
   - Check: Summary isn't just "analyzed files" but includes the actual findings

4. Test Case 3 - Multi-step Task:
   - Ask: "Fix the bug in worker-utils.ts and test it"
   - Verify: Summary mentions both the fix AND the test results
   - Check: Summary reflects Claude's final assessment/conclusion

5. Edge Case Testing:
   - Test with no final message (should gracefully degrade)
   - Test with very long final message (should handle without truncation issues)
   - Test with tool-only responses (no text, just tool calls)

6. Verify no regressions:
   - Check that existing observations still work correctly
   - Verify search functionality still finds summaries
   - Test that viewer UI displays summaries properly

**DONE WHEN**:
- Test sessions produce summaries that include context from Claude's final message
- Summaries feel connected to the conversation outcome
- No regressions in existing functionality
- Edge cases are handled gracefully

---

## Contingency Plan

**IF** Phase 1 reveals that Stop hook input does NOT include conversation context:

### Alternative Approach: Hook into Claude Code's Message API

**Option A: Use SessionEnd hook instead of Stop**
- SessionEnd might have access to complete conversation
- Trade-off: Fires later, might miss some timing windows

**Option B: Capture assistant messages via PostToolUse**
- Each PostToolUse includes the assistant message that preceded it
- Accumulate these in the database
- Use accumulated messages when generating summary
- Trade-off: More complex state management

**Option C: Parse conversation from Claude Code's internal state**
- Investigate if conversation history is stored in `~/.claude/` somewhere
- Read the conversation file directly
- Trade-off: Fragile, depends on internal Claude Code implementation

**Option D: Modify hook timing**
- Use a "later" hook that fires after conversation is committed
- Trade-off: May not exist, would require Claude Code changes

### Decision Criteria for Alternatives

1. Try Option B first (PostToolUse accumulation) - most robust and self-contained
2. If that's insufficient, investigate Option A (SessionEnd hook)
3. Options C and D are last resort due to fragility/dependencies

---

## Success Criteria

✅ Summaries include information from Claude's final response
✅ Summaries feel connected to the conversation outcome
✅ `<completed>` section mentions what Claude said was finished
✅ `<learned>` section includes insights from Claude's explanations
✅ No regressions in observation capture or search functionality
✅ Graceful degradation if final message is unavailable

---

## Notes

- The Stop hook timing is correct - it fires after Claude's final message exists
- The issue is NOT when the hook fires, but WHAT CONTEXT we pass to the SDK agent
- This fix maintains backward compatibility (summaries still work without final message)
- The SDK agent architecture is sound - we're just adding more context, not changing the flow
