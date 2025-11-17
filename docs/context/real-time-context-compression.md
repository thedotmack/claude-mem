# Endless Mode: Real-Time Context Compression Plan

## Executive Summary

"Endless Mode" is an optional feature that enables Claude sessions to run indefinitely by transparently compressing tool use transcripts in real-time. Using an in-memory transformation layer in the worker service, heavy tool outputs are dynamically replaced with lightweight observations during session resume—without modifying the immutable source transcripts. This allows sessions to continue for weeks or months without hitting context window limits, while preserving full conversation history and maintaining zero risk of data corruption.

---

## Problem Statement

### Current Behavior

Claude sessions accumulate full tool transcripts in the context window:
- File reads: 5k-10k tokens per read
- Bash outputs: 1k-5k tokens per command
- Search results: 2k-8k tokens per search
- Total context limit: ~200k tokens

When the context window fills, users must start a new session, losing conversational continuity.

### What Happens Today

1. Tool executes during session
2. PostToolUse hook captures tool data
3. Worker creates compressed observation (~200-500 tokens)
4. **But**: Full tool transcript stays in Claude's context window
5. **Observation only helps next session** via SessionStart injection

### The Gap

Observations exist and are created in real-time, but they're not used to compress the **current** session's context. We have the compressed data, we just don't apply it to the active session.

---

## Proposed Solution: Endless Mode

### Core Concept

When a session resumes (either after restart or during continuation), **transform messages in memory** by replacing heavy tool use content with lightweight observations before feeding them to the Agent SDK. The source transcript remains immutable on disk.

### Architecture Principle

**Immutable Storage + Ephemeral Transform = Safe Compression**

```
Disk (never modified)     Memory (transform)          Agent SDK
──────────────────────    ──────────────────────      ────────────────
transcript.jsonl          Load messages               Resume session
  tool_use_abc      →     Look up observation   →     with compressed
  tool_use_def            Replace content             context
  tool_use_xyz            Feed to SDK
```

### Key Properties

1. **Immutable**: Original transcripts never modified
2. **Non-destructive**: Full history preserved on disk
3. **No duplication**: No forks, no copies
4. **Transparent**: User sees same conversation, compression is under the hood
5. **Optional**: Feature flag allows users to opt-in/out
6. **Reversible**: Can always read original transcript

---

## How It Works

### Session Resume Flow (Endless Mode Enabled)

```
1. User continues session / Claude Code restarts
   ↓
2. Worker service intercepts resume request
   ↓
3. Load transcript JSONL from disk (immutable)
   ↓
4. Transform Loop:
   For each message in transcript:
     - If tool_use message:
       - Query SQLite: SELECT observation WHERE tool_use_id = ?
       - Replace tool content with observation (facts, narrative, concepts)
     - If other message type:
       - Pass through unchanged
   ↓
5. Feed transformed messages to Agent SDK
   ↓
6. Agent SDK resumes session with compressed context
   ↓
7. New tool uses append to original transcript (normal flow)
   ↓
8. Next resume: Loop repeats, new tool uses also get compressed
```

### Session Resume Flow (Endless Mode Disabled)

```
1. User continues session
   ↓
2. Load transcript JSONL from disk
   ↓
3. Feed messages directly to Agent SDK (no transformation)
   ↓
4. Session resumes with full tool transcripts (current behavior)
```

---

## Implementation Plan

### Phase 1: Foundation (Week 1)

**Goal**: Set up infrastructure for transformation layer

Tasks:
1. Add `tool_use_id` column to observations table (SQLite schema migration)
2. Update PostToolUse hook to capture and store tool_use_id
3. Create `TransformLayer` class in worker service
4. Add `CLAUDE_MEM_ENDLESS_MODE` environment variable (default: false)
5. Write tests for observation lookup by tool_use_id

**Deliverable**: Database schema updated, tool_use_ids being captured

### Phase 2: Transform Logic (Week 2)

**Goal**: Build message transformation engine

Tasks:
1. Implement `TransformLayer.transformMessages(messages)` function
2. Tool use detection logic (identify tool_use messages in transcript)
3. Observation lookup and replacement logic
4. Fallback handling (if observation missing, keep original content)
5. Message serialization/deserialization

**Deliverable**: Working transform function that compresses messages in memory

### Phase 3: Agent SDK Integration (Week 2-3)

**Goal**: Wire transform layer into session resume flow

Tasks:
1. Identify where worker service resumes Agent SDK sessions
2. Inject transform layer before session resume
3. Add feature flag check (only transform if endless mode enabled)
4. Logging and instrumentation (track compression ratios, transform time)
5. Error handling and graceful degradation

**Deliverable**: Worker service can resume sessions with compressed context

### Phase 4: Testing & Validation (Week 3-4)

**Goal**: Verify endless mode works correctly

Tasks:
1. Create test session with 50+ tool uses
2. Enable endless mode and resume session
3. Verify context window usage (should be dramatically lower)
4. Test conversation quality (does Claude have enough context?)
5. Measure performance (transform latency, lookup speed)
6. Edge case testing (missing observations, malformed transcripts)

**Deliverable**: Endless mode working in test environment

### Phase 5: Beta Release (Week 4+)

**Goal**: Release to power users for feedback

Tasks:
1. Documentation (how to enable, what to expect, how to disable)
2. Add endless mode toggle to viewer UI
3. Monitoring and observability (track usage, failures, compression stats)
4. Collect feedback from beta users
5. Iterate based on real-world usage

**Deliverable**: Endless mode available as opt-in beta feature

---

## Technical Requirements

### Database Schema

```sql
-- Add to observations table
ALTER TABLE observations ADD COLUMN tool_use_id TEXT UNIQUE;
CREATE INDEX idx_observations_tool_use_id ON observations(tool_use_id);
```

### Worker Service API

```typescript
interface TransformLayerConfig {
  enabled: boolean; // CLAUDE_MEM_ENDLESS_MODE
  fallbackToOriginal: boolean; // If observation missing, use full content
  maxLookupTime: number; // Timeout for SQLite queries
}

class TransformLayer {
  constructor(config: TransformLayerConfig, db: SessionStore);

  // Main transform function
  async transformMessages(messages: Message[]): Promise<Message[]>;

  // Helper functions
  private async lookupObservation(toolUseId: string): Promise<Observation | null>;
  private replaceToolContent(message: Message, observation: Observation): Message;
  private isToolUseMessage(message: Message): boolean;
}
```

### Agent SDK Integration Point

```typescript
// In worker service session resume logic
async function resumeSession(sessionId: string, transcriptPath: string) {
  const messages = await loadTranscript(transcriptPath);

  // Transform layer (only if endless mode enabled)
  const transformedMessages = config.endlessMode
    ? await transformLayer.transformMessages(messages)
    : messages;

  // Resume with transformed (or original) messages
  return await agentSDK.resumeSession({
    sessionId,
    messages: transformedMessages
  });
}
```

---

## Risks and Mitigations

### Risk 1: Information Loss

**Risk**: Compressed observations may lose critical details that Claude needs to reference later.

**Mitigation**:
- Make endless mode optional (users can disable if quality degrades)
- Improve observation quality (better prompts, more comprehensive facts)
- Hybrid approach: Keep recent N tool uses in full, compress older ones
- Monitor conversation quality metrics

### Risk 2: Transform Performance

**Risk**: Looking up observations for 100+ tool uses during resume could be slow.

**Mitigation**:
- Index tool_use_id in SQLite (O(log n) lookups)
- Batch queries (single SELECT with IN clause)
- Measure and optimize (target <100ms for typical session)
- Cache observations in memory during session

### Risk 3: Missing Observations

**Risk**: Tool use executed but observation not yet created (async worker lag).

**Mitigation**:
- Fallback to original content if observation missing
- Log when fallback occurs (helps identify worker performance issues)
- Allow observations to be created retroactively
- Consider synchronous observation creation for critical tools

### Risk 4: Transcript Corruption

**Risk**: Bug in transform layer could corrupt user conversations.

**Mitigation**:
- **Never modify source transcripts** (read-only)
- Transform happens in memory only
- Extensive testing before beta release
- Feature flag allows instant disable if issues found
- Keep full audit trail in logs

### Risk 5: Agent SDK Compatibility

**Risk**: Agent SDK updates could break transform layer integration.

**Mitigation**:
- Document exact Agent SDK version requirements
- Monitor Agent SDK release notes
- Test against new SDK versions before upgrading
- Graceful degradation if SDK changes detected

---

## Success Criteria

### Proof of Concept Success

- [ ] Transform layer successfully compresses a 50-tool-use session
- [ ] Context window usage reduced by 80%+ compared to uncompressed
- [ ] Session resumes without errors
- [ ] Conversation quality remains high (subjective evaluation)

### Beta Release Success

- [ ] 10+ users running endless mode without issues
- [ ] Average context savings: 85%+ across all sessions
- [ ] Transform latency: <200ms for typical resume
- [ ] Zero transcript corruption incidents
- [ ] Positive user feedback on conversation continuity

### Production Success

- [ ] Endless mode becomes default setting
- [ ] Sessions running for weeks/months without context issues
- [ ] Context window exhaustion becomes rare edge case
- [ ] User-reported "session too long" issues drop to near zero
- [ ] Transform layer performance scales to 1000+ tool use sessions

---

## Configuration

### Environment Variables

```bash
# Enable endless mode (default: false)
CLAUDE_MEM_ENDLESS_MODE=true

# Fallback behavior if observation missing (default: true)
CLAUDE_MEM_TRANSFORM_FALLBACK=true

# Max time to wait for observation lookup (default: 500ms)
CLAUDE_MEM_TRANSFORM_TIMEOUT=500

# Keep recent N tool uses uncompressed (default: 0, compress all)
CLAUDE_MEM_TRANSFORM_KEEP_RECENT=0
```

### User Controls

```typescript
// Future: UI toggle in viewer
interface EndlessModeSettings {
  enabled: boolean;
  keepRecentToolUses: number; // Hybrid mode
  fallbackToOriginal: boolean;
}
```

---

## Context Economics: Before vs. After

### Example Session (50 tool uses)

**Before (Endless Mode OFF):**
```
File reads:    10 × 8,000 tokens  = 80,000 tokens
Bash outputs:  20 × 2,000 tokens  = 40,000 tokens
Searches:      15 × 4,000 tokens  = 60,000 tokens
Other tools:    5 × 1,000 tokens  =  5,000 tokens
──────────────────────────────────────────────────
Total:                              185,000 tokens
Context remaining:                   15,000 tokens (92% full)
```

**After (Endless Mode ON):**
```
File reads:    10 ×   300 tokens  =  3,000 tokens
Bash outputs:  20 ×   250 tokens  =  5,000 tokens
Searches:      15 ×   400 tokens  =  6,000 tokens
Other tools:    5 ×   200 tokens  =  1,000 tokens
──────────────────────────────────────────────────
Total:                               15,000 tokens
Context remaining:                  185,000 tokens (7.5% full)

Savings: 170,000 tokens (92% reduction)
```

**Session Longevity:**
- Before: ~50 tool uses before context full
- After: ~600+ tool uses before context full
- **12x longer sessions**

---

## Next Steps

### Immediate Actions (This Week)

1. **Database Migration**: Add tool_use_id column to observations table
2. **Hook Update**: Modify PostToolUse hook to capture tool_use_id from Agent SDK
3. **Architecture Validation**: Confirm where Agent SDK session resume happens in worker service
4. **Prototype**: Build minimal TransformLayer class with observation lookup

### Short Term (Next 2 Weeks)

1. Implement complete transform logic
2. Wire into worker service resume flow
3. Add endless mode feature flag
4. Test with real sessions

### Medium Term (Next Month)

1. Beta release to power users
2. Gather feedback and iterate
3. Performance optimization
4. Documentation and user guides

### Long Term (Future)

1. Make endless mode default
2. Hybrid sliding window (keep recent tools uncompressed)
3. Selective compression by tool type
4. Auto-tune compression based on context usage patterns

---

## Open Questions

1. **Tool Use ID Format**: What does the Agent SDK's tool_use_id look like? Is it UUID, hash, or sequential?
2. **Transcript Format**: What's the exact JSONL schema for tool_use messages? Where is the content we'll replace?
3. **Resume Hook Point**: Where exactly in the worker service does session resume happen? Is there a clear integration point?
4. **Observation Delay**: How long between PostToolUse firing and observation being available in SQLite? Does this affect resume?
5. **Feature Flag Storage**: Environment variable, or persist user preference in database?

---

## Conclusion

Endless Mode transforms claude-mem from a "memory between sessions" system into a "continuous compression engine" that enables truly infinite sessions. By leveraging the observations we're already creating in real-time and applying them as an ephemeral transformation layer during resume, we can extend session longevity by 10-12x without any risk to user data.

The key architectural insight is **immutability**: by never modifying source transcripts and performing all compression in memory, we get the benefits of context window optimization without the risks of data corruption or loss. Combined with the optional nature of the feature, this provides a safe, reversible path to fundamentally better session continuity.

This is the natural evolution of claude-mem: from remembering what happened before, to making it possible to never stop.
