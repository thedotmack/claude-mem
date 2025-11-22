# Endless Mode: Blocking Hooks & Transcript Transformation Plan

## Executive Summary

Endless Mode requires a fundamental architectural shift from **async/non-blocking** hook processing to **sync/blocking** hook processing. The PostToolUse hook must wait for observation generation to complete, transform the transcript file on disk to replace full tool results with compressed observations, and only then return control to Claude Code. This ensures Claude resumes with compressed context instead of accumulating full tool outputs.

**Key Insight**: Claude Code resumes state after every tool use by re-reading the transcript. Therefore, transformation must happen BEFORE the hook returns, not asynchronously in the background.

---

## Problem Statement

### Current Architecture (Non-Blocking)

```
1. Tool executes in Claude Code session
2. PostToolUse hook fires → save-hook.ts
3. save-hook sends tool data to worker via HTTP POST
4. Hook returns IMMEDIATELY (non-blocking)
   ↓
5. Claude Code resumes with FULL tool output in transcript
6. Worker processes observation asynchronously (too late!)
7. Observation stored in SQLite
8. Context window fills with uncompressed tool outputs
```

**Problem**: By the time the observation is created, Claude has already resumed with the full tool output. The observation only helps the NEXT session (via SessionStart injection), not the CURRENT session.

### Why This Breaks Endless Mode

**From observation #10052**: "Resume state occurs after every tool use via the postToolUse hook."

This means:
- Claude Code reads transcript after each PostToolUse hook completes
- If transcript contains full tool outputs → context window fills up
- If transcript contains compressed observations → context stays small
- **Transformation window**: Between observation creation and hook return

---

## Proposed Solution: Conditional Blocking Hooks

### New Architecture (Blocking in Endless Mode)

```
ENDLESS MODE ENABLED:
1. Tool executes in Claude Code session
2. PostToolUse hook fires → save-hook.ts
3. save-hook sends tool data to worker via HTTP POST
4. **WAIT for worker to generate observation (BLOCKING)**
   ↓
5. Worker creates observation synchronously
6. Worker returns observation to hook
7. Hook transforms transcript_path file on disk:
   - Read transcript.jsonl
   - Find latest tool_result entry
   - Replace with compressed observation markdown
   - Write back to transcript.jsonl
8. Hook returns to Claude Code
   ↓
9. Claude Code resumes with COMPRESSED transcript
10. Context window stays small - endless session possible!

ENDLESS MODE DISABLED (current behavior):
1. Tool executes
2. PostToolUse hook fires
3. save-hook sends to worker (fire-and-forget)
4. Hook returns IMMEDIATELY
5. Worker processes async in background
6. No transcript transformation
```

---

## Architecture Changes Required

### 1. Worker API: Synchronous Observation Endpoint

**New Endpoint**: `POST /sessions/{id}/observations/sync`

```typescript
// Current (async, returns immediately):
POST /sessions/{id}/observations
Response: 202 Accepted

// New (sync, waits for observation):
POST /sessions/{id}/observations/sync
Response: 200 OK
Body: {
  observation: {
    id: number,
    title: string,
    subtitle: string,
    narrative: string,
    facts: string[],
    concepts: string[],
    type: string
  },
  processing_time_ms: number
}
```

**Implementation**:
- Worker must process observation synchronously in request handler
- SDK agent query must complete within hook timeout (120s)
- Return compressed observation data to hook
- Fallback: If timeout, return null and use async processing

### 2. PostToolUse Hook: Conditional Blocking

**File**: `src/hooks/save-hook.ts`

```typescript
async function saveHook(input: PostToolUseInput): Promise<void> {
  const { session_id, tool_name, tool_input, tool_response, transcript_path } = input;

  // Check if Endless Mode is enabled
  const endlessMode = await isEndlessModeEnabled();

  if (endlessMode) {
    // BLOCKING PATH: Wait for observation and transform transcript
    const observation = await createObservationSync({
      sessionId,
      toolName,
      toolInput,
      toolResponse,
      promptNumber,
      toolUseId
    });

    if (observation) {
      // Transform transcript file on disk
      await transformTranscript(transcript_path, toolUseId, observation);
    } else {
      // Fallback: Observation creation timed out, continue with full output
      logger.warn('Endless Mode: Observation timeout, using full output');
    }
  } else {
    // NON-BLOCKING PATH: Current async behavior
    await createObservationAsync({
      sessionId,
      toolName,
      toolInput,
      toolResponse,
      promptNumber,
      toolUseId
    });
  }

  console.log(createHookResponse('PostToolUse', true));
}
```

### 3. Transcript Transformation Logic

**File**: `src/hooks/transcript-transform.ts`

```typescript
interface TranscriptEntry {
  type: 'user' | 'assistant' | 'result';
  message?: any;
  result?: any;
  tool_use_id?: string;
}

interface CompressedObservation {
  title: string;
  subtitle?: string;
  narrative: string;
  facts: string[];
  concepts: string[];
}

async function transformTranscript(
  transcriptPath: string,
  toolUseId: string,
  observation: CompressedObservation
): Promise<void> {
  // 1. Read transcript JSONL file
  const content = await fs.readFile(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n');

  // 2. Parse entries and find tool_result matching tool_use_id
  const entries: TranscriptEntry[] = lines.map(line => JSON.parse(line));

  let transformed = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];

    // Find tool_result entry matching this tool_use_id
    if (entry.type === 'result' && entry.tool_use_id === toolUseId) {
      // 3. Replace full result with compressed observation
      entry.result = {
        type: 'text',
        text: formatObservationAsMarkdown(observation)
      };
      transformed = true;
      break;
    }
  }

  if (!transformed) {
    logger.warn('Could not find tool_result entry for transformation', { toolUseId });
    return;
  }

  // 4. Write transformed transcript back to disk
  const newContent = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(transcriptPath, newContent, 'utf-8');

  logger.info('Transcript transformed', {
    toolUseId,
    originalSize: content.length,
    compressedSize: newContent.length,
    savings: `${Math.round((1 - newContent.length / content.length) * 100)}%`
  });
}

function formatObservationAsMarkdown(obs: CompressedObservation): string {
  const parts: string[] = [];

  if (obs.title) {
    parts.push(`# ${obs.title}`);
  }

  if (obs.subtitle) {
    parts.push(`*${obs.subtitle}*`);
  }

  if (obs.narrative) {
    parts.push(`\n${obs.narrative}`);
  }

  if (obs.facts && obs.facts.length > 0) {
    parts.push(`\n**Key Facts:**`);
    obs.facts.forEach(fact => parts.push(`- ${fact}`));
  }

  if (obs.concepts && obs.concepts.length > 0) {
    parts.push(`\n**Concepts:** ${obs.concepts.join(', ')}`);
  }

  parts.push(`\n---`);
  parts.push(`*[Compressed by Endless Mode]*`);

  return parts.join('\n');
}
```

### 4. Configuration Management

**File**: `src/services/worker/EndlessModeConfig.ts` (already exists)

Add hook-side configuration check:

```typescript
// In hooks (Node.js environment, no worker running yet)
export function isEndlessModeEnabled(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');

  try {
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const enabled = settings.env?.CLAUDE_MEM_ENDLESS_MODE;
      if (enabled === true || enabled === 'true') return true;
    }
  } catch {
    // Fall through to env var
  }

  return process.env.CLAUDE_MEM_ENDLESS_MODE === 'true';
}
```

---

## Implementation Plan

### Phase 1: Worker Synchronous Observation Endpoint (Week 1)

**Goal**: Enable worker to process observations synchronously and return results

Tasks:
1. Create new `/sessions/{id}/observations/sync` endpoint in worker-service.ts
2. Refactor observation creation logic to be synchronous (await SDK query completion)
3. Add timeout handling (if SDK takes >90s, abort and return null)
4. Return observation data structure to caller
5. Add metrics tracking (sync vs async processing times)

**Deliverable**: Worker can create observations synchronously within 60-90s

### Phase 2: Transcript Transformation Logic (Week 1-2)

**Goal**: Implement safe, tested transcript file transformation

Tasks:
1. Create `transcript-transform.ts` module in `src/hooks/`
2. Implement `transformTranscript()` function with JSONL parsing
3. Implement `formatObservationAsMarkdown()` for compressed output
4. Add safety checks (file locking, backup, rollback on error)
5. Write unit tests for transformation logic
6. Test with real transcript files from Claude Code sessions

**Deliverable**: Tested transcript transformation that can compress tool results

### Phase 3: Conditional Blocking in PostToolUse Hook (Week 2)

**Goal**: Wire conditional blocking into save-hook.ts

Tasks:
1. Update save-hook.ts with `isEndlessModeEnabled()` check
2. Implement blocking path (call sync endpoint, wait for observation, transform)
3. Implement non-blocking path (current behavior as fallback)
4. Add comprehensive error handling and logging
5. Add timeout handling (if worker takes too long, fallback to async)
6. Performance monitoring (track how long hooks block)

**Deliverable**: PostToolUse hook conditionally blocks in Endless Mode

### Phase 4: Stop Hook Transformation (Week 2-3)

**Goal**: Apply same blocking pattern to Stop hook for summaries

Tasks:
1. Update summary-hook.ts with conditional blocking
2. Create synchronous summary endpoint in worker
3. Transform transcript to include session summary
4. Test summary generation doesn't timeout hooks

**Deliverable**: Stop hook also blocks for summary generation in Endless Mode

### Phase 5: Testing & Validation (Week 3-4)

**Goal**: Verify Endless Mode works end-to-end

Tasks:
1. Enable Endless Mode in test environment
2. Run long session (50+ tool uses) and monitor context window
3. Verify transcript file shows compressed observations
4. Measure hook blocking times (should be <90s per tool)
5. Test worker timeouts and fallback behavior
6. Verify non-Endless Mode still works (async, non-blocking)
7. Edge case testing (worker crashes, network issues, malformed responses)

**Deliverable**: Endless Mode working in test environment with verified compression

### Phase 6: Performance Optimization (Week 4+)

**Goal**: Reduce blocking time to acceptable levels

Tasks:
1. Optimize SDK query performance (faster observation generation)
2. Parallel processing where possible (don't wait for Chroma sync)
3. Caching strategies (reuse SDK sessions across observations)
4. Consider progressive compression (compress older entries async)
5. Monitor and tune timeout values

**Deliverable**: Hooks block <60s on average, <90s worst case

---

## Technical Requirements

### Hook Timeout Constraints

Claude Code hooks have maximum timeout values:
- PostToolUse: 120s (2 minutes)
- Stop: 120s (2 minutes)

Worker must complete observation generation within timeout minus overhead:
- Target: 60-90s for observation creation
- Reserve: 10-30s for transcript transformation and I/O
- Safety margin: 20s buffer

### Transcript File Format

Claude Code maintains transcript as newline-delimited JSON (JSONL):

```jsonl
{"type":"user","message":{"role":"user","content":"Read the file"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_123","name":"Read","input":{"file_path":"..."}}]}}
{"type":"result","tool_use_id":"toolu_123","result":{"type":"text","text":"[file contents here - potentially huge]"}}
```

Transformation replaces the `result` entry:

```jsonl
{"type":"result","tool_use_id":"toolu_123","result":{"type":"text","text":"# File Read Operation\n*Read configuration file*\n\nFile contains database credentials...\n**Key Facts:**\n- Database host: localhost\n...\n---\n*[Compressed by Endless Mode]*"}}
```

### Worker API Contract

**Request**: `POST /sessions/{id}/observations/sync`
```json
{
  "tool_name": "Read",
  "tool_input": "{\"file_path\":\"...\"}",
  "tool_response": "{\"content\":\"...\"}",
  "prompt_number": 5,
  "cwd": "/path/to/project",
  "tool_use_id": "toolu_123"
}
```

**Response** (success):
```json
{
  "observation": {
    "id": 1234,
    "title": "File Read Operation",
    "subtitle": "Read configuration file",
    "narrative": "File contains database credentials...",
    "facts": ["Database host: localhost", "..."],
    "concepts": ["discovery", "how-it-works"],
    "type": "discovery"
  },
  "processing_time_ms": 45000
}
```

**Response** (timeout/error):
```json
{
  "observation": null,
  "processing_time_ms": 90000,
  "error": "SDK query timeout after 90s"
}
```

---

## Risks and Mitigations

### Risk 1: Hook Timeouts

**Risk**: Observation generation takes >120s, hook times out, Claude Code errors

**Mitigation**:
- Set worker timeout to 90s (leave 30s buffer)
- If timeout, return null and fallback to async processing
- Log timeout events for monitoring
- Optimize SDK query performance to stay under 60s average

### Risk 2: Transcript File Corruption

**Risk**: Transformation fails mid-write, corrupts transcript, breaks session

**Mitigation**:
- **Atomic writes**: Write to temp file, then rename (atomic on Unix)
- **Backup**: Copy original transcript before transformation
- **Validation**: Parse transformed transcript to verify valid JSONL
- **Rollback**: If validation fails, restore backup
- **Extensive testing**: Test with malformed transcripts, partial writes, etc.

### Risk 3: Performance Degradation

**Risk**: Blocking hooks slow down Claude Code sessions noticeably

**Mitigation**:
- Make Endless Mode opt-in (disabled by default)
- Optimize worker to complete in <60s (most observations should be faster)
- Monitor hook execution times and alert if approaching timeout
- Provide user feedback (spinner or progress indicator during blocking)
- Consider progressive enhancement (compress first N quickly, rest async)

### Risk 4: Worker Unavailability

**Risk**: Worker crashed/stopped, blocking hook waits forever

**Mitigation**:
- Short timeout (90s max) - don't block indefinitely
- Fallback to async processing if sync endpoint unavailable
- Auto-restart worker on hook execution (already implemented)
- Health check before attempting sync call
- Graceful degradation (log error, continue with full output)

### Risk 5: Information Loss

**Risk**: Compressed observation loses critical details needed later

**Mitigation**:
- Full tool output still preserved in worker's internal transcript
- Can always retrieve full data from observation database
- Make compression configurable (keep recent N tools uncompressed)
- Monitor conversation quality metrics
- Allow users to disable Endless Mode if quality degrades

### Risk 6: Race Conditions

**Risk**: Multiple tools execute in parallel, concurrent transcript modifications

**Mitigation**:
- File locking during transformation (flock on Unix)
- Retry logic if file locked (exponential backoff)
- Sequential processing (tools execute one at a time in Claude Code)
- Validate tool_use_id uniqueness before transformation

---

## Configuration

### Environment Variables

```bash
# Enable Endless Mode (default: false)
CLAUDE_MEM_ENDLESS_MODE=true

# Sync observation timeout (default: 90000ms = 90s)
CLAUDE_MEM_SYNC_TIMEOUT=90000

# Fallback behavior if sync fails (default: true)
CLAUDE_MEM_SYNC_FALLBACK=true

# Keep recent N tools uncompressed (default: 0)
CLAUDE_MEM_KEEP_RECENT=0

# Backup transcript before transformation (default: true)
CLAUDE_MEM_BACKUP_TRANSCRIPT=true
```

### Settings File

`~/.claude-mem/settings.json`:
```json
{
  "env": {
    "CLAUDE_MEM_ENDLESS_MODE": true,
    "CLAUDE_MEM_SYNC_TIMEOUT": 90000,
    "CLAUDE_MEM_SYNC_FALLBACK": true,
    "CLAUDE_MEM_KEEP_RECENT": 0,
    "CLAUDE_MEM_BACKUP_TRANSCRIPT": true
  }
}
```

---

## Success Criteria

### Proof of Concept Success

- [ ] Worker can generate observations synchronously in <90s
- [ ] Transcript transformation replaces tool_result entries correctly
- [ ] PostToolUse hook blocks until transformation completes
- [ ] Transformed transcript is valid JSONL
- [ ] Claude Code resumes with compressed context
- [ ] No transcript corruption in 100+ transformations
- [ ] Fallback to async works when sync times out

### Beta Release Success

- [ ] 10+ users running Endless Mode without corruption issues
- [ ] Average hook blocking time: <60s
- [ ] Context window savings: 80%+ vs non-Endless Mode
- [ ] Transcript transformation success rate: >99%
- [ ] Zero data loss incidents
- [ ] User-reported quality remains high

### Production Success

- [ ] Endless Mode becomes default setting (opt-out instead of opt-in)
- [ ] Sessions running for weeks without context issues
- [ ] Hook blocking time: <45s average
- [ ] Fallback to async: <1% of observations
- [ ] Context window exhaustion becomes rare edge case

---

## Open Questions

1. **SDK Performance**: Can we optimize observation generation to consistently complete in <60s?
2. **Transcript Format**: Are there edge cases in transcript JSONL structure we haven't considered?
3. **File Locking**: Does Claude Code lock transcript file during writes? Need to coordinate?
4. **Partial Compression**: Should we compress ALL tool results, or keep recent N uncompressed?
5. **User Experience**: Should we show progress indicator during blocking? ("Compressing context...")
6. **Rollout Strategy**: Beta users only? Gradual rollout by percentage?
7. **Monitoring**: What metrics should we track to detect issues early?

---

## Next Steps

### Immediate (This Week)

1. ✅ Document plan and save to docs/context/
2. Create `/sessions/{id}/observations/sync` endpoint in worker
3. Build `transcript-transform.ts` module with basic functionality
4. Add `isEndlessModeEnabled()` configuration check
5. Write unit tests for transcript parsing and transformation

### Short Term (Next 2 Weeks)

1. Wire sync endpoint into save-hook.ts with conditional logic
2. Test with real Claude Code sessions
3. Measure blocking times and optimize if needed
4. Implement error handling and fallback logic
5. Create backup/restore mechanism for transcript safety

### Medium Term (Next Month)

1. Extend to Stop hook (summary compression)
2. Beta release to selected users
3. Monitor performance and quality metrics
4. Iterate based on feedback
5. Optimize to reduce blocking time to <45s

---

## Conclusion

Endless Mode requires **blocking hooks** to transform the transcript file before Claude Code resumes. This is a fundamental architectural shift from async/non-blocking processing to sync/blocking processing, conditionally enabled via feature flag.

The key architectural insight: **Claude Code resumes after every tool use by re-reading the transcript**. Therefore, compression must happen BEFORE the hook returns, not asynchronously afterward. This makes PostToolUse (and Stop) the ONLY viable integration points for Endless Mode.

By making hooks block until observations are generated and transcripts are transformed, we enable truly endless sessions where context window usage stays constant regardless of session length. Combined with safety mechanisms (timeouts, fallbacks, atomic writes), this provides a robust path to infinite-length Claude sessions.

This is the natural evolution of claude-mem: from remembering the past, to making it possible to never stop working.
