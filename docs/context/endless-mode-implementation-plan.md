# Endless Mode: Implementation Plan

## Current State (experiment/endless-mode branch)

**✅ Infrastructure Complete:**
- `TransformLayer.ts` - In-memory message transformation logic
- `EndlessModeConfig.ts` - Configuration loading from settings.json
- `tool_use_id` tracking in database and save-hook
- Database schema supports `tool_use_id` column

**❌ Missing Critical Components:**
1. No synchronous observation endpoint (current endpoint queues and returns immediately)
2. No transcript file transformation (TransformLayer only works in-memory for SDK)
3. No blocking behavior in save-hook (still async/fire-and-forget)

**The Gap:** Architecture is documented in `endless-mode-blocking-hooks-plan.md`, but implementation is incomplete. We have infrastructure but not the critical blocking + transformation logic.

---

## Phase 1: Synchronous Observation Endpoint

**File**: `src/services/worker-service.ts`

### Objective
Create a new endpoint that WAITS for observation creation and returns the observation data, enabling the save-hook to block until compression is complete.

### Tasks

1. **Add new route**
   ```typescript
   POST /sessions/:sessionDbId/observations?wait_until_obs_is_saved=true
   ```

2. **Create `handleObservationsSync()` handler** that:
   - Queues observation (like current `handleObservations`)
   - **WAITS** for observation to be created by SDK agent
   - Returns full observation data `{ observation: {...}, processing_time_ms: number }`
   - Returns `null` on timeout (90s max)
   - Falls back to async behavior if timeout exceeded

3. **Implement wait mechanism**
   - Option A: Poll database for observation by `tool_use_id`
   - Option B: Event emitter when observation is saved
   - Option C: Promise that resolves when SessionManager completes observation

### Success Criteria
- Endpoint returns observation data within 60-90s
- Endpoint returns null and falls back gracefully on timeout
- No blocking of worker event loop (use proper async/await)

---

## Phase 2: Transcript Transformation

**File**: `src/hooks/save-hook.ts`

### Objective
Transform the transcript JSONL file on disk by replacing full tool results with compressed observation markdown BEFORE the hook returns.

### Tasks

1. **Create `transformTranscript()` function**
   ```typescript
   async function transformTranscript(
     transcriptPath: string,
     toolUseId: string,
     observation: CompressedObservation
   ): Promise<void>
   ```

2. **Implement transformation logic**
   - Read transcript JSONL file
   - Parse entries line by line
   - Find the tool_result entry matching `tool_use_id`
   - Replace `result.content` with formatted observation markdown
   - Write back to disk atomically (temp file → rename)

3. **Add error handling**
   - Backup original transcript before transformation
   - Validate JSONL structure after write
   - Rollback on errors
   - Log transformation stats (original size, compressed size, savings %)

4. **Create markdown formatter**
   ```typescript
   function formatObservationAsMarkdown(obs: CompressedObservation): string
   ```
   - Include: title, subtitle, narrative, facts, concepts
   - Add footer: `[Compressed by Endless Mode]`

### Success Criteria
- Transcript file is modified on disk
- JSONL structure remains valid
- Compressed observation replaces full tool output
- Atomic writes prevent corruption
- Graceful error handling with rollback

---

## Phase 3: Conditional Blocking in save-hook

**File**: `src/hooks/save-hook.ts`

### Objective
Make the save-hook conditionally block based on Endless Mode configuration: wait for observation + transform transcript when enabled, async when disabled.

### Tasks

1. **Check Endless Mode status**
   - Import and use `EndlessModeConfig.getConfig()`
   - Read `enabled` flag from configuration

2. **Implement conditional logic**
   ```typescript
   if (endlessModeEnabled) {
     // BLOCKING PATH
     const observation = await createObservationSync(...);
     if (observation) {
       await transformTranscript(transcriptPath, toolUseId, observation);
     } else {
       logger.warn('Endless Mode: timeout, using full output');
     }
   } else {
     // NON-BLOCKING PATH (current behavior)
     await createObservationAsync(...);
   }
   ```

3. **Create helper functions**
   - `createObservationSync()` - calls sync endpoint, waits for response
   - `createObservationAsync()` - current fire-and-forget behavior

4. **Add timeout fallback**
   - If sync endpoint times out, log warning
   - Continue with full output (don't block Claude)
   - Observation will still be created async in background

### Success Criteria
- save-hook blocks when Endless Mode enabled
- save-hook remains async when disabled
- Fallback to async works on timeout
- No breaking changes to existing behavior

---

## Phase 4: Testing & Validation

### Objective
Verify end-to-end flow works correctly and achieves expected token reduction.

### Tasks

1. **Enable Endless Mode**
   - Create/update `~/.claude-mem/settings.json`
   - Set `env.CLAUDE_MEM_ENDLESS_MODE: true`

2. **Run test session**
   - Start new Claude Code session
   - Execute 5-10 tool uses (Read, Grep, Bash)
   - Monitor worker logs for observation creation
   - Check transcript file after each tool use

3. **Verify compression**
   - Inspect transcript JSONL file
   - Confirm tool results are replaced with observations
   - Measure token counts (before/after)
   - Calculate compression ratio

4. **Test fallback scenarios**
   - Simulate timeout (add artificial delay)
   - Verify graceful fallback to async
   - Ensure no transcript corruption

5. **Measure performance**
   - Observation creation time (should be <60s)
   - Transcript transformation time (should be <1s)
   - Overall hook execution time (should be <120s)

### Success Criteria
- Transcript shows compressed observations, not full outputs
- Claude resumes with compressed context
- 80-95% token reduction achieved
- No race conditions or file corruption
- Timeout fallback works without breaking sessions

---

## Success Metrics

**Technical:**
- [ ] Sync endpoint returns observation within 60-90s
- [ ] Transcript file is transformed on disk before hook returns
- [ ] JSONL structure remains valid after transformation
- [ ] Fallback to async works on timeout

**Functional:**
- [ ] Claude resumes with compressed context
- [ ] Context window doesn't fill up after 50+ tool uses
- [ ] Sessions can run indefinitely without hitting token limits

**Performance:**
- [ ] 80-95% token reduction measured in real sessions
- [ ] Hook execution stays under 120s timeout
- [ ] No noticeable latency impact on user experience

---

## Notes

- This completes the implementation described in `endless-mode-blocking-hooks-plan.md`
- The blocking approach superseded the earlier UserPromptSubmit hook approach
- TransformLayer.ts currently only handles in-memory SDK transformation, not on-disk transcript transformation
- After Phase 4 validation, can merge to main and enable for beta users
