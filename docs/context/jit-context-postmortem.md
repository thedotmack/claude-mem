# JIT Context Filtering: Post-Mortem

**Date:** November 9, 2025
**Duration:** 3.5 hours (7:45 PM - 11:11 PM)
**Branches:** `feature/jit-context`, `failed/jit-context`
**Status:** Failed, reverted to main
**Commits:**
- `3ac0790` - feat: Implement JIT context hook for user prompt submission
- `adf7bf4` - Refactor JIT context handling in SDKAgent and WorkerService

## Executive Summary

Attempted to implement JIT (Just-In-Time) context filtering—a feature that would dynamically generate relevant context timelines on every user prompt, potentially replacing the static session-start context entirely. After multiple architectural iterations spanning 3.5 hours and adding ~2,850 lines of code, the implementation was abandoned and reverted. The revert was not due to lack of vision (the feature aligns with long-term architectural goals), but due to implementation complexity and the need for a simpler initial approach. Significant architectural knowledge was gained about hook limitations, worker patterns, and proper separation of concerns.

## What We Tried to Build

### Goal
When a user submits a prompt, dynamically generate a relevant context timeline instead of the static session-start context. Use the fast search infrastructure (SQLite FTS5 + ChromaDB) to fetch precisely relevant context on-demand.

### The Vision
**Current approach:** SessionStart hook loads 50 recent observations blindly, displays them all.

**Proposed approach:** UserPromptSubmit hook analyzes the prompt, queries the timeline search API, and loads only the relevant context window dynamically.

**Why this makes sense:**
- We already have fast search: SQLite FTS5 + Chroma semantic search
- Dynamic context timeline search is implemented and tested
- Search results come back in <200ms
- Could **replace** session-start context entirely with smarter, prompt-specific context

### User Experience
```
User types: "How did we fix the authentication bug?"

Behind the scenes:
1. Analyze prompt: "authentication bug fix"
2. Query timeline search for relevant period
3. Load 5-10 observations from that specific timeline
4. Inject as context
5. Claude answers with precisely relevant historical context

vs. Current:
Load 50 most recent observations regardless of relevance
```

### Why Checkbox Settings Became Less Important
Originally asked for checkboxes to customize session-start context display. But if JIT context could replace session-start context with intelligent, prompt-specific timelines, the display customization became a non-issue.

## Architectural Attempts

### Attempt 1: Hook-Based Filtering (7:45 PM - 9:30 PM)

**Approach:** Call Agent SDK `query()` directly in `new-hook.ts` during UserPromptSubmit event.

**Implementation:**
- Created `jit-context-hook.ts` (~432 lines)
- Added `generateJitContext()` function in hook
- Called SDK `query()` with observation list and user prompt
- Expected hook to block for ~1-2s while Haiku filters

**Failure:**
```
Error: Claude Code executable not found at
/Users/alexnewman/.claude/plugins/marketplaces/thedotmack/plugin/scripts/cli.js
```

**Root Cause:** Hooks run in sandboxed environment without access to `claudePath` (path to Claude Code executable). The Agent SDK requires this path, which is only available in the worker service.

**Architectural Violation:** This broke the established pattern where hooks handle orchestration and workers handle AI processing. The `save-hook` sets the precedent: hooks capture data, send to worker, worker runs SDK queries asynchronously.

### Attempt 2: Worker-Based with Simple Queries (9:30 PM - 10:30 PM)

**Approach:** Move JIT filtering to worker service, keep it simple with per-request SDK queries.

**Implementation:**
- Documented architecture fix plan in `docs/jit-context-architecture-fix.md`
- Moved `generateJitContext()` to worker (considered creating `src/services/worker/JitContext.ts`)
- Modified `/sessions/:id/init` endpoint to accept `jitEnabled` flag
- Worker would run one-shot SDK query per prompt

**Architecture:**
```
UserPromptSubmit → new-hook → POST /sessions/:id/init { jitEnabled: true }
                                      ↓
                              Worker spawns Claude Haiku
                                      ↓
                              Filters 50 obs → 3-5 IDs
                                      ↓
                              Returns { context: [...] }
                                      ↓
                              Hook injects context → Claude
```

**Issues Identified:**
- Each filter request spawns a new Claude subprocess (~200-500ms overhead)
- Observation list re-sent on every prompt (~5-10KB per request)
- No token caching between requests
- Performance worse than just loading all observations directly

**Decision:** Pivoted to persistent sessions to solve performance issues.

### Attempt 3: Persistent JIT Sessions (10:30 PM - 11:11 PM)

**Approach:** Create a long-lived Agent SDK session that persists throughout user session, similar to main memory session pattern.

**Implementation (291 new lines in SDKAgent.ts):**

1. **Session Lifecycle:**
   - Added `jitSessionId`, `jitAbortController`, `jitGeneratorPromise` to `ActiveSession` interface
   - `startJitSession()`: Creates persistent SDK session at session init
   - `cleanupJitSession()`: Terminates JIT session at session end

2. **Request Queue Architecture:**
   - `jitFilterQueues` Map: Per-session request queues
   - `JITFilterRequest` interface: `{ userPrompt, resolve, reject }`
   - EventEmitter coordination: Wake generator when new requests arrive

3. **Message Generator Pattern:**
   - `createJitMessageGenerator()`: Async generator that yields filter requests
   - Initial prompt: Load 50 observations, wait for "READY" response
   - Loop: Wait for EventEmitter signal → yield user prompt → parse response → resolve promise
   - Pattern: Persistent session stays alive between requests

4. **Filter Query Flow:**
   ```typescript
   runFilterQuery(sessionDbId, userPrompt) {
     // Queue request
     queue.requests.push({ userPrompt, resolve, reject });
     queue.emitter.emit('request');

     // Wait for response (30s timeout)
     return Promise.race([
       new Promise((resolve, reject) => { /* queued */ }),
       timeout(30000)
     ]);
   }
   ```

5. **Response Processing:**
   - `processJitFilterResponse()`: Accumulate streaming text
   - Parse IDs: "1,5,23,41" or "NONE"
   - Resolve queued promise with ID array

**Added Files:**
- `src/services/worker/SDKAgent.ts`: +291 lines
- `src/services/worker-types.ts`: +3 fields (jit state tracking)
- `src/services/worker/SessionManager.ts`: +26 lines (JIT cleanup)
- `src/services/worker-service.ts`: +102 lines (JIT initialization)
- `src/shared/settings.ts`: +65 lines (JIT config)
- `src/hooks/jit-context-hook.ts`: +208 lines (orchestration)
- `docs/jit-context-architecture-fix.md`: +265 lines
- `context/session-pattern-parity.md`: +298 lines

**Total Changes:** 18 files, +2,852 lines, -133 lines

**Final Status at Revert:** Implementation was complete and likely functional, but...

## Why It Failed

### 1. Architectural Complexity Explosion

**Problem:** The persistent session pattern added enormous complexity for marginal benefit.

**Evidence:**
- Parallel session management: Regular + JIT sessions running concurrently
- Complex coordination: EventEmitter + promise queues + generator pattern
- Lifecycle coupling: Session init, request handling, cleanup all intertwined
- State explosion: 3 new fields per session (`jitSessionId`, `jitAbortController`, `jitGeneratorPromise`)

**Code Smell:** When the "optimization" requires 300 lines of coordination code, it's probably not an optimization.

### 2. Premature Optimization

**YAGNI Violation:** Built elaborate token caching and persistent session architecture before proving the feature provided value.

**Reality Check:**
- **Current approach:** Load 50 observations = ~25KB context, works fine
- **JIT overhead:** Haiku query = 1-2s latency + coordination complexity
- **User benefit:** Unclear—users haven't complained about context relevance
- **Token savings:** Marginal—Claude caches long contexts efficiently anyway

**Quote from CLAUDE.md:**
> "Write the dumb, obvious thing first. Add complexity only when you actually hit the problem."

We didn't hit a problem. We invented one.

### 3. Implementation Complexity, Not Vision

**The Vision is Sound:**
- Dynamic context is better than static context
- Timeline search API exists and is fast
- Infrastructure (SQLite + Chroma) can support this
- Replacing session-start context with prompt-specific context makes sense

**The Problem:**
We jumped to the complex persistent-session approach without trying the simple per-request approach first.

**What We Should Have Done:**
```typescript
// Simple version (not tried):
app.post('/sessions/:id/init', async (req, res) => {
  const { userPrompt } = req.body;

  // Query timeline search API (already exists, fast)
  const timeline = await timelineSearch(project, userPrompt, depth=10);

  // Return observations
  return res.json({ context: timeline });
});
```

**This would have:**
- Validated the feature's value quickly
- Used existing infrastructure
- Avoided all the persistence complexity
- Taken 30 minutes instead of 3.5 hours

### 4. Pattern Divergence

**Inconsistency:** JIT sessions work fundamentally differently from memory sessions.

**Memory Session Pattern:**
```typescript
// One-shot: Init → Process observations → Complete
startSession() → yield prompts → parse responses → complete
```

**JIT Session Pattern:**
```typescript
// Persistent: Init → Wait indefinitely → Process on-demand → Complete
startJitSession() → yield initial load → LOOP:
  - Wait for EventEmitter signal
  - Yield filter request
  - Parse response
  - Resolve promise
  - GOTO LOOP
```

**Maintenance Burden:** Two completely different session patterns means:
- Doubled testing complexity
- Increased cognitive load for contributors
- Higher risk of subtle bugs in lifecycle management

**Session Pattern Parity Document:** The 298-line `session-pattern-parity.md` was created to document the differences—a sign that maybe they shouldn't be different.

### 5. Blocking I/O in Critical Path

**Performance Impact:** Every user prompt now blocks for 1-2s waiting for Haiku filtering.

**Current Flow:**
```
User types prompt → 10ms → Claude responds
```

**JIT Flow:**
```
User types prompt → 10ms init → 1-2s Haiku filter → Claude responds
```

**User Experience:** We added 1-2 seconds of latency to every interaction for questionable benefit.

**Alternative:** If context filtering is valuable, do it asynchronously and apply to next prompt.

### 6. Missing the Forest for the Trees

**Real Issue:** We focused on technical implementation without asking strategic questions:

- **Is context relevance actually a problem?** No evidence.
- **Do users want this?** No feedback requested.
- **Is 50 observations too many?** Not proven.
- **Does filtering improve responses?** Not tested.

**Anti-Pattern:** Solution in search of a problem.

## What We Should Have Done

### Option 1: Don't Build It

**Justification:** No validated user need. Current system works fine.

**Next Step:** Wait for user feedback indicating context relevance is an issue.

### Option 2: Simple MVP

If we really wanted to explore this:

1. **Week 1:** Add basic filtering in worker with one-shot queries
   - Accept slight performance hit (~500ms overhead)
   - Measure filter accuracy and user impact
   - Gather feedback

2. **Week 2:** If proven valuable, optimize
   - Add token caching only if needed
   - Consider persistent sessions only if performance is bottleneck

3. **Week 3:** If still valuable, scale
   - Polish error handling
   - Add configuration options
   - Document patterns

**Philosophy:** Incremental validation, not big-bang architecture.

### Option 3: Different Approach Entirely

**Alternative:** Pre-computed relevance scores

Instead of on-demand filtering:
- Score observations at creation time (save-hook)
- Store relevance embeddings in Chroma
- At session start, query Chroma with user's first prompt
- Load top 10-20 most relevant observations
- No runtime latency, better accuracy, simpler architecture

**Benefit:** Leverages existing Chroma infrastructure, avoids runtime overhead.

## Technical Lessons Learned

### 1. EventEmitter Coordination Anti-Pattern

**Code:**
```typescript
queue.emitter.on('request', () => {
  // Wake up generator to process request
});
```

**Issue:** Complex async coordination using event-driven wakeup signals is hard to reason about.

**Better:** Use async queues or channels (e.g., `async-queue` package) that handle coordination internally.

### 2. Generator Pattern Complexity

**Pattern:**
```typescript
async *createJitMessageGenerator() {
  yield initialPrompt;
  while (!aborted) {
    await waitForEvent();  // Blocks here
    yield nextRequest;
  }
}
```

**Tradeoff:** Generators are great for iteration, but terrible for event-driven request/response patterns.

**Better:** Use explicit session object with `sendMessage()/waitForResponse()` methods.

### 3. Dual Session Management

**Complexity:** Managing two concurrent SDK sessions per user session is inherently complex.

**Alternatives Considered:**
- Single session handling both observations and filtering (rejected: tight coupling)
- Separate service for filtering (rejected: too much infrastructure)
- Pre-computed filtering (not considered: should have been)

**Lesson:** When parallel state management feels hard, question whether you need parallel state.

### 4. Promise Queue Pattern

**Implementation:**
```typescript
interface QueuedRequest {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
}
queue.push({ resolve, reject });
// Later...
queue[0].resolve(result);
```

**Good:** Clean async API for callers
**Bad:** Easy to leak promises if error handling isn't perfect
**Improvement:** Use libraries like `p-queue` that handle edge cases

## Process Lessons Learned

### 1. No Incremental Validation

**Mistake:** Went from "idea" to "complete architecture" without validation points.

**Better Process:**
1. Write one-pager explaining user value
2. Build simplest possible version (2 hours max)
3. Test with real usage
4. Measure impact
5. Decide: kill, iterate, or scale

**Checkpoint Questions:**
- After 1 hour: "Does this solve a real problem?"
- After 2 hours: "Is this getting too complex?"
- After 3 hours: "Should I just ship the simple version?"

### 2. Architecture Astronomy

**Definition:** Designing elaborate systems without building/testing them.

**Evidence:**
- 265-line architecture doc written before any code
- 298-line session pattern parity analysis
- Multiple complete rewrites of the same feature

**Better:** Code first, document later. Spike solutions, learn from implementation.

### 3. Sunk Cost Fallacy

**Timeline:**
- **Hour 1:** "This seems complex but achievable"
- **Hour 2:** "We're halfway done, can't stop now"
- **Hour 3:** "Just need to fix this one coordination issue"
- **Hour 4:** "It's working, but... this feels wrong"

**Correct Decision:** Revert. Took courage to throw away 4 hours of work.

**Learning:** Time invested is not a reason to continue. Quality of outcome matters more.

### 4. Missing User Feedback Loop

**No User Input:**
- Didn't ask: "Is context relevance a problem for you?"
- Didn't test: "Does filtered context improve your responses?"
- Didn't measure: "Are you hitting context limits?"

**Engineering Theater:** Building impressive-sounding features without user validation.

## What We Actually Learned (The Real Value)

Despite reverting, this was productive R&D:

### 1. Deep Understanding of Hook Architecture

**Critical Discovery:** Hooks run in sandboxed environment without `claudePath`.
- Hooks cannot call Agent SDK `query()` directly
- All AI processing must happen in worker service
- This architectural constraint is now documented

**Learned Pattern:**
```
Hook (orchestration) → Worker (AI processing)
✓ save-hook: Captures data → Worker processes with SDK
✓ new-hook: Creates session → Worker returns confirmation
✗ jit-hook: Tried SDK in hook → Failed, no claudePath
```

**Value:** Future features will avoid this mistake. We now know the boundary.

### 2. Worker Architecture Patterns

**Blocking vs. Non-Blocking:**
- SessionStart: Can be non-blocking (context loads async)
- UserPromptSubmit: Must be blocking (session must exist before processing)
- JIT Context: Must be blocking (context needed before prompt processed)

**Established Pattern:**
```typescript
// Worker endpoint for features requiring AI
app.post('/sessions/:id/operation', async (req, res) => {
  const { operationData } = req.body;
  const result = await sdkAgent.performOperation(operationData);
  return res.json({ result });
});
```

### 3. Persistent Session Management

**Architecture Knowledge Gained:**
- How to maintain long-lived SDK sessions
- EventEmitter coordination patterns for request/response
- Promise queue management for async operations
- Proper cleanup with AbortControllers

**Pattern Documented:**
- Dual session management (regular + JIT)
- Generator-based message loops
- Request queuing with timeouts

**Value:** When we build the simpler version, we'll know these patterns.

### 4. Configuration Infrastructure

`src/shared/settings.ts` (65 lines) provides reusable configuration patterns:
```typescript
export function getConfigValue(key: string, defaultValue: string): string {
  // Priority: settings.json → env var → default
}
```

**Kept After Revert:** This module is useful for other features.

### 5. Key Architectural Decisions Made

**Decisions that will guide future implementation:**
1. JIT context filtering must happen in worker (proven via failed hook attempt)
2. Context must be blocking on UserPromptSubmit (session needs context before processing)
3. Dynamic timeline search is the right approach (fast, precise, leverages existing infrastructure)
4. Simple per-request queries should be tried before persistent sessions

### 6. Documentation Quality

- `jit-context-architecture-fix.md`: Documents why hooks can't run SDK queries
- `session-pattern-parity.md`: Reference for implementing dual sessions
- Hooks reference: Comprehensive hook documentation added

**Value:** These docs help future contributors understand the system constraints.

### 7. Infrastructure Validation

**Confirmed that our search stack is ready:**
- SQLite FTS5: Fast full-text search (<50ms)
- ChromaDB: Semantic search (<200ms with 8,000+ vectors)
- Timeline search API: Already implemented and tested
- Worker service: Can handle synchronous AI operations

**The infrastructure exists. We just need a simpler integration.**

## Recommendations

### Immediate Actions

1. **Archive the work:**
   - Keep `failed/jit-context` branch for reference
   - Extract reusable components (settings.ts)
   - Save architecture docs for future features

2. **Document the anti-patterns:**
   - Add this post-mortem to CLAUDE.md references
   - Update coding standards with lessons learned

3. **Reset focus:**
   - Return to validated user needs
   - Prioritize features with clear value propositions

### Future Feature Development

**Gating Questions (Answer before coding):**

1. **User Value:** What specific user problem does this solve?
2. **Evidence:** Have users requested this or reported the underlying issue?
3. **Measurement:** How will we know if it's successful?
4. **Simplicity:** What's the dumbest version that could work?
5. **Time Limit:** If we can't prove value in 2 hours, should we build it?

**Process:**

```
VALIDATE → BUILD SIMPLE → TEST → MEASURE → DECIDE
   ↑                                          ↓
   └──────────── ITERATE OR KILL ────────────┘
```

### If Context Filtering Returns

Should we revisit this idea in the future:

**Prerequisites:**
- User feedback requesting better context relevance
- Metrics showing current context is too broad
- Evidence that filtering improves response quality

**Simple Approach:**
```typescript
// In worker-service.ts /sessions/:id/init
if (jitEnabled) {
  const observations = await db.getRecentObservations(project, 50);
  const filtered = await simpleFilter(observations, userPrompt);  // One-shot query
  return { context: filtered };
}
```

**Acceptance Criteria:**
- <100 lines of code
- <500ms latency impact
- No new session types
- Degrades gracefully on errors

**If that works:** Then consider optimization.

## Conclusion

JIT context filtering failed not because the vision was wrong, but because we jumped to the complex implementation without validating the simple one first. The feature aligns with long-term goals (dynamic, prompt-specific context using our fast search infrastructure), but the persistent-session architecture was premature optimization.

**The right call:** Revert the complex implementation. Build the simple version when ready.

**Key Takeaway:** The vision is sound. The execution was overcomplicated. We now have:
- Deep knowledge of hook/worker architecture constraints
- Documented patterns for persistent SDK sessions
- Validated fast search infrastructure
- Clear understanding of what to build next time (simple timeline search API integration)

**This was R&D, not failure.** We learned what doesn't work (SDK in hooks), what does work (worker-based AI processing), and how to approach it next time (simple API calls before persistent sessions).

**Next Implementation:**
When we revisit this (and we should), start with:
1. Worker endpoint that accepts prompt
2. Queries existing timeline search API
3. Returns context
4. Hook injects context
5. Validate it improves responses
6. Then optimize if needed

**Final Thought:** Sometimes you have to build the wrong thing to understand the right thing. That's R&D.

---

**Branch Status:**
- `feature/jit-context`: Abandoned
- `failed/jit-context`: Archived for reference
- `main`: Stable at v5.4.0

**Files to Keep:**
- `src/shared/settings.ts`: Reusable config utilities

**Files Discarded:**
- Everything else (+2,850 lines)

**Emotional State:** Relieved. Dodged a maintenance nightmare.
