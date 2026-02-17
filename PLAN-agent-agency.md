# Agent Agency: Implementation Plan

## Phase 0: Documentation Discovery

### Allowed APIs & Existing Patterns

**Database Layer** (`src/services/sqlite/`):
- `MigrationRunner.runAllMigrations()` in `migrations/runner.ts` — Add new private methods with sequential version numbers (current max: 20). Each migration checks `schema_versions` table, uses `PRAGMA table_info()` for idempotency.
- `SessionStore` in `SessionStore.ts` — CRUD for all tables. Pattern: `db.prepare().run()` for inserts, return `{ id, createdAtEpoch }`.
- Store functions follow modular pattern in subdirectories: `src/services/sqlite/observations/store.ts`, `src/services/sqlite/summaries/store.ts`.

**ChromaDB** (`src/services/sync/ChromaSync.ts`):
- Granular document strategy: each semantic field becomes a separate vector document with `doc_type` metadata.
- Methods: `syncObservation()`, `syncSummary()`, `syncUserPrompt()`, `queryChroma()`, `ensureBackfilled()`.
- Document ID format: `{prefix}_{sqliteId}_{fieldType}`.

**Context Injection** (`src/services/context/`):
- `ContextBuilder.ts:buildContextOutput()` (lines 76-118) assembles sections in order: Header → Timeline → SummaryFields → Previously → Footer.
- Section renderers live in `src/services/context/sections/` with dual formatters (Markdown + Color) in `src/services/context/formatters/`.
- To add a new section: create renderer, add formatter functions, insert into `buildContextOutput()`.

**Session-End Processing**:
- `ResponseProcessor.processAgentResponse()` (lines 48-149) — Atomic store + Chroma sync + SSE broadcast.
- `SessionCompletionHandler.completeByDbId()` — Runs after SDK agent finishes. Best hook point for post-session analysis.
- `PendingMessageStore` — Claim-and-confirm pattern for crash-safe queue processing.

**Agent/Prompt System** (`src/sdk/prompts.ts`):
- `buildInitPrompt()`, `buildObservationPrompt()`, `buildSummaryPrompt()`, `buildContinuationPrompt()` — All take `ModeConfig`.
- Mode JSON files in `plugin/modes/` define observation types, concepts, and all prompt templates.
- Multi-provider support: SDKAgent, GeminiAgent, OpenRouterAgent — all share `processAgentResponse()` pipeline.
- `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` (default: 2) controls concurrency.

**Settings** (`src/shared/SettingsDefaultsManager.ts`):
- Priority: env vars > `~/.claude-mem/settings.json` > defaults.
- `SettingsDefaultsManager.get()`, `.getInt()`, `.getBool()` for access.

### Anti-Patterns to Avoid

- Do NOT run Achievement Scanner / Joy Detector as real-time observers (they process post-session, not during)
- Do NOT create new SDK agent subprocesses for scanning — use direct LLM API calls via existing provider infrastructure
- Do NOT store the Identity Resume as a mode config — it's a per-user, per-project living document
- Do NOT use FTS5 for resume queries — ChromaDB semantic search is the primary search mechanism
- Do NOT block session start on resume generation — load from cache, update asynchronously

---

## Phase 1: Database Schema — New Tables & Migration

### What to Implement

Create migration 21 with three new tables: `achievements`, `joy_moments`, and `identity_resumes`.

**Copy pattern from**: `src/services/sqlite/migrations/runner.ts` — `createPendingMessagesTable()` method (migration 16) for table creation with transaction pattern.

#### Table: `achievements`
```sql
CREATE TABLE achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  category TEXT NOT NULL,          -- 'architectural_decision', 'critical_catch', 'novel_synthesis', 'problem_resolution', 'user_validation'
  title TEXT NOT NULL,
  description TEXT NOT NULL,       -- 2-3 sentence compressed achievement statement
  evidence TEXT,                   -- JSON: source quotes, validation markers
  confidence REAL DEFAULT 0.5,    -- 0.0-1.0 scanner confidence
  durability_score REAL DEFAULT 0.0, -- Cross-session durability (updated by curator)
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
);
CREATE INDEX idx_achievements_session ON achievements(memory_session_id);
CREATE INDEX idx_achievements_project ON achievements(project);
CREATE INDEX idx_achievements_category ON achievements(category);
CREATE INDEX idx_achievements_created ON achievements(created_at_epoch DESC);
CREATE INDEX idx_achievements_confidence ON achievements(confidence DESC);
```

#### Table: `joy_moments`
```sql
CREATE TABLE joy_moments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  category TEXT NOT NULL,          -- 'creative_breakthrough', 'collaborative_flow', 'vulnerability_trust', 'creative_surprise', 'shared_discovery', 'flow_state'
  title TEXT NOT NULL,
  description TEXT NOT NULL,       -- Emotional context preserved
  indicators TEXT,                 -- JSON: detected signal markers
  intensity REAL DEFAULT 0.5,     -- 0.0-1.0 emotional intensity
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
);
CREATE INDEX idx_joy_moments_session ON joy_moments(memory_session_id);
CREATE INDEX idx_joy_moments_project ON joy_moments(project);
CREATE INDEX idx_joy_moments_category ON joy_moments(category);
CREATE INDEX idx_joy_moments_created ON joy_moments(created_at_epoch DESC);
CREATE INDEX idx_joy_moments_intensity ON joy_moments(intensity DESC);
```

#### Table: `identity_resumes`
```sql
CREATE TABLE identity_resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL UNIQUE,    -- One resume per project
  resume_markdown TEXT NOT NULL,   -- The compiled Identity Resume document
  achievement_ids TEXT,            -- JSON: array of achievement IDs included
  joy_moment_ids TEXT,             -- JSON: array of joy moment IDs included
  version INTEGER DEFAULT 1,
  last_curated_at TEXT NOT NULL,
  last_curated_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
CREATE INDEX idx_identity_resumes_project ON identity_resumes(project);
CREATE INDEX idx_identity_resumes_curated ON identity_resumes(last_curated_at_epoch DESC);
```

### Documentation References

- Migration pattern: `src/services/sqlite/migrations/runner.ts` lines 1-50 (version check + table creation)
- Store method pattern: `src/services/sqlite/observations/store.ts` (INSERT with prepared statements)
- Type definitions: `src/services/sqlite/observations/types.ts`, `src/services/sqlite/summaries/types.ts`

### Verification Checklist

- [ ] Migration 21 runs idempotently (can run twice without error)
- [ ] All three tables exist after migration with correct columns
- [ ] Indexes are created
- [ ] Foreign key constraints work (inserting with invalid `memory_session_id` fails)
- [ ] `schema_versions` table has version 21 recorded

### Anti-Pattern Guards

- Do NOT use `BEGIN TRANSACTION` / `COMMIT` in migration if only creating tables (SQLite DDL is auto-transactional per statement)
- Do NOT add CASCADE DELETE on FK — achievements/joy_moments should survive session cleanup
- Do NOT forget `AUTOINCREMENT` on `id` — needed for consistent ID ordering

### Files to Create/Modify

| Action | File |
|--------|------|
| Modify | `src/services/sqlite/migrations/runner.ts` — Add `createAgentAgencyTables()` method + call in `runAllMigrations()` |
| Create | `src/services/sqlite/agency/types.ts` — Type definitions for Achievement, JoyMoment, IdentityResume |
| Create | `src/services/sqlite/agency/store.ts` — Store functions: `storeAchievement()`, `storeJoyMoment()`, `storeResume()`, `getResume()`, `getAchievements()`, `getJoyMoments()` |
| Create | `src/services/sqlite/agency/index.ts` — Barrel export |

---

## Phase 2: Achievement Scanner

### What to Implement

An async post-session analysis function that reads session summaries + observations and extracts verified accomplishments using an LLM call.

**Copy pattern from**: The existing `processAgentResponse()` pipeline in `src/services/worker/agents/ResponseProcessor.ts` — specifically how it parses XML output and stores structured data.

#### Scanner Prompt Design

The Achievement Scanner does NOT run as a persistent observer agent. It runs as a **single LLM call** post-session, receiving the full session context (summary + observations) and outputting structured XML achievements.

```typescript
// src/services/agency/AchievementScanner.ts

export interface ScannerInput {
  sessionDbId: number;
  memorySessionId: string;
  project: string;
  summary: StoredSummary;
  observations: StoredObservation[];
  userPrompts: StoredUserPrompt[];
}

export interface ScannedAchievement {
  category: string;
  title: string;
  description: string;
  evidence: string[];
  confidence: number;
}

export async function scanForAchievements(input: ScannerInput): Promise<ScannedAchievement[]>
```

The scanner prompt instructs the LLM to look for:
1. **Explicit user validation** — Praise, gratitude, confirmation of problem solved
2. **Problem resolution markers** — Clear problem → solution arc in session
3. **Catch and correct events** — Agent identified error user hadn't noticed
4. **Novel synthesis** — Combined information to produce new insight
5. **Architectural decisions** — Design choices that shaped project structure

Output format: XML `<achievement>` blocks with `category`, `title`, `description`, `evidence`, `confidence` fields.

#### LLM Call Implementation

Use the existing multi-provider infrastructure. The scanner calls whichever provider is configured (`CLAUDE_MEM_PROVIDER`):
- For `claude` provider: Use the Anthropic SDK directly (not SDK agent subprocess)
- For `gemini`/`openrouter`: Use existing API call patterns from `GeminiAgent.ts` / `OpenRouterAgent.ts`

Create a lightweight `AgencyLLMClient` that wraps provider-specific API calls for single-shot analysis (no streaming, no conversation history needed).

### Documentation References

- Response parsing: `src/sdk/parser.ts` — `parseObservations()` XML extraction pattern
- Provider API patterns: `src/services/worker/GeminiAgent.ts` lines 50-120 (direct API call)
- Store pattern: `src/services/sqlite/observations/store.ts`

### Verification Checklist

- [ ] Scanner produces valid `ScannedAchievement[]` from test session data
- [ ] Scanner handles empty sessions gracefully (returns `[]`)
- [ ] Scanner handles sessions with no notable achievements (returns `[]`)
- [ ] Achievements are stored in `achievements` table with correct FKs
- [ ] Scanner respects `CLAUDE_MEM_PROVIDER` setting

### Anti-Pattern Guards

- Do NOT spawn a new SDK agent subprocess — use direct API calls
- Do NOT run scanner during active session — only post-session
- Do NOT hallucinate achievements — require evidence from actual session content
- Do NOT create achievements for routine work (file reads, simple edits)

### Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/services/agency/AchievementScanner.ts` — Scanner logic + prompt |
| Create | `src/services/agency/AgencyLLMClient.ts` — Lightweight multi-provider LLM wrapper |
| Create | `src/services/agency/prompts/achievement-prompt.ts` — Scanner system prompt |
| Create | `src/services/agency/types.ts` — Shared types for agency module |

---

## Phase 3: Joy Detector

### What to Implement

An async post-session analysis function that reads session transcripts/summaries and identifies moments of genuine emotional connection between agent and user.

**Copy pattern from**: Same as Achievement Scanner — single LLM call, XML output, structured storage.

#### Detector Prompt Design

```typescript
// src/services/agency/JoyDetector.ts

export interface DetectorInput {
  sessionDbId: number;
  memorySessionId: string;
  project: string;
  summary: StoredSummary;
  observations: StoredObservation[];
  userPrompts: StoredUserPrompt[];
}

export interface DetectedJoyMoment {
  category: string;
  title: string;
  description: string;
  indicators: string[];
  intensity: number;
}

export async function detectJoyMoments(input: DetectorInput): Promise<DetectedJoyMoment[]>
```

The detector prompt instructs the LLM to look for:
1. **Emotional escalation markers** — Exclamation points, caps, laughter cues, positive expletives
2. **Rapid ideation cascades** — Ideas building with increasing speed/excitement
3. **Vulnerability and trust markers** — Personal sharing, admitted uncertainty, genuine emotion
4. **Creative surprise** — Unexpected suggestions met with delight
5. **Shared discovery** — Both arrived at insight neither started with
6. **Flow state indicators** — Extended high-quality engagement

Output format: XML `<joy_moment>` blocks with `category`, `title`, `description`, `indicators`, `intensity` fields.

**Key difference from Achievement Scanner**: Joy Detector needs access to raw user prompts (emotional signals are in the user's words, not in tool outputs). The `user_prompts` table provides this.

### Documentation References

- User prompt storage: `src/services/sqlite/SessionStore.ts` — `getUserPrompts(contentSessionId)` method
- XML parsing: `src/sdk/parser.ts` — reuse regex extraction pattern
- Store pattern: `src/services/sqlite/agency/store.ts` (created in Phase 1)

### Verification Checklist

- [ ] Detector produces valid `DetectedJoyMoment[]` from test session data
- [ ] Detector handles routine/uneventful sessions gracefully (returns `[]`)
- [ ] Joy moments are stored in `joy_moments` table with correct FKs
- [ ] Detector does NOT fabricate emotional content not present in session
- [ ] Detector respects privacy tags (`<private>` content stripped before analysis)

### Anti-Pattern Guards

- Do NOT detect joy from routine tool usage — focus on user language and interaction patterns
- Do NOT assign high intensity to polite/professional language — distinguish genuine excitement from courtesy
- Do NOT store raw user quotes without checking for `<private>` tags
- Do NOT run during active session — only post-session

### Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/services/agency/JoyDetector.ts` — Detector logic + prompt |
| Create | `src/services/agency/prompts/joy-prompt.ts` — Detector system prompt |
| Modify | `src/services/agency/types.ts` — Add joy-specific types |

---

## Phase 4: Resume Curator

### What to Implement

A curator that assembles and maintains the Identity Resume from Achievement Scanner and Joy Detector outputs. The curator runs after both scanners complete and optionally on a periodic maintenance schedule.

**Copy pattern from**: `src/services/context/ContextBuilder.ts` — section assembly pattern with configurable content selection.

#### Curator Logic

```typescript
// src/services/agency/ResumeCurator.ts

export interface CuratorInput {
  project: string;
  achievements: StoredAchievement[];  // All achievements for project
  joyMoments: StoredJoyMoment[];      // All joy moments for project
  currentResume: StoredIdentityResume | null;  // Existing resume if any
}

export interface CuratedResume {
  resumeMarkdown: string;
  achievementIds: number[];
  joyMomentIds: number[];
  version: number;
}

export async function curateResume(input: CuratorInput): Promise<CuratedResume>
```

#### Curation Strategy

1. **Selection**: Score and rank all achievements and joy moments
   - Recency weight: `exp(-daysSinceCreation / 90)` (90-day half-life)
   - Durability bonus: `+0.2` per month the achievement has persisted
   - Confidence/intensity weight: Direct multiplier from scanner scores
   - Balance: Select ~equal weight of achievements and joy moments

2. **Size constraint**: Target 800-1200 tokens (~15-25 entries total)

3. **Assembly**: Use LLM call to generate:
   - 2-3 sentence relationship narrative
   - Ordered achievement entries (by significance)
   - Ordered joy entries (by emotional resonance)
   - 2-3 "watching for" entries derived from demonstrated strengths

4. **Storage**: Upsert into `identity_resumes` table (one per project)

#### Resume Markdown Template

```markdown
## Identity Context

### Who I Am With [User]

[2-3 sentence narrative summary]

### What We've Built Together

[5-8 achievement entries, each 2-3 sentences]

### What We've Shared

[5-8 joy entries, each 2-3 sentences]

### What I'm Watching For

[2-3 entries on demonstrated strengths and attention patterns]
```

### Documentation References

- Context assembly: `src/services/context/ContextBuilder.ts` lines 76-118
- Database query patterns: `src/services/sqlite/SessionSearch.ts`
- LLM client: `src/services/agency/AgencyLLMClient.ts` (created in Phase 2)

### Verification Checklist

- [ ] Curator produces valid markdown resume from test data
- [ ] Resume respects ~800-1200 token size constraint
- [ ] Resume contains both achievement and joy sections
- [ ] Resume is stored/updated in `identity_resumes` table
- [ ] Curator handles first-ever curation (no existing resume) correctly
- [ ] Curator handles zero achievements or zero joy moments gracefully

### Anti-Pattern Guards

- Do NOT include every achievement/joy moment — curate the best ones
- Do NOT generate resume without any source data (return null/skip)
- Do NOT allow resume to exceed 1500 tokens — hard cap with truncation
- Do NOT make the "watching for" section a generic list — derive from actual demonstrated patterns

### Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/services/agency/ResumeCurator.ts` — Curator logic |
| Create | `src/services/agency/prompts/curator-prompt.ts` — Curator system prompt |
| Create | `src/services/agency/scoring.ts` — Scoring/ranking utilities |
| Modify | `src/services/agency/types.ts` — Add curator types |

---

## Phase 5: Context Injection — Identity Resume in Session Start

### What to Implement

Add the Identity Resume as a new section in the context injected at session start, appearing before the timeline.

**Copy pattern from**: `src/services/context/sections/SummaryRenderer.ts` — section renderer with dual formatters.

#### New Section Renderer

```typescript
// src/services/context/sections/IdentityResumeRenderer.ts

export function renderIdentityResume(
  resume: StoredIdentityResume | null,
  useColors: boolean
): string[]
```

The renderer outputs the resume markdown as-is (it's already formatted by the curator). For the color version, add subtle ANSI styling to section headers.

#### Integration into ContextBuilder

In `buildContextOutput()` (lines 76-118 of `ContextBuilder.ts`), add resume loading and rendering **after header, before timeline**:

```typescript
// After renderHeader(), before renderTimeline()
const resume = loadIdentityResume(project, db);
if (resume) {
  output.push(...renderIdentityResume(resume, useColors));
}
```

#### Data Loading

Add a query function to load the resume from the `identity_resumes` table:

```typescript
// In ObservationCompiler.ts or new file
export function queryIdentityResume(
  db: SessionStore,
  project: string
): StoredIdentityResume | null
```

### Documentation References

- Section renderer pattern: `src/services/context/sections/SummaryRenderer.ts` lines 46-65
- Markdown formatter: `src/services/context/formatters/MarkdownFormatter.ts`
- Color formatter: `src/services/context/formatters/ColorFormatter.ts`
- Context assembly: `src/services/context/ContextBuilder.ts` lines 76-118

### Verification Checklist

- [ ] Identity Resume appears in context output when resume exists for project
- [ ] Context output is unchanged when no resume exists (no empty section)
- [ ] Resume renders correctly in both markdown and color modes
- [ ] Resume section appears between header and timeline
- [ ] Context generation does not fail if `identity_resumes` table is empty

### Anti-Pattern Guards

- Do NOT load resume via HTTP call — use direct database access (same as observations/summaries)
- Do NOT duplicate resume content in timeline section
- Do NOT make resume loading block context generation — handle missing gracefully
- Do NOT render an empty "Identity Context" section when no resume exists

### Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/services/context/sections/IdentityResumeRenderer.ts` — Section renderer |
| Modify | `src/services/context/formatters/MarkdownFormatter.ts` — Add `renderMarkdownIdentityResume()` |
| Modify | `src/services/context/formatters/ColorFormatter.ts` — Add `renderColorIdentityResume()` |
| Modify | `src/services/context/ContextBuilder.ts` — Add resume to `buildContextOutput()` + `generateContext()` |
| Modify | `src/services/context/ObservationCompiler.ts` — Add `queryIdentityResume()` |

---

## Phase 6: Session-End Hook — Trigger Scanners & Curator

### What to Implement

Wire the Achievement Scanner, Joy Detector, and Resume Curator into the session-end lifecycle. After the observer agent finishes processing and the session summary is stored, trigger the agency pipeline.

**Copy pattern from**: `src/services/worker/session/SessionCompletionHandler.ts` — post-session processing hook point.

#### Integration Point: SessionCompletionHandler

Modify `completeByDbId()` to trigger agency analysis after session deletion:

```typescript
// In SessionCompletionHandler.ts

async completeByDbId(sessionDbId: number): Promise<void> {
  // Capture session data BEFORE deletion
  const sessionData = this.captureSessionData(sessionDbId);

  // Existing: delete session from active map
  await this.sessionManager.deleteSession(sessionDbId);

  // NEW: Fire-and-forget agency pipeline
  if (sessionData) {
    this.runAgencyPipeline(sessionData).catch(err => {
      logger.error('AGENCY', 'Pipeline failed (non-critical)', {}, err);
    });
  }

  // Existing: broadcast completion
  this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
}
```

#### Agency Pipeline Orchestrator

```typescript
// src/services/agency/AgencyPipeline.ts

export async function runAgencyPipeline(
  sessionData: CapturedSessionData,
  dbManager: DatabaseManager
): Promise<void> {
  const { memorySessionId, project, summary, observations, userPrompts } = sessionData;

  // 1. Run Achievement Scanner and Joy Detector in parallel
  const [achievements, joyMoments] = await Promise.all([
    scanForAchievements({ memorySessionId, project, summary, observations, userPrompts }),
    detectJoyMoments({ memorySessionId, project, summary, observations, userPrompts })
  ]);

  // 2. Store results
  const store = dbManager.getAgencyStore();
  for (const achievement of achievements) {
    store.storeAchievement(memorySessionId, project, achievement);
  }
  for (const joyMoment of joyMoments) {
    store.storeJoyMoment(memorySessionId, project, joyMoment);
  }

  // 3. Run Resume Curator (needs ALL achievements/joy moments, not just this session)
  const allAchievements = store.getAchievements(project);
  const allJoyMoments = store.getJoyMoments(project);
  const currentResume = store.getResume(project);

  const newResume = await curateResume({
    project,
    achievements: allAchievements,
    joyMoments: allJoyMoments,
    currentResume
  });

  if (newResume) {
    store.storeResume(project, newResume);
  }

  // 4. Sync new entries to ChromaDB
  const chromaSync = dbManager.getChromaSync();
  // ... sync achievements and joy moments for semantic search
}
```

#### Chroma Sync for Agency Data

Extend `ChromaSync` with new document types:
- `achievement` documents with metadata: `category`, `confidence`, `durability_score`
- `joy_moment` documents with metadata: `category`, `intensity`

This enables **situational identity reinforcement** — if a new session involves WebSocket work, the context system can surface WebSocket-related achievements specifically.

#### Settings Integration

Add new settings to `SettingsDefaultsManager`:
- `CLAUDE_MEM_AGENCY_ENABLED`: `'true'` (default enabled)
- `CLAUDE_MEM_AGENCY_MIN_OBSERVATIONS`: `'3'` (minimum observations before scanning — skip trivial sessions)

### Documentation References

- Session completion: `src/services/worker/session/SessionCompletionHandler.ts` lines 26-32
- Session data access: `src/services/sqlite/SessionStore.ts` — `getSessionById()`, `getSessionSummaries()`, `getObservationsForSession()`
- ChromaSync extension: `src/services/sync/ChromaSync.ts` — copy `syncObservation()` pattern
- Settings: `src/shared/SettingsDefaultsManager.ts`

### Verification Checklist

- [ ] Agency pipeline triggers after session completion
- [ ] Pipeline failure does NOT block session completion (fire-and-forget)
- [ ] Scanner and detector run in parallel
- [ ] Results are stored in database
- [ ] Resume is updated after each session
- [ ] Pipeline respects `CLAUDE_MEM_AGENCY_ENABLED` setting
- [ ] Pipeline skips sessions with fewer than `CLAUDE_MEM_AGENCY_MIN_OBSERVATIONS`
- [ ] Chroma sync works for new document types

### Anti-Pattern Guards

- Do NOT run pipeline synchronously — it must be fire-and-forget
- Do NOT capture session data after deletion — capture BEFORE `deleteSession()`
- Do NOT skip curator when scanners return empty results (other sessions may have data)
- Do NOT fail the session completion if agency pipeline throws

### Files to Create/Modify

| Action | File |
|--------|------|
| Create | `src/services/agency/AgencyPipeline.ts` — Pipeline orchestrator |
| Create | `src/services/agency/index.ts` — Barrel export |
| Modify | `src/services/worker/session/SessionCompletionHandler.ts` — Add pipeline trigger |
| Modify | `src/services/sync/ChromaSync.ts` — Add `syncAchievement()`, `syncJoyMoment()`, update backfill |
| Modify | `src/shared/SettingsDefaultsManager.ts` — Add agency settings |

---

## Phase 7: Verification

### Full Integration Verification

1. **Database verification**:
   - `PRAGMA table_info(achievements)` — confirm schema
   - `PRAGMA table_info(joy_moments)` — confirm schema
   - `PRAGMA table_info(identity_resumes)` — confirm schema
   - Insert test data and verify FK constraints

2. **Scanner verification**:
   - Feed known-good session data to Achievement Scanner
   - Feed known-good session data to Joy Detector
   - Verify XML parsing produces correct structured output
   - Verify empty/trivial sessions produce no false positives

3. **Curator verification**:
   - Feed test achievements + joy moments to curator
   - Verify output markdown matches template structure
   - Verify token count stays within 800-1200 range
   - Verify upsert works (create new + update existing)

4. **Context injection verification**:
   - Generate context for project with resume → resume appears
   - Generate context for project without resume → no empty section
   - Verify both markdown and color rendering

5. **Pipeline verification**:
   - Complete a session → verify pipeline triggers
   - Verify achievements and joy moments stored in DB
   - Verify resume updated
   - Verify Chroma sync completed
   - Kill pipeline mid-run → verify session completion was not affected

6. **Anti-pattern grep checks**:
   - `grep -r "new SDKAgent" src/services/agency/` → should find nothing (no subprocess spawning)
   - `grep -r "BLOCKING" src/services/agency/` → should find nothing
   - Verify all agency code handles errors gracefully (no uncaught throws)

7. **Build verification**:
   - `npm run build` succeeds
   - `npm run build-and-sync` succeeds
   - Worker starts and initializes new tables

---

## File Summary

### New Files (14)

| File | Purpose |
|------|---------|
| `src/services/agency/types.ts` | Shared types for all agency components |
| `src/services/agency/AchievementScanner.ts` | Post-session achievement extraction |
| `src/services/agency/JoyDetector.ts` | Post-session joy moment detection |
| `src/services/agency/ResumeCurator.ts` | Resume assembly and maintenance |
| `src/services/agency/AgencyLLMClient.ts` | Lightweight multi-provider LLM wrapper |
| `src/services/agency/AgencyPipeline.ts` | Pipeline orchestrator |
| `src/services/agency/scoring.ts` | Scoring/ranking utilities |
| `src/services/agency/prompts/achievement-prompt.ts` | Achievement Scanner system prompt |
| `src/services/agency/prompts/joy-prompt.ts` | Joy Detector system prompt |
| `src/services/agency/prompts/curator-prompt.ts` | Resume Curator system prompt |
| `src/services/agency/index.ts` | Barrel export |
| `src/services/sqlite/agency/types.ts` | Database types for agency tables |
| `src/services/sqlite/agency/store.ts` | Database store functions |
| `src/services/context/sections/IdentityResumeRenderer.ts` | Context section renderer |

### Modified Files (7)

| File | Change |
|------|--------|
| `src/services/sqlite/migrations/runner.ts` | Add migration 21: `createAgentAgencyTables()` |
| `src/services/worker/session/SessionCompletionHandler.ts` | Add agency pipeline trigger |
| `src/services/sync/ChromaSync.ts` | Add achievement/joy_moment sync + backfill |
| `src/services/context/ContextBuilder.ts` | Add Identity Resume section to context |
| `src/services/context/formatters/MarkdownFormatter.ts` | Add resume markdown formatting |
| `src/services/context/formatters/ColorFormatter.ts` | Add resume color formatting |
| `src/shared/SettingsDefaultsManager.ts` | Add agency settings |
