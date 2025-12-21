# Supersession System: Status Report

**Date:** December 20, 2025
**Purpose:** Document the half-built observation status/supersession system for decision-making

---

## Executive Summary

In November 2025, we started building a system to mark observations as superseded, deprecated, or meta. The database infrastructure was completed and is still functional, but the API endpoints and skill were removed during subsequent architecture changes. 10 observations remain marked as superseded in production, proving the system worked.

---

## Original Plan (Nov 28, 2025)

Source: `~/.claude/plans/nifty-bouncing-wreath.md`

### Status Values
| Status | Meaning |
|--------|---------|
| `active` | Default, shows in search |
| `meta_observation` | Self-referential (observations about observations) |
| `superseded` | Replaced by newer, links via `superseded_by` |
| `deprecated` | No longer valid/accurate |

### Planned Workflow
1. User provides topic to audit (e.g., "http mcp architecture")
2. Search for all observations on that topic
3. Fetch and analyze each one
4. Present findings: which is ground truth, which are duplicates/outdated
5. User confirms
6. Batch update via API

### Skill Access
- `GET /api/search?query=...` - find observations
- `GET /api/observation/:id` - fetch full details
- `PATCH /api/observations/batch-status` - apply updates

---

## What Was Built

### Database Schema (STILL EXISTS)

```sql
-- observations table has these columns:
status TEXT DEFAULT 'active'
superseded_by INTEGER REFERENCES observations(id)

-- Index exists:
CREATE INDEX idx_observations_status ON observations(status);
```

**Proof it works:**
```
sqlite> SELECT status, COUNT(*) FROM observations GROUP BY status;
active|29805
superseded|10
```

### SessionStore Methods (REMOVED)

From observation #16799:
> `batchUpdateObservationStatus` method was implemented in SessionStore.ts to support atomic batch updates of observation statuses. The method leverages better-sqlite3's transaction() API to wrap all updates in a single atomic transaction.

**Features:**
- Accepts array of updates (observation_id, status, superseded_by)
- Uses transaction wrapper for atomic all-or-nothing execution
- Validates superseded_by requirement when status is 'superseded'
- Returns per-observation success/error details

**Status:** Method no longer exists in current codebase.

### API Endpoints (REMOVED)

From observations #16856, #16857:

Two MCP tool endpoints existed in `src/servers/search-server.ts`:
1. `update_observation_status` - single observation updates
2. `batch_update_observation_status` - up to 100 at once

Both accepted status enum: `active`, `meta_observation`, `deprecated`, `superseded`

**Status:** `search-server.ts` was replaced by `mcp-server.ts` during architecture refactor. Endpoints no longer exist.

### Skill (REMOVED)

Evolution documented in observations #16867-16892:

1. Started as `curate-observations` skill
2. Renamed to `clarity` after discussion about naming principles
3. Positioned as post-search tool: "invoke after mem-search returns conflicting results"
4. Integrated with mem-search workflow as Step 4

**Status:** `plugin/skills/clarity/` directory was deleted. Only `mem-search` and `troubleshoot` skills remain.

---

## What Still Works

1. **Database columns** - `status` and `superseded_by` exist and are indexed
2. **10 test observations** - Already marked superseded with proper linking
3. **Search exclusion** - Search likely still excludes non-active (needs verification)

---

## What Was Lost

1. **SessionStore.batchUpdateObservationStatus()** - Atomic batch update method
2. **API endpoints** - Both single and batch status update endpoints
3. **Clarity skill** - The workflow documentation and invocation triggers
4. **Types** - ObservationStatus enum may be incomplete

---

## Related Feature Request

GitHub Discussion #282 requests conflict detection:

> **Description:** Warn users when new decisions or implementations contradict previously documented decisions.
>
> **Reasoning:** Developers document architectural decisions over time but later work may contradict earlier decisions due to forgotten context or changing requirements. No mechanism currently exists to detect these conflicts.
>
> **Additional Info:**
> - Decision tracking by category (architecture, technology choices, conventions, security)
> - Use existing Chroma embeddings for semantic similarity detection
> - Conflict resolution metadata (supersede, exception, cancel)
> - Configurable sensitivity thresholds

This is a more ambitious version of what we started building.

---

## Architecture Changes Since November

The codebase underwent significant refactoring:
- `search-server.ts` → `mcp-server.ts` (much smaller, HTTP wrapper only)
- Business logic moved to `SearchManager` in worker service
- MCP server now delegates to worker via HTTP
- Skills architecture evolved

The supersession endpoints were casualties of this refactoring.

---

## Decision Points

### Option A: Resurrect Original Plan
Rebuild what was lost:
1. Add `batchUpdateObservationStatus()` back to SessionStore
2. Add status update endpoints to worker's DataRoutes or SearchRoutes
3. Create new skill with updated workflow
4. Expose via MCP server

**Pros:** Simple, known design, proven to work
**Cons:** Manual curation only, doesn't address conflict detection

### Option B: Build Toward Discussion #282
Expand scope to include automatic conflict detection:
1. All of Option A, plus:
2. Semantic similarity detection using Chroma
3. Automatic flagging of potential conflicts
4. Decision categories and metadata

**Pros:** Addresses user-requested feature
**Cons:** More complex, longer timeline

### Option C: Minimal Resurrection
Just add the API endpoints, skip the skill:
1. Add status update to worker API
2. Use mem-search + manual curl/API calls for now

**Pros:** Fastest path to functional
**Cons:** No guided workflow

---

## Key Observations to Reference

| ID | Title | Relevance |
|----|-------|-----------|
| #16799 | Batch observation status update method added to SessionStore | Original implementation details |
| #16848 | Refactor from detection script to curation skill | Why skill approach was chosen |
| #16849 | Exited plan mode with observation curation skill plan | Final plan approval |
| #16868 | Curate-observations skill implementation details | Skill workflow |
| #16890 | Clarity Skill for Resolving Conflicting Observations | Renamed skill details |
| #16892 | Added Clarity Skill Integration to Mem-Search Workflow | Integration with mem-search |

---

## Files to Investigate

Current state verification needed:
- `src/services/sqlite/SessionStore.ts` - Check if any status methods remain
- `src/services/sqlite/types.ts` - Check ObservationStatus type definition
- `src/services/worker/SearchManager.ts` - Check if search excludes non-active
- `src/servers/mcp-server.ts` - Current MCP tools available
