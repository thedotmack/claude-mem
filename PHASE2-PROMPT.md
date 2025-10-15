# Phase 2 Implementation Prompt

Use this prompt to start a new chat for Phase 2 implementation:

---

## Context

I'm implementing a refactor of the claude-mem memory system based on [REFACTOR-PLAN.md](REFACTOR-PLAN.md).

**Phase 1 is complete** (see [PHASE1-COMPLETE.md](PHASE1-COMPLETE.md)):
- ✅ Database schema with migration 004
- ✅ HooksDatabase shared layer
- ✅ All four hook functions (context, new, save, summary)
- ✅ CLI integration and tests passing

## Task

Implement **Phase 2: SDK Worker Process**

According to [REFACTOR-PLAN.md](REFACTOR-PLAN.md#2-userpromptsubmit-hook) (lines 296-423), I need to:

1. **Create SDK Worker Process** (`src/sdk/worker.ts`)
   - Uses Agent SDK streaming input mode
   - AsyncIterable message generator that:
     - Yields initial prompt
     - Polls observation_queue table
     - Yields observation prompts
     - Handles FINALIZE message
   - Parses SDK responses for `<observation>` and `<summary>` XML blocks
   - Stores results using HooksDatabase methods

2. **Create SDK Prompts** (`src/sdk/prompts.ts`)
   - `buildInitPrompt()` - Initialize agent (see REFACTOR-PLAN.md:537-595)
   - `buildObservationPrompt()` - Send tool observation (see REFACTOR-PLAN.md:601-634)
   - `buildFinalizePrompt()` - Request summary (see REFACTOR-PLAN.md:640-692)

3. **Create XML Parser** (`src/sdk/parser.ts`)
   - Parse `<observation>` blocks with `<type>` and `<text>`
   - Parse `<summary>` blocks with 8 required fields
   - Extract file arrays from `<file>` child elements

4. **Update newHook** ([src/hooks/new.ts](src/hooks/new.ts:35-42))
   - Uncomment SDK worker spawn code
   - Pass session ID to worker
   - Detached process with stdio: 'ignore'

5. **Test End-to-End**
   - Create test that simulates full lifecycle
   - Verify observations are queued, processed, and stored
   - Verify summary generation works

## Key Requirements

From [REFACTOR-PLAN.md](REFACTOR-PLAN.md):

- Use `@anthropic-ai/claude-agent-sdk` query function with streaming input mode
- Model: `claude-sonnet-4-5`
- Use `disallowedTools: ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch']`
- Message generator yields `{ role: "user", content: string }` objects
- Capture SDK session ID from system init message
- Poll observation queue every 1 second
- Use AbortController for graceful cancellation
- Parse XML with a library (not regex) - suggest fast-xml-parser
- Store observations and summaries using HooksDatabase methods

## Architecture Reference

The SDK worker is a **synthesis engine** that:
- Receives tool observations (not raw data)
- Extracts meaningful insights
- Stores atomic observations in SQLite
- Generates structured summaries at session end

See [REFACTOR-PLAN.md](REFACTOR-PLAN.md#visual-overview) (lines 69-119) for the full architecture diagram.

## Files to Create

1. `src/sdk/worker.ts` - Main SDK worker process
2. `src/sdk/prompts.ts` - Prompt builders
3. `src/sdk/parser.ts` - XML response parser
4. `src/sdk/index.ts` - Exports
5. `test-phase2.ts` - End-to-end tests

## Files to Modify

1. [src/hooks/new.ts](src/hooks/new.ts:35-42) - Spawn worker process
2. [package.json](package.json) - May need to add fast-xml-parser dependency

## Testing Strategy

1. Unit tests for prompts (verify prompt structure)
2. Unit tests for parser (verify XML parsing)
3. Integration test for worker (mock SDK responses)
4. End-to-end test (simulate full observation → summary flow)

## Success Criteria

- [ ] SDK worker runs as detached process
- [ ] Worker polls observation queue continuously
- [ ] Worker sends observations to Claude SDK
- [ ] Worker parses `<observation>` and `<summary>` XML correctly
- [ ] Worker stores results in database using HooksDatabase
- [ ] Worker handles FINALIZE message and exits gracefully
- [ ] All tests pass
- [ ] No blocking of main Claude Code session

## Notes

- Keep hooks fast and non-blocking (they already are)
- SDK worker is fire-and-forget background process
- Use HooksDatabase methods (already implemented in Phase 1)
- Follow the exact prompt formats from REFACTOR-PLAN.md
- Use proper TypeScript types from Agent SDK

---

**Start with:** Create the SDK prompts module first, then the parser, then the worker. Test each piece before integrating.
