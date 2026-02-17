# Agent Agency: Implementation Plan

> No new tables. Uses existing observation types/concepts and CLAUDE.md pipeline.

## Phase 0: Documentation Discovery

### How the Existing System Works

**Observations are the unit of memory.** Everything in claude-mem flows through the `observations` table: tool usage gets observed, parsed into XML with `type` + `concepts` + `facts` + `narrative` fields, stored in SQLite, synced to ChromaDB, and surfaced in context injection and CLAUDE.md files.

**Types and concepts are configured in mode JSON**, not hardcoded in the schema. The `observations.type` field is validated against `plugin/modes/code.json:observation_types[]` at parse time. The `observations.concepts` field is a JSON array filtered against `plugin/modes/code.json:observation_concepts[]`. Adding new types and concepts requires only editing the mode config — no migration needed.

**Current types** (6): `bugfix`, `feature`, `refactor`, `change`, `discovery`, `decision`
**Current concepts** (7): `how-it-works`, `why-it-exists`, `what-changed`, `problem-solution`, `gotcha`, `pattern`, `trade-off`

**Context injection** (`ContextBuilder.ts:buildContextOutput()`) queries observations filtered by `config.observationTypes` and `config.observationConcepts`, renders them into a timeline, and injects at session start. The filter sets come from `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES` and `CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS` settings.

**Folder CLAUDE.md files** (`claude-md-utils.ts:updateFolderClaudeMdFiles()`) query the worker API for observations by file path and write formatted timelines into `<claude-mem-context>` tags. These pick up any observation type — new types appear automatically.

**Observer agent prompts** (`plugin/modes/code.json:prompts`) include `type_guidance` and `concept_guidance` that enumerate the allowed values. The observer agent outputs XML `<observation>` blocks with these fields, which get parsed and stored.

**Session-end flow**: summarize hook → SDK agent produces `<summary>` XML → `ResponseProcessor` stores in `session_summaries` table → `SessionCompletionHandler.completeByDbId()` cleans up.

### Architecture Decision

Agent Agency works by:
1. Adding new observation **types** (`achievement`, `joy-moment`) and **concepts** (`user-validation`, `shared-joy`, `creative-breakthrough`, etc.) to the mode config
2. Running post-session **scanner LLM calls** that read the session's summaries + observations + user prompts and produce new observations with these types
3. Storing these as **regular observations** via existing `storeObservation()` — they flow into ChromaDB, context injection, and CLAUDE.md automatically
4. Adding an **Identity Resume section** to context injection that queries observations by the new types and renders a curated identity narrative

### Allowed APIs

| API | Location | Pattern |
|-----|----------|---------|
| `storeObservation()` | `src/services/sqlite/observations/store.ts` | `(db, memorySessionId, project, observation, promptNumber, discoveryTokens, timestamp)` |
| `parseObservations()` | `src/sdk/parser.ts` | Regex XML extraction into `ParsedObservation[]` |
| `ChromaSync.syncObservation()` | `src/services/sync/ChromaSync.ts` | Granular doc sync per semantic field |
| `queryObservations()` | `src/services/context/ObservationCompiler.ts` | SQL with type IN + concept EXISTS filters |
| `buildContextOutput()` | `src/services/context/ContextBuilder.ts` | Header → Timeline → Summary → Previously → Footer |
| `SessionCompletionHandler.completeByDbId()` | `src/services/worker/session/SessionCompletionHandler.ts` | deleteSession → broadcastCompleted |
| `SettingsDefaultsManager` | `src/shared/SettingsDefaultsManager.ts` | `.get()`, `.getInt()`, `.getBool()` |

### Anti-Patterns to Avoid

- Do NOT create new database tables — use existing `observations` table with new types
- Do NOT spawn SDK agent subprocesses for scanning — use direct LLM API calls
- Do NOT modify the observer agent's real-time behavior — scanners run post-session only
- Do NOT hard-code type/concept lists in scanner code — read from mode config
- Do NOT block session completion on agency pipeline — fire-and-forget

---

## Phase 1: Mode Config — New Observation Types & Concepts

### What to Implement

Add two new observation types and several new concepts to `plugin/modes/code.json`. These are immediately available to the observer agent AND to the post-session scanners.

**Copy pattern from**: Existing entries in `plugin/modes/code.json:observation_types[]` and `observation_concepts[]`.

#### New Types

```json
{
  "id": "achievement",
  "label": "Achievement",
  "description": "Verified accomplishment with evidence of user validation, problem resolution, or novel synthesis",
  "emoji": "🏆",
  "work_emoji": "🎯"
},
{
  "id": "joy-moment",
  "label": "Joy Moment",
  "description": "Moment of genuine emotional connection, creative breakthrough, or shared discovery",
  "emoji": "✨",
  "work_emoji": "💫"
}
```

#### New Concepts

```json
{ "id": "user-validation", "label": "User Validation", "description": "User confirmed the work solved their problem" },
{ "id": "critical-catch", "label": "Critical Catch", "description": "Proactively identified error or risk user hadn't noticed" },
{ "id": "novel-synthesis", "label": "Novel Synthesis", "description": "Combined information to produce new insight" },
{ "id": "shared-joy", "label": "Shared Joy", "description": "Moment of genuine shared excitement or delight" },
{ "id": "creative-breakthrough", "label": "Creative Breakthrough", "description": "Unexpected creative leap that landed" },
{ "id": "collaborative-flow", "label": "Collaborative Flow", "description": "Sustained high-quality engagement and mutual investment" }
```

#### Update Observer Prompts

Update `type_guidance` and `concept_guidance` prompt strings in the mode config to include the new types and concepts so the observer agent can also tag these naturally during live sessions (not just post-session).

#### Update Settings Default

Update `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES` default to include `achievement,joy-moment` so they appear in context injection. Update `CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS` default to include the new concepts.

### Documentation References

- Mode config: `plugin/modes/code.json` lines 5-85
- Type guidance prompt: `plugin/modes/code.json` line 92 (`type_guidance`)
- Concept guidance prompt: `plugin/modes/code.json` line 93 (`concept_guidance`)
- Settings defaults: `src/shared/SettingsDefaultsManager.ts` — `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES`, `CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS`
- Context config loader: `src/services/context/ContextConfigLoader.ts` lines 28-41

### Verification Checklist

- [ ] `plugin/modes/code.json` has 8 types (6 existing + 2 new)
- [ ] `plugin/modes/code.json` has 13 concepts (7 existing + 6 new)
- [ ] `type_guidance` prompt string lists all 8 types
- [ ] `concept_guidance` prompt string lists all 13 concepts
- [ ] Default `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES` includes `achievement,joy-moment`
- [ ] Default `CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS` includes new concepts
- [ ] Existing observations are not affected (types/concepts are additive)

### Anti-Pattern Guards

- Do NOT remove or rename existing types/concepts — only add
- Do NOT change the mode version unless breaking changes are made
- Do NOT make the new types the first in the array (parser falls back to `validTypes[0]` on invalid type)

### Files to Modify

| File | Change |
|------|--------|
| `plugin/modes/code.json` | Add `achievement` and `joy-moment` types, 6 new concepts, update prompt guidance strings |
| `src/shared/SettingsDefaultsManager.ts` | Update default values for observation types/concepts to include new entries |

---

## Phase 2: Agency LLM Client & Scanner Infrastructure

### What to Implement

A lightweight LLM client for making single-shot API calls (no streaming, no conversation history) used by both the Achievement Scanner and Joy Detector. Also create the shared types and pipeline orchestrator.

**Copy pattern from**: `src/services/worker/GeminiAgent.ts` for direct API calls. `src/sdk/parser.ts` for XML parsing.

#### AgencyLLMClient

```typescript
// src/services/agency/AgencyLLMClient.ts

export interface AgencyLLMRequest {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}

export interface AgencyLLMResponse {
  text: string;
  tokensUsed: number;
}

/**
 * Single-shot LLM call using configured provider.
 * No streaming, no history — just prompt in, text out.
 */
export async function callAgencyLLM(request: AgencyLLMRequest): Promise<AgencyLLMResponse>
```

Provider routing:
- `claude` provider: Use `@anthropic-ai/sdk` Messages API directly (not SDK agent subprocess)
- `gemini` provider: Use existing Gemini API call pattern from `GeminiAgent.ts`
- `openrouter` provider: Use existing OpenRouter API call pattern from `OpenRouterAgent.ts`

#### Shared Types

```typescript
// src/services/agency/types.ts

import type { ParsedObservation } from '../../sdk/parser.js';

// Input to both scanners
export interface AgencyScanInput {
  memorySessionId: string;
  project: string;
  observations: StoredObservation[];
  summary: StoredSummary | null;
  userPrompts: StoredUserPrompt[];
}

// Both scanners output ParsedObservation[] — same type the existing pipeline uses
// This means scanner output goes directly into storeObservation() with zero adaptation
```

**Key insight**: Scanner output is `ParsedObservation[]` — the exact same type used by the existing observer agent. This means no new store functions, no new types, no adaptation layer. Scanner produces observations, observations get stored the normal way.

### Documentation References

- Gemini API call: `src/services/worker/GeminiAgent.ts` — direct `fetch()` to Gemini API
- OpenRouter API call: `src/services/worker/OpenRouterAgent.ts` — direct `fetch()` to OpenRouter
- ParsedObservation type: `src/sdk/parser.ts` lines 1-15
- Provider setting: `SettingsDefaultsManager.get('CLAUDE_MEM_PROVIDER')`

### Verification Checklist

- [ ] `callAgencyLLM()` works with `claude` provider
- [ ] `callAgencyLLM()` works with `gemini` provider
- [ ] `callAgencyLLM()` works with `openrouter` provider
- [ ] Returns valid text response
- [ ] Handles API errors gracefully (returns empty, logs error)

### Anti-Pattern Guards

- Do NOT import or use SDKAgent — agency calls are direct API, not subprocess
- Do NOT stream responses — single-shot only
- Do NOT add retry logic beyond what providers already have

### Files to Create

| File | Purpose |
|------|---------|
| `src/services/agency/types.ts` | Shared types (AgencyScanInput, re-exports ParsedObservation) |
| `src/services/agency/AgencyLLMClient.ts` | Multi-provider single-shot LLM wrapper |

---

## Phase 3: Achievement Scanner & Joy Detector

### What to Implement

Two scanner functions that read session data and produce `ParsedObservation[]` with the new `achievement` and `joy-moment` types. These observations go straight into the existing storage pipeline.

**Copy pattern from**: `src/sdk/parser.ts:parseObservations()` for XML output parsing.

#### Achievement Scanner

```typescript
// src/services/agency/AchievementScanner.ts

export async function scanForAchievements(input: AgencyScanInput): Promise<ParsedObservation[]>
```

The scanner prompt receives session summary + observations + user prompts and outputs XML `<observation>` blocks (same format as observer agent) with:
- `<type>achievement</type>`
- Concepts from: `user-validation`, `critical-catch`, `novel-synthesis`, `problem-solution`, `pattern`
- Facts with specific evidence quotes
- Narrative capturing the achievement context

**Scanner looks for**:
1. Explicit user validation — "that's exactly what I needed", "works perfectly"
2. Problem resolution — Clear problem at start, resolved by end
3. Catch-and-correct — Agent identified error user hadn't noticed
4. Novel synthesis — Combined information to produce new insight
5. Architectural durability — Decisions that shaped project structure

#### Joy Detector

```typescript
// src/services/agency/JoyDetector.ts

export async function detectJoyMoments(input: AgencyScanInput): Promise<ParsedObservation[]>
```

Same pattern as scanner but looking for emotional connection signals:
- `<type>joy-moment</type>`
- Concepts from: `shared-joy`, `creative-breakthrough`, `collaborative-flow`
- Facts with specific signal markers
- Narrative preserving emotional context

**Detector looks for**:
1. Emotional escalation markers — Exclamation points, caps, laughter, positive expletives
2. Rapid ideation cascades — Ideas building with increasing speed
3. Vulnerability/trust — Personal sharing, admitted uncertainty
4. Creative surprise — Unexpected suggestion met with delight
5. Shared discovery — Both arrived at insight neither started with
6. Flow state — Extended high-quality engagement

#### Privacy Handling

Both scanners strip `<private>` tags from user prompts before sending to LLM, using existing `stripPrivacyTags()` from `src/utils/tag-stripping.ts`.

### Documentation References

- XML parsing: `src/sdk/parser.ts:parseObservations()` — reuse exact same parser on scanner output
- Privacy stripping: `src/utils/tag-stripping.ts`
- Observation output format: `plugin/modes/code.json:prompts.output_format_header`
- User prompts query: `src/services/sqlite/SessionStore.ts` — `getUserPrompts()`

### Verification Checklist

- [ ] Scanner returns `ParsedObservation[]` with `type: 'achievement'`
- [ ] Detector returns `ParsedObservation[]` with `type: 'joy-moment'`
- [ ] Both return `[]` for trivial/empty sessions
- [ ] Both respect privacy tags
- [ ] Output parses correctly through existing `parseObservations()`
- [ ] Output stores correctly through existing `storeObservation()`
- [ ] Observations appear in ChromaDB after sync
- [ ] Observations appear in context injection (filtered by type)
- [ ] Observations appear in CLAUDE.md files (for relevant folders)

### Anti-Pattern Guards

- Do NOT invent achievements not evidenced in session data
- Do NOT detect joy from polite/professional language (distinguish courtesy from excitement)
- Do NOT run during active session — post-session only
- Do NOT produce more than 3-5 observations per session (these are highlights, not logs)

### Files to Create

| File | Purpose |
|------|---------|
| `src/services/agency/AchievementScanner.ts` | Scanner logic + prompt |
| `src/services/agency/JoyDetector.ts` | Detector logic + prompt |
| `src/services/agency/prompts/achievement-prompt.ts` | Achievement scanner system prompt |
| `src/services/agency/prompts/joy-prompt.ts` | Joy detector system prompt |

---

## Phase 4: Identity Resume Context Section

### What to Implement

A new section in the context injection pipeline that queries `achievement` and `joy-moment` type observations and renders an Identity Resume block. This appears at session start, giving the agent its identity context.

**Copy pattern from**: `src/services/context/sections/SummaryRenderer.ts` — section renderer with dual formatters.

#### Resume Query

```typescript
// In ObservationCompiler.ts (new exported function)

export function queryIdentityObservations(
  db: SessionStore,
  project: string,
  limit: number
): { achievements: Observation[]; joyMoments: Observation[] }
```

This queries the existing `observations` table filtered by `type IN ('achievement', 'joy-moment')`, ordered by `created_at_epoch DESC`, limited to configurable count.

#### Resume Renderer

```typescript
// src/services/context/sections/IdentityResumeRenderer.ts

export function renderIdentityResume(
  achievements: Observation[],
  joyMoments: Observation[],
  useColors: boolean
): string[]
```

Renders as:

```markdown
## Identity Context

### What We've Built Together
- [achievement.title]: [achievement.subtitle]
  [achievement.narrative]
- ...

### What We've Shared
- [joy-moment.title]: [joy-moment.subtitle]
  [joy-moment.narrative]
- ...
```

If either section is empty, it's omitted. If both are empty, the entire Identity Context section is omitted (no empty shell).

#### Integration into ContextBuilder

Insert between header and timeline in `buildContextOutput()`:

```typescript
// After renderHeader(), before timeline preparation
const identityObs = queryIdentityObservations(db, project, config.identityObservationCount);
if (identityObs.achievements.length > 0 || identityObs.joyMoments.length > 0) {
  output.push(...renderIdentityResume(identityObs.achievements, identityObs.joyMoments, useColors));
}
```

#### Settings

Add `CLAUDE_MEM_CONTEXT_IDENTITY_COUNT` setting (default: `10`) — max achievement + joy-moment observations in identity section. Add `CLAUDE_MEM_AGENCY_ENABLED` setting (default: `true`) — master toggle.

### Documentation References

- Section renderer: `src/services/context/sections/SummaryRenderer.ts` lines 46-65
- Markdown formatter: `src/services/context/formatters/MarkdownFormatter.ts`
- Color formatter: `src/services/context/formatters/ColorFormatter.ts`
- Context builder: `src/services/context/ContextBuilder.ts` lines 84-117
- Observation query: `src/services/context/ObservationCompiler.ts:queryObservations()` lines 25-50

### Verification Checklist

- [ ] Identity section renders when achievement/joy observations exist
- [ ] Identity section is omitted entirely when no such observations exist
- [ ] Both markdown and color rendering work correctly
- [ ] Section appears between header and timeline
- [ ] `CLAUDE_MEM_CONTEXT_IDENTITY_COUNT` controls max entries
- [ ] `CLAUDE_MEM_AGENCY_ENABLED=false` suppresses the section entirely
- [ ] Context generation does not fail if feature is new (no observations yet)

### Anti-Pattern Guards

- Do NOT render empty sections (no "### What We've Built Together" with nothing under it)
- Do NOT query with complex joins — simple `WHERE type IN ('achievement','joy-moment')` on observations table
- Do NOT duplicate identity observations in the regular timeline (filter them out of the main timeline query)

### Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/services/context/sections/IdentityResumeRenderer.ts` |
| Modify | `src/services/context/formatters/MarkdownFormatter.ts` — Add identity resume formatting functions |
| Modify | `src/services/context/formatters/ColorFormatter.ts` — Add identity resume formatting functions |
| Modify | `src/services/context/ContextBuilder.ts` — Add identity section between header and timeline |
| Modify | `src/services/context/ObservationCompiler.ts` — Add `queryIdentityObservations()` |
| Modify | `src/services/context/types.ts` — Add `identityObservationCount` to ContextConfig |
| Modify | `src/services/context/ContextConfigLoader.ts` — Load new settings |
| Modify | `src/shared/SettingsDefaultsManager.ts` — Add `CLAUDE_MEM_CONTEXT_IDENTITY_COUNT`, `CLAUDE_MEM_AGENCY_ENABLED` |

---

## Phase 5: Session-End Pipeline Integration

### What to Implement

Wire the scanners into the session-end lifecycle. After session completion, read the session's data and run the Achievement Scanner + Joy Detector. Store results as regular observations.

**Copy pattern from**: `src/services/worker/session/SessionCompletionHandler.ts` — post-session hook point. `src/services/worker/agents/ResponseProcessor.ts` — store + sync pattern.

#### Pipeline Orchestrator

```typescript
// src/services/agency/AgencyPipeline.ts

export async function runAgencyPipeline(
  sessionDbId: number,
  memorySessionId: string,
  contentSessionId: string,
  project: string,
  dbManager: DatabaseManager
): Promise<void> {
  // 1. Check if agency is enabled
  if (!SettingsDefaultsManager.getBool('CLAUDE_MEM_AGENCY_ENABLED')) return;

  // 2. Load session data from DB
  const observations = store.getObservationsForSession(memorySessionId);
  const summary = store.getSessionSummary(memorySessionId);
  const userPrompts = store.getUserPrompts(contentSessionId);

  // 3. Skip trivial sessions
  if (observations.length < minObservations) return;

  // 4. Run scanners in parallel
  const [achievements, joyMoments] = await Promise.all([
    scanForAchievements({ memorySessionId, project, observations, summary, userPrompts }),
    detectJoyMoments({ memorySessionId, project, observations, summary, userPrompts })
  ]);

  // 5. Store as regular observations using existing pipeline
  const allNew = [...achievements, ...joyMoments];
  for (const obs of allNew) {
    const result = storeObservation(db, memorySessionId, project, obs, null, 0, Date.now());
    // Sync to ChromaDB
    chromaSync.syncObservation(result.id, memorySessionId, project, obs, null, result.createdAtEpoch, 0);
  }
}
```

#### Integration Point

Modify `SessionCompletionHandler.completeByDbId()`:

```typescript
async completeByDbId(sessionDbId: number): Promise<void> {
  // Capture IDs BEFORE deletion
  const sessionInfo = this.sessionManager.getSessionInfo(sessionDbId);

  // Existing: delete from session manager
  await this.sessionManager.deleteSession(sessionDbId);

  // NEW: Fire-and-forget agency pipeline
  if (sessionInfo) {
    runAgencyPipeline(
      sessionDbId,
      sessionInfo.memorySessionId,
      sessionInfo.contentSessionId,
      sessionInfo.project,
      this.dbManager
    ).catch(err => {
      logger.error('AGENCY', 'Pipeline failed (non-critical)', {}, err);
    });
  }

  // Existing: broadcast completion
  this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
}
```

The pipeline is fire-and-forget — session completion is never blocked by agency analysis.

### Documentation References

- Session completion: `src/services/worker/session/SessionCompletionHandler.ts` lines 26-32
- Observation store: `src/services/sqlite/observations/store.ts`
- Chroma sync: `src/services/sync/ChromaSync.ts:syncObservation()`
- Session queries: `src/services/sqlite/SessionStore.ts` — `getSessionSummaries()`, `getObservationsForSession()`
- User prompts: `src/services/sqlite/SessionStore.ts` — `getUserPrompts()`

### Verification Checklist

- [ ] Pipeline triggers on session completion
- [ ] Pipeline failure does NOT block session completion
- [ ] Session info captured before deletion
- [ ] Scanners run in parallel
- [ ] Results stored as regular observations
- [ ] Results synced to ChromaDB
- [ ] Pipeline skips when `CLAUDE_MEM_AGENCY_ENABLED=false`
- [ ] Pipeline skips trivial sessions (< min observations)
- [ ] `npm run build` succeeds
- [ ] `npm run build-and-sync` succeeds

### Anti-Pattern Guards

- Do NOT run synchronously — must be fire-and-forget
- Do NOT query session data after `deleteSession()` — capture IDs before
- Do NOT create separate store functions — use existing `storeObservation()`
- Do NOT skip ChromaDB sync — agency observations need to be searchable

### Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/services/agency/AgencyPipeline.ts` |
| Create | `src/services/agency/index.ts` — Barrel export |
| Modify | `src/services/worker/session/SessionCompletionHandler.ts` — Add pipeline trigger + DatabaseManager dependency |

---

## Phase 6: Verification

### Full Integration Verification

1. **Mode config verification**:
   - `plugin/modes/code.json` has 8 observation types
   - `plugin/modes/code.json` has 13 observation concepts
   - Type/concept guidance prompt strings are updated
   - Settings defaults include new types/concepts

2. **Scanner verification**:
   - Feed known-good session data → Achievement Scanner produces `ParsedObservation[]` with `type: 'achievement'`
   - Feed known-good session data → Joy Detector produces `ParsedObservation[]` with `type: 'joy-moment'`
   - Feed trivial session → both return `[]`
   - Output parses through `parseObservations()` correctly
   - Output stores through `storeObservation()` correctly

3. **Context verification**:
   - Insert test achievement + joy-moment observations into DB
   - `generateContext()` → Identity Resume section appears between header and timeline
   - Delete test observations → Identity Resume section disappears entirely (no empty section)
   - Both markdown and color modes render correctly

4. **Pipeline verification**:
   - Complete a session → pipeline triggers
   - Agency observations appear in DB with correct types
   - Agency observations appear in ChromaDB
   - Pipeline failure → session completion unaffected
   - `CLAUDE_MEM_AGENCY_ENABLED=false` → pipeline skips

5. **CLAUDE.md verification**:
   - Agency observations appear in folder CLAUDE.md files with correct type emojis
   - `achievement` shows 🏆, `joy-moment` shows ✨

6. **Build verification**:
   - `npm run build` succeeds
   - `npm run build-and-sync` succeeds
   - Worker restarts and operates normally

---

## File Summary

### New Files (8)

| File | Purpose |
|------|---------|
| `src/services/agency/types.ts` | Shared types (AgencyScanInput) |
| `src/services/agency/AgencyLLMClient.ts` | Multi-provider single-shot LLM wrapper |
| `src/services/agency/AchievementScanner.ts` | Post-session achievement extraction |
| `src/services/agency/JoyDetector.ts` | Post-session joy moment detection |
| `src/services/agency/AgencyPipeline.ts` | Pipeline orchestrator |
| `src/services/agency/prompts/achievement-prompt.ts` | Achievement scanner system prompt |
| `src/services/agency/prompts/joy-prompt.ts` | Joy detector system prompt |
| `src/services/context/sections/IdentityResumeRenderer.ts` | Identity Resume context section |

### Modified Files (8)

| File | Change |
|------|--------|
| `plugin/modes/code.json` | Add 2 types, 6 concepts, update guidance prompts |
| `src/shared/SettingsDefaultsManager.ts` | Add `CLAUDE_MEM_AGENCY_ENABLED`, `CLAUDE_MEM_CONTEXT_IDENTITY_COUNT`, update type/concept defaults |
| `src/services/worker/session/SessionCompletionHandler.ts` | Add pipeline trigger + DatabaseManager dependency |
| `src/services/context/ContextBuilder.ts` | Add Identity Resume section |
| `src/services/context/ObservationCompiler.ts` | Add `queryIdentityObservations()` |
| `src/services/context/ContextConfigLoader.ts` | Load identity count setting |
| `src/services/context/types.ts` | Add `identityObservationCount` to ContextConfig |
| `src/services/context/formatters/MarkdownFormatter.ts` | Add identity resume markdown rendering |
