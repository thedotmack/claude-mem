# Supersession & Conflict Detection: Implementation Analysis

**Date:** December 20, 2025
**Sources:** `supersession-system-report.md`, GitHub Discussion #282

---

## The Two Features

There are actually **two related but distinct features** being discussed:

| Feature | Type | Trigger | Goal |
|---------|------|---------|------|
| **Supersession System** | Manual cleanup | User invokes audit | Remove stale observations |
| **Conflict Detection** (#282) | Automatic prevention | New observation created | Prevent decision drift |

These are complementary, not alternatives. Supersession cleans up the past; conflict detection prevents future problems.

---

## What Would Definitely Work

### 1. Database Infrastructure (Already Done)

The schema is already in place and proven:

```sql
-- These exist and work
status TEXT DEFAULT 'active'
superseded_by INTEGER REFERENCES observations(id)
CREATE INDEX idx_observations_status ON observations(status);

-- Proof: 10 observations are already superseded
SELECT status, COUNT(*) FROM observations GROUP BY status;
-- active|29805
-- superseded|10
```

**Confidence: 100%** - This is just using existing infrastructure.

### 2. SessionStore.batchUpdateObservationStatus()

The original implementation used better-sqlite3 transactions for atomic batch updates. This is a well-understood pattern:

```typescript
// Pseudo-code - this worked before
batchUpdateObservationStatus(updates: Array<{
  observation_id: number;
  status: ObservationStatus;
  superseded_by?: number;
}>): BatchResult
```

**Confidence: 100%** - Just reconstruction of known-good code.

### 3. Worker API Endpoint

Adding `PATCH /api/observations/status` to the existing worker routes is trivial CRUD. The worker already handles all other observation operations.

**Confidence: 100%** - Follows existing patterns.

### 4. MCP Tool for Status Updates

Exposing the API as an MCP tool lets Claude invoke it during mem-search when conflicts are noticed:

```typescript
// Tool definition
{
  name: "update_observation_status",
  description: "Mark observations as superseded, deprecated, or meta",
  inputSchema: {
    updates: { type: "array", items: { observation_id, status, superseded_by? } }
  }
}
```

**Confidence: 100%** - Same pattern as existing MCP tools.

---

## What Would NOT Work

### 1. Real-Time Conflict Detection at Creation Time

**Problem**: Observation creation happens during PostToolUse hooks. Adding semantic search + LLM analysis would create unacceptable latency or race conditions.

**Also**: The observation isn't in Chroma yet when it's being created, so you can't search for conflicts against it.

### 2. Simple Keyword/Embedding Matching for Conflicts

**Problem**: Semantic similarity ≠ logical conflict.

Examples of false positives:
- "We chose PostgreSQL for the API" + "We're using SQLite locally" → High similarity, NOT a conflict
- "Don't use React" + "Implement with React" → Requires understanding negation

Embeddings catch topic similarity, not logical contradiction.

### 3. Blocking Observation Creation on Detected Conflicts

**Problem**: User experience disaster. People want their observations saved. Any conflict detection must be **advisory**, not blocking.

### 4. Configurable Sensitivity Thresholds

**Problem**: If users have to tune thresholds, the feature is already failing. Either detection works well at a single threshold, or it doesn't work well.

This is a red flag in #282's proposal.

### 5. Binary "Ground Truth" Model

**Problem**: Real projects have:
- Legitimate exceptions ("we use inheritance here despite preferring composition")
- Temporary states ("using mock auth during development")
- Context-dependent decisions ("TypeScript for frontend, Python for ML")

A simple "X supersedes Y" model is too rigid.

---

## What MIGHT Work (Needs Experimentation)

### 1. Batch Conflict Detection as On-Demand Job

**Concept**: Instead of real-time detection, run periodic sweeps. User triggers "audit topic X" or "check last N observations for conflicts."

**Why it might work**:
- Decouples detection from creation
- Allows human-in-the-loop confirmation
- Can use both Chroma (candidates) + LLM (analysis)

**Uncertainty**:
- Right granularity? Per-project? Per-topic? Everything?
- How noisy will results be?

**Experiment needed**:
Query Chroma for observations similar to known-superseded ones. Are the superseding observations in top-10 results? What's the false positive rate?

### 2. LLM-Powered Conflict Analysis Pipeline

**Concept**: Use Chroma for candidate retrieval, then Claude for conflict classification.

```
[New observation]
    → Chroma: "find similar observations"
    → Filter to decision-type observations
    → Claude: "Do these conflict? How?"
    → Present findings to user
```

**Why it might work**: LLMs understand context, negation, nuance that embeddings miss.

**Uncertainty**:
- Cost/latency per observation
- Prompt engineering quality
- False positive rate

**Experiment needed**:
Create test set of 20 observation pairs (10 true conflicts, 10 false conflicts). Measure Claude's classification accuracy.

### 3. Decision Categories/Tags

**Concept**: Categorize observations as: architecture, technology, conventions, security (per #282).

**Why it might work**:
- Reduces search space
- Makes conflicts more meaningful (security vs security)
- Enables category-specific thresholds

**Uncertainty**:
- Who assigns categories? Manual = tedious, automatic = inconsistent
- 30K existing observations have no categories

**Experiment needed**:
Have Claude categorize 50 random observations twice (different order). Measure agreement rate.

### 4. Soft Supersession with Exception Handling

**Concept**: Instead of hard "X supersedes Y", allow "X supersedes Y except in context Z".

**Why it might work**: Reflects reality of software decisions.

**Uncertainty**: Schema complexity, search complexity, UX complexity.

**Experiment needed**: Survey existing supersession patterns. Are exceptions common?

### 5. Conflict Detection in Mem-Search Workflow

**Concept**: When mem-search returns results, have Claude analyze them for conflicts in its response. No new infrastructure - just better prompting.

**Why it might work**:
- Zero infrastructure cost
- Human is already in the loop
- Natural integration point

**Uncertainty**: Will Claude reliably notice conflicts? Will users act on warnings?

**Experiment needed**: Update mem-search skill prompts, observe real-world behavior.

---

## Recommended Phased Approach

### Phase 1: Foundation (1-2 days, LOW RISK)

Resurrect the supersession infrastructure:

1. Add `SessionStore.batchUpdateObservationStatus()`
2. Add `PATCH /api/observations/status` to worker
3. Add MCP tool `update_observation_status`
4. Verify search excludes non-active observations

**Value**: Enables manual cleanup of ~30K observations. Unblocks everything else.

### Phase 2: Validate Detection Quality (before building more)

Run experiments using the 10 existing superseded observations:

1. **Chroma retrieval quality**: For each superseded observation, does Chroma return its superseding observation in top-10?
2. **LLM classification accuracy**: Given pairs, can Claude distinguish conflicts from related-but-compatible?

**Decision point**: If Chroma retrieval quality is <50%, skip Phase 3 entirely - embeddings aren't suitable for this task.

### Phase 3a: Enhanced Mem-Search (LOW RISK)

Update mem-search skill to explicitly prompt for conflict analysis:

```markdown
## Step 4: Conflict Analysis
Review the returned observations for potential conflicts:
- Are there contradictory architectural decisions?
- Do later observations supersede earlier ones?
- Should any observations be marked as deprecated?
```

**Value**: Gets most of #282's benefit with zero infrastructure.

### Phase 3b: Proactive Detection (HIGH RISK, deferred)

Only if Phase 2 experiments show >80% retrieval quality AND >90% classification accuracy:

1. At SessionEnd, find new decision-type observations
2. Query Chroma for similar past decisions
3. Use Claude to classify potential conflicts
4. Surface warnings in next SessionStart

**Reality check**: This is the hardest part. The experiments might show it's not feasible.

---

## Key Insights

### The 10 Superseded Observations Are Gold

They're ground truth for testing. Use them to validate any detection algorithm before building complex features.

### The Skill Was Probably Overkill

A simple MCP tool that Claude invokes during mem-search (when it notices conflicts) might be sufficient. Don't build a separate "clarity" workflow if enhancing mem-search works.

### Conflict Detection is a UX Problem, Not Just a Technical One

Even perfect detection is useless if:
- Warnings are buried in context (users ignore them)
- Too many false positives (users learn to ignore)
- No clear action path (user sees conflict, then what?)

### The Simplest Valuable Version

Update mem-search prompts to ask Claude to flag conflicts. No new infrastructure. Test whether this is useful before building automation.

---

## What I Would Build First

```
Week 1:
├── Day 1-2: Phase 1 (SessionStore + API + MCP tool)
├── Day 3: Run Chroma retrieval experiment
└── Day 4-5: Update mem-search skill prompts

Week 2:
├── If experiments positive: Design Phase 3b architecture
├── If experiments negative: Focus on manual curation workflow
└── Either way: Gather real-world feedback
```

The goal is to **learn quickly** whether automatic detection is feasible, while delivering **immediate value** through manual curation.

---

## Open Questions

1. **Should superseded observations be completely hidden from search, or just de-ranked?** Current behavior unclear.

2. **What's the right UX for conflict warnings?** SessionStart context? Separate notification? In-search highlighting?

3. **Should there be a "conflict resolution" observation type?** "We're aware X contradicts Y, here's why we're doing it anyway."

4. **Multi-project awareness**: How do we avoid false conflicts between different projects using the same claude-mem instance?

---

## Additional Hypotheses (Tape Play Analysis)

### Hypothesis A: Decision Observations as First-Class Citizens

**Concept**: Create a special "decision" observation type with explicit `replaces` and `scope` fields. Users mark observations as decisions.

**Tape Play Result**: **WOULD FAIL**

Simulated a developer making auth decisions over 60 days. The system prompted "Is this a decision?" after each observation.

- **What went right**: Explicit tracking worked, scoping allowed coexistence
- **What went wrong**: User had to answer "is this a decision?" EVERY time → decision fatigue → users click No to everything → system becomes useless

**Verdict**: UX friction kills adoption. Users won't tag things.

---

### Hypothesis B: Entity-Based Conflict Detection

**Concept**: Track entities (files, functions, packages) mentioned in observations. When same entity discussed differently over time, flag it.

**Tape Play Result**: **PARTIALLY WORKS**

Simulated work on `src/auth/jwt.ts` with algorithm changes.

- **What went right**: File-based detection is precise, low false positives
- **What went wrong**: Misses conceptual conflicts spanning files (Postgres in config.ts vs MongoDB in mongo.ts). Misses convention conflicts (no specific file).

**Verdict**: Good supplementary signal for file-specific changes. Not sufficient alone.

---

### Hypothesis C: Conflict Detection as Search Facet

**Concept**: When mem-search runs, cluster results by time. Flag temporal spread as "potentially evolved decisions."

**Tape Play Result**: **GOOD STARTING POINT**

Simulated search for "authentication implementation" returning results spanning 2 months.

```
Results:
1. [2 months ago] "Using JWT with refresh tokens"
2. [1 month ago] "Added OAuth2 for SSO customers"
3. [1 week ago] "Session-based auth for admin panel"

⚠️ Note: Results span 2 months and may represent evolving decisions.
```

- **What went right**: Zero new infrastructure, natural discovery moment, advisory not blocking
- **What went wrong**: Only triggers when user searches (reactive not proactive)

**Verdict**: Low cost, natural UX. Worth doing first.

---

### Hypothesis D: Temporal Decay with Conflict Surfacing

**Concept**: When new observation created about topic X, find old observations (>30 days) about X. Surface in NEXT session's context.

**Tape Play Result**: **PROMISING BUT NEEDS TUNING**

Simulated: Day 1 uses Redux, Day 90 uses Zustand. Day 91 session shows warning about the old Redux decision.

- **What went right**: Proactive surfacing, natural prompt to resolve
- **What went wrong**: Timing delayed (next session, not immediately). Risk of context pollution if threshold too low.

**Verdict**: Needs careful tuning of what surfaces when. Key question: similarity threshold.

---

### Hypothesis E: LLM-Native via Prompt Engineering

**Concept**: Tell Claude to notice conflicts in SessionStart observations. Zero infrastructure.

**Tape Play Result**: **EXCELLENT FIRST STEP**

Simulated: SessionStart injects two conflicting observations about TypeScript strict mode. Claude notices, asks user to clarify.

- **What went right**: ZERO infrastructure, natural conversational resolution, Claude understands nuance
- **What went wrong**: Only works for injected observations (not all 30K), relies on Claude noticing

**Verdict**: Test this before building anything. If Claude naturally catches conflicts, why build detection infrastructure?

---

### Hypothesis F: Compression Failure Detection

**Concept**: Try to summarize topic clusters. Conflicts surface when LLM says "I can't merge these coherently."

**Tape Play Result**: **INTERESTING BUT OVER-ENGINEERED**

Simulated: Cluster of 5 database observations (3 Postgres, 2 MongoDB). LLM fails to merge, explains the conflict.

- **What went right**: LLM reasoning catches subtle conflicts, provides explanation
- **What went wrong**: Requires clustering first, expensive LLM calls, may flag legitimate hybrid architectures

**Verdict**: Better framing would be "summarize this cluster" not "merge." Conflicts surface naturally in summary attempts.

---

### Hypothesis G: Negation Detection

**Concept**: Detect pattern: old observation says "don't use X" + new observation uses X.

**Tape Play Result**: **NICE SUPPLEMENTARY SIGNAL**

Simulated: "Don't use class components" → "Implemented as class component"

- **What went right**: Very precise signal, low false positives
- **What went wrong**: Only catches explicit negations. Misses "use A" vs "use B" without negation. Parsing negation is harder than it looks (double negation, hedged statements, scoped exceptions).

**Verdict**: Cheap first-pass filter before expensive semantic analysis.

---

### Hypothesis H: Failed Expectations

**Concept**: Track when observations are referenced, actions taken, and negative outcomes occur. Increment "failure score."

**Tape Play Result**: **HIGH COMPLEXITY, DEFER**

Simulated: Claude reads stale API endpoint observation, gets 404, system tracks the failure.

- **What went right**: Uses actual failure signal (ground truth), self-correcting
- **What went wrong**: Only catches observations that cause immediate failures. Attribution is hard. Needs to instrument entire tool-use pipeline.

**Verdict**: Long-term research project, not near-term feature.

---

## Tiered Recommendation (Post Tape Play)

### Tier 1: Do First (low cost, high confidence)

| Approach | Why |
|----------|-----|
| **LLM-Native Prompting** | Zero infrastructure. Just tell Claude to notice conflicts. |
| **Search Facet** | Enhance mem-search to cluster by time, flag temporal spread. |

### Tier 2: Build After Tier 1 Validated

| Approach | Why |
|----------|-----|
| **Temporal Decay Surfacing** | Proactive, but needs threshold tuning. |
| **Entity-Based Detection** | Supplementary signal for file-specific conflicts. |

### Tier 3: Use as Supplements

| Approach | Why |
|----------|-----|
| **Negation Detection** | Cheap first-pass before semantic analysis. |
| **Compression Failure** | Useful framing for cluster summarization. |

### Tier 4: Skip or Defer

| Approach | Why |
|----------|-----|
| **Decision First-Class** | UX friction kills adoption. |
| **Failed Expectations** | Too complex, unclear attribution. |

---

## The Meta-Insight

**The approaches that work share a property: advisory + in-context.**

Users don't want:
- Blocking workflows
- Separate curation tools
- Manual tagging requirements

Users want:
- Conflicts surfaced in the flow of normal work
- Easy resolution path
- System that learns from their responses

The winning strategy: **piggyback on existing touchpoints** (SessionStart, mem-search, natural conversation) rather than building new workflows.

---

## Files to Investigate for Phase 1

```
src/services/sqlite/SessionStore.ts  - Add batchUpdateObservationStatus()
src/services/sqlite/types.ts         - Verify ObservationStatus type
src/services/worker/SearchManager.ts - Verify search excludes non-active
src/services/worker/routes/          - Add status update endpoint
src/servers/mcp-server.ts            - Add MCP tool
```
