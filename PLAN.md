# Plan: Generic Message-Type Ingestion for claude-mem

## Goal

Extract the "any data → tool use → observation" pattern from the LoCoMo eval into a reusable ingestion system that understands **message types** (assistant, thinking, user, tool use) — not just fake "Read" calls. Create a conversation mode so the AI observer processes dialog/message content instead of discarding it.

## Phase 0: Documentation Discovery (DONE)

### Findings

**Worker API accepts any toolName** — `POST /api/sessions/observations` takes `{ tool_name, tool_input, tool_response, cwd }` with zero validation on `tool_name`. The `buildObservationPrompt()` in `src/sdk/prompts.ts:91-120` passes `tool_name` straight through as `<what_happened>`.

**Mode system is the control surface** — The mode's `recording_focus`, `skip_guidance`, and `type_guidance` prompts tell the AI what to extract. `code.json` says "focus on deliverables" (why conversations were discarded). `email-investigation.json` shows a completely different domain works fine.

**buildObservationPrompt is mode-agnostic** — It wraps ALL tool data in the same `<observed_from_primary_session>` XML regardless of mode. The mode only affects the init/continuation prompts that set the AI's instructions.

**No worker code changes needed** — The entire solution is: 1 new mode JSON + 1 generic adapter module.

### Allowed APIs (verified in source)

| API | File | Signature |
|-----|------|-----------|
| `POST /api/sessions/init` | `SessionRoutes.ts:~400` | `{ contentSessionId, project, prompt }` |
| `POST /api/sessions/observations` | `SessionRoutes.ts:498-587` | `{ contentSessionId, tool_name, tool_input, tool_response, cwd }` |
| `POST /api/sessions/complete` | `SessionRoutes.ts:~590` | `{ contentSessionId }` |
| `buildObservationPrompt(obs)` | `src/sdk/prompts.ts:91-120` | `{ tool_name, tool_input, tool_output, created_at_epoch, cwd? }` |
| `ModeManager.loadMode(id)` | `src/services/domain/ModeManager.ts` | Supports inheritance: `parent--override` |

### Anti-patterns to avoid

- **Do NOT modify worker-service routes** — the API is already generic enough
- **Do NOT modify buildObservationPrompt** — it already passes tool_name through
- **Do NOT create a new PendingMessage type** — use existing `'observation'` type with semantic tool_name values
- **Do NOT hardcode "Read" as toolName** — that was the eval's mistake

---

## Phase 1: Create the `conversation` mode

**What to implement:** A new mode JSON file `plugin/modes/conversation.json` that tells the AI observer how to process different message types from conversations.

**Copy from:** `plugin/modes/email-investigation.json` (it's the closest precedent for non-code content). Use the same structure, adjust `observation_types`, `observation_concepts`, and all `prompts` fields.

**Key design decisions:**

The `recording_focus` prompt must include per-toolName guidance:
```
When <what_happened> is "AssistantMessage" → extract decisions, plans, explanations, commitments
When <what_happened> is "ThinkingMessage" → extract reasoning chains, rejected alternatives, key insights
When <what_happened> is "UserMessage" → extract requirements, preferences, constraints, intent
When <what_happened> is "Read" / "Write" / "Bash" / etc. → extract what was done (standard tool behavior)
```

The `skip_guidance` must NOT skip conversations (the code.json mistake).

**Observation types** (conversation-appropriate):
- `insight` — Key understanding or realization
- `decision` — Choice made with rationale
- `preference` — User preference or constraint expressed
- `fact` — Factual information shared in conversation
- `plan` — Future intent or commitment
- `topic` — Subject or theme discussed

**Observation concepts** (conversation-appropriate):
- `who` — People mentioned or involved
- `what-happened` — Events, actions, outcomes
- `opinion` — Subjective views expressed
- `personal-detail` — Personal information shared
- `relationship` — Connections between people/things
- `timeline` — When things happened or will happen

**Files to create:**
- `plugin/modes/conversation.json`

**Verification:**
- [ ] JSON is valid and parseable
- [ ] All 52 prompt fields from code.json are present (check with diff)
- [ ] `ModeManager.loadMode('conversation')` succeeds (test in Bun REPL)
- [ ] Mode loads correctly via the worker when `CLAUDE_MEM_MODE=conversation`

**Anti-pattern guards:**
- Do NOT invent new prompt fields not in ModeConfig interface (`src/services/domain/types.ts`)
- Do NOT add any `skip_guidance` that would cause conversations to be skipped

---

## Phase 2: Extract generic ingestion adapter from eval code

**What to implement:** A reusable adapter module that transforms different message types into `queueObservation()` calls with semantic `toolName` values. Extract from `evals/locomo/src/ingestion/` into `src/services/ingestion/` (or a standalone utility).

**Copy from:**
- `evals/locomo/src/ingestion/worker-client.ts` → Copy the `WorkerClient` class as-is (it's 100% generic already)
- `evals/locomo/src/ingestion/adapter.ts` → Replace LoCoMo-specific `formatSessionAsToolExecution()` with per-message-type formatters

**New adapter interface:**

```typescript
interface MessageIngestionInput {
  messageType: 'assistant' | 'thinking' | 'user' | 'tool_use' | 'system';
  content: string;
  metadata?: {
    role?: string;
    turnNumber?: number;
    model?: string;
    toolName?: string;        // For tool_use messages
    toolInput?: unknown;      // For tool_use messages
    timestamp?: string;
    speakerName?: string;     // For conversation replay
  };
}

interface FormattedObservation {
  toolName: string;           // e.g., "AssistantMessage", "ThinkingMessage", "Read"
  toolInput: string;          // JSON metadata about the message
  toolResponse: string;       // The actual message content
  userPrompt: string;         // Context for session init
}

function formatMessageAsObservation(input: MessageIngestionInput): FormattedObservation;
```

**Mapping:**

| messageType | toolName | toolInput | toolResponse |
|-------------|----------|-----------|--------------|
| `assistant` | `AssistantMessage` | `{ role, turnNumber, model }` | message text |
| `thinking` | `ThinkingMessage` | `{ role, turnNumber }` | thinking text |
| `user` | `UserMessage` | `{ role, turnNumber }` | prompt text |
| `tool_use` | actual tool name | actual tool input | actual tool response |
| `system` | `SystemMessage` | `{ role }` | system text |

**Files to create:**
- `src/services/ingestion/message-adapter.ts` — the generic adapter
- `src/services/ingestion/worker-client.ts` — copy from eval (or import if same repo)

**Files to reference (do not modify):**
- `evals/locomo/src/ingestion/worker-client.ts` — copy source
- `evals/locomo/src/ingestion/adapter.ts` — pattern reference
- `src/sdk/prompts.ts:91-120` — verify toolName flows through to `<what_happened>`

**Verification:**
- [ ] `formatMessageAsObservation({ messageType: 'assistant', content: 'hello' })` returns `{ toolName: 'AssistantMessage', ... }`
- [ ] `formatMessageAsObservation({ messageType: 'tool_use', content: '...', metadata: { toolName: 'Read' } })` passes through actual tool name
- [ ] WorkerClient can connect to running worker and init/queue/complete a session
- [ ] Unit tests for all 5 message type mappings

**Anti-pattern guards:**
- Do NOT add LoCoMo-specific code to the generic adapter
- Do NOT hardcode "Read" as the toolName for non-tool messages
- Do NOT modify WorkerClient's API surface — it's already correct

---

## Phase 3: Integration test — ingest a conversation using the new mode + adapter

**What to implement:** A test script that:
1. Sets `CLAUDE_MEM_MODE=conversation`
2. Takes a sample conversation (can reuse one LoCoMo conversation)
3. Ingests each message through the adapter → WorkerClient → worker API
4. Verifies observations were created with appropriate types
5. Searches for content and confirms retrieval works

**Copy from:**
- `evals/locomo/scripts/ingest-one.ts` — orchestration pattern (health check → init → queue → wait → complete)

**Files to create:**
- `scripts/test-conversation-ingestion.ts` — integration test script

**Verification:**
- [ ] Worker processes all 5 message types without errors
- [ ] Observations created have meaningful titles/narratives (not "Code Development" noise)
- [ ] Search via worker API returns relevant results for conversation content
- [ ] Chroma vector search works (not just FTS)
- [ ] No observations are skipped/discarded (the original bug)

**Anti-pattern guards:**
- Do NOT skip the worker health check
- Do NOT use direct SQLite insertion (that's what we're replacing)
- Do NOT test with `CLAUDE_MEM_MODE=code` — the whole point is the new mode

---

## Phase 4: Clean up eval branch

**What to implement:** Remove the workaround code that this work makes unnecessary:
- `scripts/direct-ingest.ts` — no longer needed (worker path works now)
- Keyword search fallback in `src/qa/searcher.ts:44-127` — no longer needed (Chroma works now)

Update `ingest-all.ts` and `ingest-one.ts` to use the new generic adapter instead of the LoCoMo-specific adapter.

**Verification:**
- [ ] `bun evals/locomo/scripts/ingest-one.ts` works with the new adapter
- [ ] Existing tests still pass (119/119)
- [ ] `direct-ingest.ts` deleted
- [ ] Keyword fallback code removed from searcher.ts
- [ ] `grep -r "direct-ingest" .` returns no results

---

## Summary

| Phase | Creates | Modifies | Deletes |
|-------|---------|----------|---------|
| 1 | `plugin/modes/conversation.json` | — | — |
| 2 | `src/services/ingestion/message-adapter.ts`, `src/services/ingestion/worker-client.ts` | — | — |
| 3 | `scripts/test-conversation-ingestion.ts` | — | — |
| 4 | — | `evals/locomo/scripts/ingest-all.ts`, `evals/locomo/src/qa/searcher.ts` | `evals/locomo/scripts/direct-ingest.ts` |

**Zero worker code changes.** The solution is purely: 1 mode + 1 adapter + cleanup.
