# Implementation Plan: Memory Layer 3, TITANS Observer, and Progressive Search Fix

**Created:** 2026-04-05 | **Revised:** 2026-04-06 (post eng review)
**Branch:** thedotmack/mem-layer3-titans
**Scope:** 4 enhancements to claude-mem's memory system

---

## Architecture Overview

```
CURRENT PIPELINE:
PostToolUse hook → HTTP POST → pending_messages → SDK agent → observations → ChromaSync (cm__claude-mem)

NEW ADDITIONS:
TranscriptWatcher (already exists!) → NEW: store chunks → ChromaSync (cm__claude-mem-transcripts)
TranscriptWatcher → NEW: extract exchanges → separate agent call → conversation observations → ChromaSync (cm__claude-mem)
MCP tools → NEW: get_transcript_segment → traversal SQLite→Chroma
```

**Storage model:**
```
Main SQLite (existing):        observations, summaries, sessions, prompts → SEARCHED
Main Chroma (cm__claude-mem):  observation/summary/prompt embeddings → SEARCHED
Transcript Chroma (NEW, cm__claude-mem-transcripts): transcript chunks → SCOPED RAG only via traversal
```

**Key infrastructure reuse:**
- `TranscriptWatcher` + `FileTailer` — incremental JSONL tailing with offset tracking (already built)
- `TranscriptEventProcessor` — already handles `user_message` and `assistant_message` events
- `ChromaSync` — second instance with different project name creates separate collection
- `parseObservations()` — same XML output format for conversation observations

---

## Phase 1: MCP Instruction Fix for Progressive Search

**Goal:** Fix MCP instructions so agents load `Skill(mem-search)`.

**Files:** `src/servers/mcp-server.ts`, `plugin/skills/mem-search/SKILL.md`

### Tasks

#### 1.1: Update `__IMPORTANT` tool description

**File:** `src/servers/mcp-server.ts` (line 153)

Append to the `description` field:
```
For complete examples and advanced usage: load Skill(mem-search)
```

Update the handler return text to add:
```markdown
**IMPORTANT:** For complete documentation, examples, and advanced patterns,
invoke: `Skill(mem-search)`
```

#### 1.2: Update individual tool descriptions

**File:** `src/servers/mcp-server.ts` (lines 187-230)

Append `Full docs: Skill(mem-search)` to each of `search`, `timeline`, `get_observations` tool descriptions.

#### 1.3: Add Layer 3 placeholder to SKILL.md

**File:** `plugin/skills/mem-search/SKILL.md`

Add after "Why This Workflow?" section:
```markdown
## Deep Dive: Full Transcript Context (Layer 3)

When observations alone aren't enough, retrieve the original conversation:

**Full segment dump:**
```
get_transcript_segment(observation_id=11131)
```

**Scoped search within segment:**
```
get_transcript_segment(observation_id=11131, query="why did we choose JWT")
```

**Returns:**
- Without `query`: The full conversation segment (~2000-5000 tokens)
- With `query`: The most relevant chunks from within that segment (scoped RAG)

**This is a traversal tool, not a search tool.** You must already have an
observation ID from search/timeline.

**Token cost hierarchy:**
- Search index: ~50-100 tokens/result
- Full observation: ~500-1000 tokens
- Transcript segment: ~2000-5000 tokens (full) or ~500-1000 (scoped query)
```

### Verification
- [ ] Build succeeds: `npm run build-and-sync`
- [ ] grep for "Skill(mem-search)" in built MCP server output
- [ ] SKILL.md has Layer 3 section

---

## Phase 2: Prerequisites — Type System and Schema Fixes

**Goal:** Fix hardcoded type system and schema constraints that would break Phases 3-4.

**Files:** 5 files

### Tasks

#### 2.1: Add UNIQUE constraint to user_prompts (Migration 24)

**File:** `src/services/sqlite/SessionStore.ts`

Add migration 24:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prompts_unique_session_prompt
  ON user_prompts(content_session_id, prompt_number);
```

**Why:** Without this, retried `session_init` events create duplicate prompt rows, shifting every prompt_number boundary. The transcript segmenter depends on prompt_number for the observation→transcript join.

**Pattern to copy from:** Migration 22 (content_hash index addition), same `applyMigration(version, fn)` pattern.

#### 2.2: Make observation type system dynamic

**File:** `src/services/worker/search/filters/TypeFilter.ts` (line 8)

Change from hardcoded:
```typescript
type ObservationType = 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
export const OBSERVATION_TYPES: ObservationType[] = [...];
```

To dynamic, loaded from ModeManager:
```typescript
import { ModeManager } from '../../../services/domain/ModeManager.js';

export function getObservationTypes(): string[] {
  return ModeManager.getInstance().getObservationTypes().map(t => t.id);
}
```

**File:** `src/services/sqlite/types.ts` (line 204)

Change `type` field in `ObservationRow` from literal union to `string`:
```typescript
type: string;  // Validated by ModeManager, not TypeScript
```

**File:** `src/types/database.ts` (line 64)

Same change in `ObservationRecord`:
```typescript
type: string;  // Validated by ModeManager, not TypeScript
```

**Why:** ModeManager already loads types dynamically from `plugin/modes/code.json`. The 3 hardcoded locations create a split-brain where ModeManager accepts new types but TypeFilter/DB types reject them.

#### 2.3: Add 6 conversation observation types to code mode

**File:** `plugin/modes/code.json`

Add to `observation_types` array:
```json
{ "id": "insight", "label": "Insight", "description": "Surprise or delight at discovering something unexpected", "emoji": "💡", "work_emoji": "🧠" },
{ "id": "commitment", "label": "Commitment", "description": "Assistant or user commits to remembering or changing behavior", "emoji": "🤝", "work_emoji": "🧠" },
{ "id": "correction", "label": "Correction", "description": "User corrected assistant behavior, assistant acknowledged", "emoji": "📐", "work_emoji": "🧠" },
{ "id": "frustration", "label": "Frustration", "description": "User expressed frustration, marking a pain point", "emoji": "😤", "work_emoji": "🧠" },
{ "id": "pattern_recognition", "label": "Pattern Recognition", "description": "Connecting dots across context, recognizing similarities", "emoji": "🔗", "work_emoji": "🧠" },
{ "id": "emotional_signal", "label": "Emotional Signal", "description": "Joy, anger, fear, or strong sentiment in conversation", "emoji": "💬", "work_emoji": "🧠" },
{ "id": "overconfidence", "label": "Overconfidence", "description": "Unverified claim without evidence — hallucination risk signal", "emoji": "⚠️", "work_emoji": "🧠" }
```

### Verification
- [ ] Migration 24 applies: UNIQUE index on user_prompts
- [ ] TypeFilter uses ModeManager dynamically
- [ ] `ObservationRow.type` and `ObservationRecord.type` are `string`
- [ ] code.json has 12 observation types
- [ ] Existing search/timeline/get_observations work with new types
- [ ] Build succeeds

---

## Phase 3: Transcript Storage (Layer 3)

**Goal:** Store transcript segments in a separate Chroma collection. Access via traversal only.

**Files:** `src/services/sync/ChromaSync.ts`, `src/services/worker/DatabaseManager.ts`, `src/services/transcripts/processor.ts`, `src/services/worker/http/routes/SessionRoutes.ts` (or new DataRoutes), `src/servers/mcp-server.ts`, `src/utils/tag-stripping.ts`, `plugin/skills/mem-search/SKILL.md`

### Architecture

**Reuse existing infrastructure:**
- `TranscriptWatcher` / `FileTailer` — already does incremental JSONL tailing with offset tracking
- `TranscriptEventProcessor` — already handles `user_message` and `assistant_message` events, has session state
- `ChromaSync` — second instance creates separate collection

**New ChromaSync instance:**
```typescript
// In DatabaseManager.initialize():
this.transcriptChromaSync = new ChromaSync('claude-mem-transcripts');
// Creates collection: cm__claude-mem-transcripts
```

**Crash safety fix:** FileTailer currently saves offset BEFORE processing entries. For transcript chunks, we need to ensure Chroma write completes before advancing the offset. Approach: add a `transcript_offset` to the watch state that only advances after successful Chroma batch write, separate from the main tailer offset used for observation processing.

### Tasks

#### 3.1: Add second ChromaSync instance for transcripts

**File:** `src/services/worker/DatabaseManager.ts` (line 36)

After existing ChromaSync creation:
```typescript
if (chromaEnabled) {
  this.chromaSync = new ChromaSync('claude-mem');
  this.transcriptChromaSync = new ChromaSync('claude-mem-transcripts');
}
```

Add getter:
```typescript
getTranscriptChromaSync(): ChromaSync | null {
  return this.transcriptChromaSync;
}
```

#### 3.2: Extend TranscriptEventProcessor to store transcript chunks

**File:** `src/services/transcripts/processor.ts`

Add a new method to handle transcript chunk storage. When `user_message` or `assistant_message` events fire, accumulate text in the session state. On prompt boundary (next `session_init` or `session_end`), flush accumulated text to Chroma as chunks.

```typescript
// New method
async flushTranscriptSegment(session: SessionState): Promise<void> {
  const text = this.buildSegmentText(session);
  if (!text) return;

  // Strip privacy tags before Chroma storage
  const sanitized = stripTranscriptPrivacyTags(text);

  // Chunk into ~2000 char pieces
  const chunks = chunkText(sanitized, 2000);

  // Write to transcript Chroma collection
  const chromaSync = this.getTranscriptChromaSync();
  if (chromaSync) {
    await chromaSync.addTranscriptChunks(
      session.sessionId,
      session.promptNumber,
      chunks,
      session.project
    );
  }
}
```

**Pattern to copy from:** `ChromaSync.syncObservation()` (lines 118-200) for the document format and batch add pattern.

**Privacy stripping:** Create `stripTranscriptPrivacyTags(text: string)` in `src/utils/tag-stripping.ts`. Reuse existing `<private>` and `<memory>` tag regex patterns from the same file.

#### 3.3: Add transcript chunk methods to ChromaSync

**File:** `src/services/sync/ChromaSync.ts`

Add method:
```typescript
async addTranscriptChunks(
  contentSessionId: string,
  promptNumber: number,
  chunks: string[],
  project: string
): Promise<void> {
  await this.ensureCollectionExists();
  const documents: ChromaDocument[] = chunks.map((chunk, i) => ({
    id: `transcript_${contentSessionId}_p${promptNumber}_c${i}`,
    document: chunk,
    metadata: {
      content_session_id: contentSessionId,
      prompt_number: promptNumber,
      chunk_index: i,
      doc_type: 'transcript_segment',
      project: project,
      created_at_epoch: Date.now()
    }
  }));
  await this.batchAddDocuments(documents);
}
```

Also add retrieval methods:
```typescript
// Full dump: all chunks for a segment
async getTranscriptSegment(contentSessionId: string, promptNumber: number): Promise<string[]>

// Scoped RAG: vector search within a segment
async queryTranscriptSegment(contentSessionId: string, promptNumber: number, query: string, nResults?: number): Promise<string[]>
```

**Pattern to copy from:** `ChromaSync.batchAddDocuments()` (existing) for batch writes, and the MCP `chroma_query_documents` / `chroma_get_documents` tool calls in `ChromaMcpManager`.

#### 3.4: Add transcript retrieval endpoint

**File:** `src/services/worker/http/routes/SessionRoutes.ts` (or new route file)

New endpoint: `POST /api/transcript/segment`

```typescript
async handleTranscriptSegment(req, res) {
  const { observation_id, query } = req.body;

  // 1. Look up observation in main SQLite
  const obs = store.getObservationById(observation_id);
  if (!obs) return res.status(404).json({ error: 'Observation not found' });

  // 2. Get content_session_id from sdk_sessions via memory_session_id
  const session = store.getSessionByMemoryId(obs.memory_session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // 3. Query transcript Chroma collection
  const transcriptSync = dbManager.getTranscriptChromaSync();
  if (!transcriptSync) return res.status(503).json({ error: 'Transcript storage unavailable' });

  let chunks: string[];
  let mode: 'full' | 'scoped';

  if (query) {
    chunks = await transcriptSync.queryTranscriptSegment(
      session.content_session_id, obs.prompt_number, query
    );
    mode = 'scoped';
  } else {
    chunks = await transcriptSync.getTranscriptSegment(
      session.content_session_id, obs.prompt_number
    );
    mode = 'full';
  }

  res.json({ chunks, prompt_number: obs.prompt_number, mode });
}
```

#### 3.5: Add `get_transcript_segment` MCP tool

**File:** `src/servers/mcp-server.ts`

```typescript
{
  name: 'get_transcript_segment',
  description: 'Layer 3: Get the original conversation that produced an observation. Params: observation_id (required), query (optional, scoped vector search within segment).',
  inputSchema: {
    type: 'object',
    properties: {
      observation_id: { type: 'number' },
      query: { type: 'string' }
    },
    required: ['observation_id']
  },
  handler: async (args) => callWorkerAPI('/api/transcript/segment', args)
}
```

**Note:** Do NOT add to `__IMPORTANT` 3-layer description. Layer 3 is optional deep-dive.

#### 3.6: Update SKILL.md Layer 3 section

**File:** `plugin/skills/mem-search/SKILL.md`

Replace Phase 1 placeholder with full documentation (already written in Phase 1 task 1.3, just verify it's complete).

### Tests

- [ ] `TranscriptEventProcessor.flushTranscriptSegment()` — stores chunks to Chroma with correct metadata
- [ ] Privacy tags stripped from transcript text before Chroma write
- [ ] Chunking: 10k char text → 5 chunks of ~2000 chars each
- [ ] `ChromaSync('claude-mem-transcripts')` creates `cm__claude-mem-transcripts` collection
- [ ] `POST /api/transcript/segment` with observation_id → returns full segment
- [ ] `POST /api/transcript/segment` with observation_id + query → returns scoped RAG results
- [ ] Observation with no stored transcript → 404, not crash
- [ ] Transcript data does NOT appear in `search()` results (separate collection)
- [ ] Main Chroma collection unaffected
- [ ] Build succeeds

### Verification
- [ ] All tests pass
- [ ] End-to-end: create observation → store transcript → retrieve via MCP tool
- [ ] `npm run build-and-sync`

---

## Phase 4: TITANS Conversation Observer

**Goal:** Observe conversation signals (surprise, commitment, correction, frustration) using a separate agent call.

**Files:** `src/sdk/prompts.ts`, `src/services/transcripts/processor.ts`, `src/services/worker/http/routes/SessionRoutes.ts`, `src/services/worker/SessionManager.ts`

### Architecture

**Conversation observation flow:**
```
TranscriptEventProcessor detects prompt boundary
  → extracts user/assistant exchanges for current segment
  → POST /api/sessions/conversation-observe (fire-and-forget)
  → worker creates separate agent call (NOT same session as tool observer)
  → agent returns <observation> XML with conversation types
  → parseObservations() + storeObservations() (same pipeline)
  → ChromaSync to main collection (cm__claude-mem)
```

**Separate agent call:** The conversation observer uses a one-shot agent invocation, not the session's ongoing generator. This means:
- Fresh context, clean prompt, no format confusion
- No changes to pending_messages or SessionManager's one-generator-per-session model
- The worker endpoint creates a temporary agent, sends one prompt, processes the response, done

**Pattern to copy from:** The existing `buildSummaryPrompt()` / `processAgentResponse()` pattern. Summary generation already does a one-shot agent call at session end.

### Tasks

#### 4.1: Build conversation observation prompt

**File:** `src/sdk/prompts.ts`

```typescript
export function buildConversationObservationPrompt(
  exchanges: ConversationExchange[],
  mode: ModeConfig
): string {
  const exchangeXml = exchanges.map((ex, i) => `
  <exchange index="${i + 1}" prompt_number="${ex.promptNumber}">
    <user>${ex.userText}</user>
    <assistant>${ex.assistantText}</assistant>
  </exchange>`).join('');

  return `You are a conversational memory observer. Analyze these exchanges for moments worth remembering.

<conversation_from_primary_session>
${exchangeXml}
</conversation_from_primary_session>

Identify conversational memory signals:
- INSIGHT (type: insight): Surprise, delight, unexpected discovery
- COMMITMENT (type: commitment): "I'll remember this", "Got it", "Won't do that again"
- CORRECTION (type: correction): User corrected behavior, assistant acknowledged
- FRUSTRATION (type: frustration): User pain, dissatisfaction, repeated requests
- PATTERN (type: pattern_recognition): "This is similar to...", connecting dots
- EMOTIONAL (type: emotional_signal): Strong sentiment in conversation flow
- OVERCONFIDENCE (type: overconfidence): Assistant made confident claims without evidence

OVERCONFIDENCE DETECTION (critical):
Flag when the assistant makes declarative claims about system behavior, causation,
or implementation details WITHOUT citing evidence (no file paths, no code read, no
grep results preceding the claim). Key signals:
- "This is because..." / "The issue is..." / "The solution is..." (stated as fact, not hypothesis)
- Absence of hedging ("apparently", "it seems", "I believe") on claims that warrant it
- Presenting one explanation as the only possibility
- Diagnosing without investigation (no tool use before the claim)
- Stating how external systems behave without verification

TWO FLAVORS, SAME PRIORITY:
- overconfidence: Confident claim + no evidence + no hedging. The agent stated
  something as fact without investigation.
- unverified_inference: Hedged claim + no evidence. The agent was honest about
  its uncertainty ("apparently", "it seems") but the claim is still unverified.

Both get recorded. Both get validated. SAME PRIORITY. Ground truth is zero-sum —
a wrong claim is wrong whether the agent hedged or not. The hedging tells you
about the agent's self-awareness, not about the claim's validity.

For each observation, capture:
- The specific claim in <facts>
- What evidence was missing in <narrative>
- Flavor (overconfidence or unverified_inference) in <subtitle>
- The exchange index where it occurred

Return <observation> blocks for significant moments only. Skip routine exchanges.
Focus on moments that should change future behavior.

${mode.prompts.output_format_header}
\`\`\`xml
<observation>
  <type>[ insight | commitment | correction | frustration | pattern_recognition | emotional_signal ]</type>
  <title>Brief description</title>
  <subtitle>Context</subtitle>
  <facts><fact>Specific detail</fact></facts>
  <narrative>What happened and why it matters</narrative>
  <concepts><concept>Related concept</concept></concepts>
</observation>
\`\`\`

Non-XML text is discarded. Return empty response if no significant signals found.`;
}

export interface ConversationExchange {
  promptNumber: number;
  userText: string;
  assistantText: string;
}
```

#### 4.2: Extend TranscriptEventProcessor to extract exchanges

**File:** `src/services/transcripts/processor.ts`

The processor already stores `session.lastUserMessage` and `session.lastAssistantMessage`. Extend to accumulate exchanges per session:

```typescript
// Add to SessionState interface:
exchanges: ConversationExchange[];

// In handleEvent for 'user_message':
session.exchanges.push({
  promptNumber: session.promptNumber,
  userText: fields.text as string,
  assistantText: ''  // filled when assistant responds
});

// In handleEvent for 'assistant_message':
const lastExchange = session.exchanges[session.exchanges.length - 1];
if (lastExchange) {
  lastExchange.assistantText = fields.text as string;
}
```

On prompt boundary or `session_end`, call `flushConversationObservation()` to send exchanges to the worker.

#### 4.3: Add conversation observation endpoint

**File:** `src/services/worker/http/routes/SessionRoutes.ts`

New endpoint: `POST /api/sessions/conversation-observe`

```typescript
async handleConversationObserve(req, res) {
  const { contentSessionId, exchanges, project } = req.body;

  // Fire-and-forget: respond immediately, process async
  res.json({ status: 'accepted', exchangeCount: exchanges.length });

  // Create one-shot agent call in background
  try {
    const mode = ModeManager.getInstance().getActiveMode();
    const prompt = buildConversationObservationPrompt(exchanges, mode);

    // Use SDK agent for one-shot call (not session generator)
    const response = await this.createOneShotAgentCall(prompt);

    // Parse and store using existing pipeline
    const observations = parseObservations(response);
    if (observations.length > 0) {
      const session = store.getSessionByContentId(contentSessionId);
      if (session?.memory_session_id) {
        store.storeObservations(
          session.memory_session_id, project, observations,
          null, exchanges[0]?.promptNumber ?? 1, 0
        );
      }
    }
  } catch (err) {
    logger.warn('WORKER', 'Conversation observation failed', { contentSessionId }, err);
    // Fire-and-forget: failure is logged, not propagated
  }
}
```

**Pattern to copy from:** The summary processing in `ResponseProcessor.processAgentResponse()` for how observations are parsed and stored.

#### 4.4: Implement one-shot agent call

**File:** `src/services/worker/agents/` (new utility or extend existing)

A lightweight function that:
1. Creates a Claude API call with the conversation prompt
2. Returns the text response
3. No session state, no pending_messages, no generator lifecycle

```typescript
async function createOneShotAgentCall(prompt: string): Promise<string> {
  // Use the same provider selection as the main generator
  // but without session management overhead
  const agent = getActiveAgent();
  return await agent.sendOneShot(prompt);
}
```

**This avoids touching SessionManager's one-generator-per-session model.**

### Consumer Updates

#### 4.5: Update context injection for new types

**File:** `src/services/context/` — update formatters to handle new observation type emojis (💡🤝📐😤🔗💬).

#### 4.6: Update SKILL.md obs_type documentation

**File:** `plugin/skills/mem-search/SKILL.md`

Update the `obs_type` parameter description to include:
```
insight, commitment, correction, frustration, pattern_recognition, emotional_signal
```

### Tests

- [ ] `buildConversationObservationPrompt()` generates valid XML prompt with exchanges
- [ ] Exchange extraction from transcript correctly pairs user/assistant messages
- [ ] One-shot agent call returns valid XML (mock test)
- [ ] `parseObservations()` correctly handles new types (insight, commitment, etc.)
- [ ] `POST /api/sessions/conversation-observe` responds immediately (fire-and-forget)
- [ ] Conversation observations stored in main observations table
- [ ] Conversation observations searchable via `search()` MCP tool
- [ ] New observation types appear in timeline
- [ ] Context injection formats new type emojis correctly
- [ ] Session with no emotional signals → empty response, no error
- [ ] Build succeeds

### Verification
- [ ] All tests pass
- [ ] End-to-end: session with emotional signals → conversation observations stored
- [ ] `search(obs_type="insight")` returns conversation observations
- [ ] `npm run build-and-sync`

---

## Phase 5: Real-Time Overconfidence Challenge (Follow-up)

**Goal:** Wire overconfidence detection into real-time challenge injection during active sessions.

**Prerequisite:** Phase 4 shipping and proving the overconfidence heuristic works with real data. Review stored overconfidence observations to validate detection quality before enabling real-time intervention.

### Architecture

```
TranscriptWatcher detects overconfident assistant message (heuristic)
  → flags it in session state
  → on next PostToolUse hook response:
     injects challenge via additionalContext / systemMessage:
     "Previous response claimed [X] without evidence. Verify before proceeding."
```

**Two-tier detection:**
1. **Lightweight heuristic (no LLM):** Pattern match on assistant text for overconfidence signals. Fast, runs on every message. High recall, moderate precision.
2. **LLM validation (on-demand):** For flagged messages, run a focused validation subagent that checks the specific claims against codebase evidence. High precision, used selectively.

### Tasks

#### 5.1: Build overconfidence heuristic detector

**File:** `src/services/transcripts/` (new module or extend processor)

```typescript
export interface OverconfidenceSignal {
  claim: string;           // The specific confident statement
  evidenceMissing: string; // What evidence should have preceded it
  flavor: 'overconfidence' | 'unverified_inference';
  exchangeIndex: number;
}

export function detectUnverifiedClaims(
  assistantText: string,
  precedingToolUses: string[]  // tool names used before this statement
): OverconfidenceSignal[]
```

**Heuristic rules (SAME PRIORITY for both flavors):**
- Declarative causal claims ("This is because", "The issue is") with no preceding Read/Grep/Bash → flavor: overconfidence
- Same claims WITH hedging ("apparently", "it seems") but still no evidence → flavor: unverified_inference
- Stating system behavior without file path citation, no hedging → overconfidence
- Stating system behavior without citation, with hedging → unverified_inference
- Presenting single solution without alternatives → overconfidence

Hedging changes the LABEL, not the PRIORITY. Both flavors are validated equally.

#### 5.2: Inject challenge via hook context

**File:** `src/cli/handlers/observation.ts` or `context.ts`

When the session state has an unresolved overconfidence flag:
- Include in the PostToolUse hook response's `additionalContext`
- Message: "⚠️ Previous response made confident claims about [X] without citing evidence. Verify [specific claim] before proceeding."
- Clear the flag after injection (one-shot, don't repeat)

#### 5.3: Validation subagent for overconfidence review

A on-demand utility that:
1. Queries stored overconfidence observations for a project/session
2. For each claim, searches the codebase for supporting/refuting evidence
3. Produces a confidence audit: { claim, evidence_found, verdict: 'verified' | 'unverified' | 'contradicted' }

This could be an MCP tool (`validate_confidence`) or a skill.

### Tests
- [ ] Heuristic detects "This is because X" with no preceding Read tool → HIGH signal
- [ ] Heuristic does NOT flag "It seems like X might be..." → no signal
- [ ] Challenge injection appears in hook response after overconfidence flag
- [ ] Challenge clears after one injection (no repeats)
- [ ] Validation subagent correctly identifies verified vs unverified claims

### Verification
- [ ] Run against historical sessions to measure precision/recall
- [ ] False positive rate < 20% (tune heuristic thresholds)
- [ ] Build succeeds

---

## Phase 6: Integration & Verification

**Goal:** End-to-end verification, documentation, version bump.

### Tasks

#### 5.1: End-to-end test flow
1. Start a session with tool uses AND emotional signals
2. Verify: tool observations stored (existing)
3. Verify: transcript segments stored in `cm__claude-mem-transcripts`
4. Verify: conversation observations stored with new types
5. Verify: `search()` → `get_observations()` → `get_transcript_segment()` chain works
6. Verify: scoped RAG within segment works

#### 5.2: Update progressive-disclosure.mdx
**File:** `docs/public/progressive-disclosure.mdx`

Update Three-Layer Model:
```
Layer 1 (Index): search() → ~50-100 tokens/result
Layer 2 (Details): get_observations() → ~500-1000 tokens
Layer 3 (Transcript): get_transcript_segment() → ~2000-5000 tokens
```

#### 5.3: Update CLAUDE.md
**File:** `CLAUDE.md`

Add to Architecture section:
- Transcript segments in separate Chroma collection (traversal-only)
- Conversation observation modality (TITANS-inspired, 6 types)
- 3-layer progressive search

#### 5.4: Version bump
Bump to 11.1.0 (additive features, not breaking).

### Verification
- [ ] Full session lifecycle works end-to-end
- [ ] Progressive search 3-layer chain works
- [ ] Conversation observations appear in timeline alongside tool observations
- [ ] Documentation matches implementation
- [ ] Build succeeds: `npm run build-and-sync`

---

## Phase Dependency Graph

```
Phase 1 (MCP Fix) ──────────────────────────────────────→ Phase 6 (Integration)
                                                              ↑
Phase 2 (Type System Fix) ──→ Phase 3 (Transcripts) ────────→│
                          └──→ Phase 4 (TITANS + Overconf) ──→│
                                    └──→ Phase 5 (Real-time Challenge, follow-up)
```

**Phase 1** — independent, ship alone
**Phase 2** — independent, prerequisite for 3 and 4
**Phase 3** — depends on Phase 2 (dynamic types)
**Phase 4** — depends on Phase 2 (new observation types including overconfidence) and Phase 3 (exchange extraction)
**Phase 5** — depends on Phase 4 (overconfidence detection proven with real data)
**Phase 6** — depends on Phases 1-4 (Phase 5 can ship separately later)

**Parallel lanes:**
- Lane A: Phase 1 (2 files, independent)
- Lane B: Phase 2 → Phase 3 → Phase 4 → Phase 6 (sequential, shared modules)
- Lane C: Phase 5 (after Phase 4 ships and heuristic is validated)

**Recommended:** Ship Phase 1 immediately. Then Phase 2 → 3 → 4 → 6 sequentially. Phase 5 ships when overconfidence detection is proven.

---

## Appendix A: Historical Analysis of mem-search Skill

(See original plan — unchanged)

| Date | Event | Size |
|------|-------|------|
| 2025-11-10 | Created with progressive disclosure | 202 lines |
| 2025-11-18 | Major rewrite: ID-based fetch | 123 lines |
| 2025-12-14 | Migrated from curl to MCP tools | ~210 lines |
| 2025-12-28 | Deleted entirely | 0 lines |
| 2026-02-07 | Recreated as clean single-file | 141 lines |
| 2026-02-23 | Removed save_memory section | 127 lines |

---

## Appendix B: Engineering Review Decisions

1. **Reuse TranscriptWatcher/FileTailer** — do not build new segmenter
2. **Incremental capture** — extend existing watcher, not batch at Stop
3. **Separate Chroma collection** — `cm__claude-mem-transcripts` via second ChromaSync instance
4. **user_prompts UNIQUE constraint** — migration 24, prerequisite
5. **Privacy tags** — dedicated `stripTranscriptPrivacyTags()` in tag-stripping.ts
6. **Separate agent call** — one-shot, not pending_messages queue
7. **Merged extractor** — extend TranscriptEventProcessor, not new file
8. **All 7 conversation observation types** — insight, commitment, correction, frustration, pattern_recognition, emotional_signal, overconfidence
9. **POST for new MCP tool** — consistent pattern
10. **Consumer updates** — context injection, viewer, formatters, SKILL.md
11. **Dynamic type system** — TypeFilter, sqlite/types.ts, database.ts → use ModeManager
12. **Crash safety** — separate transcript_offset tracking, advance only after Chroma write

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | REVISED | 7 issues, 2 critical gaps, all resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE VOICE:** Claude subagent + Codex ran. Key finding: TranscriptWatcher already exists (adopted). 3 cross-model tensions resolved.
- **UNRESOLVED:** 0 (all decisions incorporated into revised plan)
- **VERDICT:** ENG REVIEW COMPLETE — plan revised and ready for implementation
