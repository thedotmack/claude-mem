# Implementation Plan: ROI Metrics & Discovery Cost Tracking

**Feature**: Display token discovery costs alongside observations to demonstrate knowledge reuse ROI
**Branch**: `enhancement/roi`
**Issue**: #104
**Priority**: HIGH (needed for YC application amendment)

---

## Executive Summary

Capture token usage from Agent SDK, store as "discovery cost" with each observation, and display metrics in SessionStart context to prove that claude-mem reduces token consumption by 50-75% through knowledge reuse.

### The Value Proposition

**Session 1**: Claude spends 4,000 tokens discovering "how Stop hooks work"
**Sessions 2-5**: Claude reads 163-token observation instead of re-discovering
**Savings**: 15,348 tokens (77% reduction) over 5 sessions

This feature makes that ROI **visible and measurable** for both users and Claude.

---

## Architecture Overview

```
Agent SDK Messages (with usage)
    ↓
SDKAgent captures usage data
    ↓
ActiveSession tracks cumulative tokens
    ↓
Observations stored with discovery_tokens
    ↓
Context hook displays metrics
    ↓
User/Claude sees ROI
```

---

## Implementation Steps

### Phase 1: Capture Token Usage from Agent SDK

**File**: `src/services/worker/SDKAgent.ts`

**Changes**:
1. Extract usage data from assistant messages (lines 64-86)
2. Track cumulative session tokens in ActiveSession
3. Pass cumulative tokens when storing observations

**Code Changes**:

```typescript
// Line ~70: After extracting textContent, add:
const usage = message.message.usage;
if (usage) {
  session.cumulativeInputTokens += usage.input_tokens || 0;
  session.cumulativeOutputTokens += usage.output_tokens || 0;

  // Cache creation counts as discovery, cache read doesn't
  if (usage.cache_creation_input_tokens) {
    session.cumulativeInputTokens += usage.cache_creation_input_tokens;
  }

  logger.debug('SDK', 'Token usage captured', {
    sessionId: session.sessionDbId,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cumulativeInput: session.cumulativeInputTokens,
    cumulativeOutput: session.cumulativeOutputTokens
  });
}
```

```typescript
// Line ~213-218: Pass discovery tokens when storing
const { id: obsId, createdAtEpoch } = this.dbManager.getSessionStore().storeObservation(
  session.claudeSessionId,
  session.project,
  obs,
  session.lastPromptNumber,
  session.cumulativeInputTokens + session.cumulativeOutputTokens  // Add discovery cost
);
```

**Edge Cases**:
- Handle missing usage data (default to 0)
- Cache tokens: `cache_creation_input_tokens` counts as discovery, `cache_read_input_tokens` doesn't
- Multiple observations per response: Each gets snapshot of cumulative tokens at creation time

---

### Phase 2: Update ActiveSession Type

**File**: `src/services/worker-types.ts`

**Changes**: Add token tracking fields to ActiveSession interface

```typescript
export interface ActiveSession {
  sessionDbId: number;
  sdkSessionId: string | null;
  claudeSessionId: string;
  project: string;
  userPrompt: string;
  lastPromptNumber: number;
  pendingMessages: PendingMessage[];
  abortController: AbortController;
  startTime: number;
  cumulativeInputTokens: number;   // NEW: Track input tokens
  cumulativeOutputTokens: number;  // NEW: Track output tokens
}
```

**Initialization**: When creating new session in SessionManager.initializeSession, set:
```typescript
cumulativeInputTokens: 0,
cumulativeOutputTokens: 0
```

---

### Phase 3: Database Schema Migration

**File**: `src/services/sqlite/migrations.ts`

**Add Migration**: Create migration #8 (next available number)

```typescript
{
  version: 8,
  name: 'add_discovery_tokens',
  up: (db: Database) => {
    // Add discovery_tokens to observations
    db.exec(`
      ALTER TABLE observations
      ADD COLUMN discovery_tokens INTEGER DEFAULT 0;
    `);

    // Add discovery_tokens to summaries
    db.exec(`
      ALTER TABLE summaries
      ADD COLUMN discovery_tokens INTEGER DEFAULT 0;
    `);

    logger.info('DB', 'Migration 8: Added discovery_tokens columns');
  }
}
```

**Why summaries too?**: Summaries represent accumulated session work, so they should also show total discovery cost.

---

### Phase 4: Update SessionStore

**File**: `src/services/sqlite/SessionStore.ts`

**Changes**:

1. Update `storeObservation` signature (around line ~1000):
```typescript
storeObservation(
  sessionId: string,
  project: string,
  observation: ParsedObservation,
  promptNumber: number,
  discoveryTokens: number = 0  // NEW parameter
): { id: number; createdAtEpoch: number }
```

2. Update INSERT statement to include discovery_tokens:
```typescript
const stmt = this.db.prepare(`
  INSERT INTO observations (
    session_id,
    project,
    type,
    title,
    subtitle,
    narrative,
    facts,
    concepts,
    files_read,
    files_modified,
    prompt_number,
    discovery_tokens,  -- NEW
    created_at_epoch
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const result = stmt.run(
  sessionId,
  project,
  observation.type,
  observation.title,
  observation.subtitle || '',
  observation.narrative || '',
  JSON.stringify(observation.facts || []),
  JSON.stringify(observation.concepts || []),
  JSON.stringify(observation.files || []),
  JSON.stringify([]),
  promptNumber,
  discoveryTokens,  // NEW
  createdAtEpoch
);
```

3. Update `storeSummary` similarly (around line ~1150):
```typescript
storeSummary(
  sessionId: string,
  project: string,
  summary: ParsedSummary,
  promptNumber: number,
  discoveryTokens: number = 0  // NEW parameter
): { id: number; createdAtEpoch: number }
```

---

### Phase 5: Update Database Types

**File**: `src/services/sqlite/types.ts`

**Changes**: Add discovery_tokens to DBObservation and DBSummary interfaces

```typescript
export interface DBObservation {
  id: number;
  session_id: string;
  project: string;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title: string;
  subtitle: string;
  narrative: string | null;
  facts: string; // JSON array
  concepts: string; // JSON array
  files_read: string; // JSON array
  files_modified: string; // JSON array
  prompt_number: number;
  discovery_tokens: number;  // NEW
  created_at_epoch: number;
}

export interface DBSummary {
  id: number;
  session_id: string;
  request: string;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  project: string;
  prompt_number: number;
  discovery_tokens: number;  // NEW
  created_at_epoch: number;
}
```

---

### Phase 6: Update Search Queries

**File**: `src/services/sqlite/SessionSearch.ts`

**Changes**: Ensure all SELECT queries include discovery_tokens

Example (around line ~50, searchObservations):
```typescript
SELECT
  o.id,
  o.session_id,
  o.project,
  o.type,
  o.title,
  o.subtitle,
  o.narrative,
  o.facts,
  o.concepts,
  o.files_read,
  o.files_modified,
  o.prompt_number,
  o.discovery_tokens,  -- NEW
  o.created_at_epoch,
  ...
```

**Affected methods**:
- `searchObservations`
- `getRecentObservations`
- `getObservationsByType`
- `getObservationsByConcept`
- `getObservationsByFile`
- All other observation query methods

---

### Phase 7: Update Context Hook Display

**File**: `src/hooks/context-hook.ts`

**Changes**: Display discovery costs and ROI metrics in SessionStart context

**Section 1: Add Aggregate Metrics** (insert after line ~250, before observation table)

```typescript
// Calculate aggregate metrics
const totalObservations = observations.length;
const totalReadTokens = observations.reduce((sum, obs) => {
  // Estimate read tokens from observation size
  const obsSize = (obs.title?.length || 0) +
                  (obs.subtitle?.length || 0) +
                  (obs.narrative?.length || 0) +
                  JSON.stringify(obs.facts || []).length;
  return sum + Math.ceil(obsSize / 4); // Rough token estimate
}, 0);
const totalDiscoveryTokens = observations.reduce((sum, obs) => sum + (obs.discovery_tokens || 0), 0);
const savings = totalDiscoveryTokens - totalReadTokens;
const savingsPercent = totalDiscoveryTokens > 0
  ? Math.round((savings / totalDiscoveryTokens) * 100)
  : 0;

output += `\n📊 **Context Economics**:\n`;
output += `  - Loading: ${totalObservations} observations (${totalReadTokens.toLocaleString()} tokens to read)\n`;
output += `  - Discovery investment: ${totalDiscoveryTokens.toLocaleString()} tokens spent by previous sessions\n`;
output += `  - Your savings: ${savings.toLocaleString()} tokens (${savingsPercent}% reduction from reuse)\n\n`;
```

**Section 2: Update Table Format** (around line ~280)

```typescript
output += `| ID | Time | T | Title | Read | Discovery |\n`;
output += `|----|------|---|-------|------|-----------||\n`;

for (const obs of observations) {
  const time = formatTime(obs.created_at_epoch);
  const emoji = getTypeEmoji(obs.type);
  const title = truncate(obs.title, 50);

  // Estimate read tokens (observation size in tokens)
  const obsSize = (obs.title?.length || 0) +
                  (obs.subtitle?.length || 0) +
                  (obs.narrative?.length || 0) +
                  JSON.stringify(obs.facts || []).length;
  const readTokens = Math.ceil(obsSize / 4);

  const discoveryTokens = obs.discovery_tokens || 0;
  const discoveryDisplay = discoveryTokens > 0
    ? `🔍 ${discoveryTokens.toLocaleString()}`
    : '-';

  output += `| #${obs.id} | ${time} | ${emoji} | ${title} | ~${readTokens} | ${discoveryDisplay} |\n`;
}
```

**Section 3: Add Footer Explanation** (after table)

```typescript
output += `\n💡 **Column Key**:\n`;
output += `  - **Read**: Tokens to read this observation (cost to learn it now)\n`;
output += `  - **Discovery**: Tokens Previous Claude spent exploring/researching this topic\n`;
output += `\n**ROI**: Reading these learnings instead of re-discovering saves ${savingsPercent}% tokens\n`;
```

**Edge Case**: Handle old observations without discovery_tokens (show '-' or 0)

---

### Phase 8: Update Chroma Sync (Optional)

**File**: `src/services/sync/ChromaSync.ts`

**Changes**: Include discovery_tokens in vector metadata

```typescript
// Around line ~100, syncObservation metadata
metadata: {
  session_id: sessionId,
  project: project,
  type: observation.type,
  title: observation.title,
  prompt_number: promptNumber,
  discovery_tokens: discoveryTokens,  // NEW
  created_at_epoch: createdAtEpoch,
  ...
}
```

**Why?**: Enables semantic search to factor in discovery cost for relevance scoring (future enhancement)

---

## Testing Plan

### Unit Tests

1. **Token Capture Test**:
   - Mock Agent SDK response with usage data
   - Verify ActiveSession.cumulativeTokens increments correctly
   - Test cache token handling (creation counts, read doesn't)

2. **Storage Test**:
   - Create observation with discovery_tokens
   - Verify database stores correctly
   - Query back and verify field present

3. **Display Test**:
   - Create test observations with varying discovery costs
   - Run context-hook
   - Verify metrics calculate correctly
   - Verify table displays both Read and Discovery columns

### Integration Tests

1. **Full Session Flow**:
   - Start new session
   - Trigger multiple tool executions
   - Generate observations
   - Verify cumulative tokens accumulate
   - Check context displays metrics

2. **Migration Test**:
   - Backup existing database
   - Run migration #8
   - Verify columns added
   - Verify existing data intact (discovery_tokens = 0)
   - Test new observations store correctly

### Manual Testing

1. **Real Usage Scenario**:
   - Start fresh Claude Code session
   - Perform research task (read files, search codebase)
   - Generate observations via claude-mem
   - Check database for discovery_tokens values
   - Start new session, verify context shows metrics

2. **YC Demo Data**:
   - Run 5 sessions on same topic
   - Collect token data for each session
   - Calculate actual ROI (Session 1 cost vs Sessions 2-5)
   - Screenshot metrics for YC application

---

## Rollout Plan

### Phase 1: Data Collection (Week 1)
- Deploy migration and token capture
- Run without displaying metrics yet
- Verify data quality and accuracy
- Fix any issues with token tracking

### Phase 2: Display Metrics (Week 2)
- Enable context hook display
- Gather user feedback
- Iterate on presentation format
- Document any edge cases

### Phase 3: YC Application (Week 2-3)
- Collect empirical data from real usage
- Generate charts/graphs showing ROI
- Write case study with actual numbers
- Amend YC application with proof

### Phase 4: Public Launch (Week 4)
- Blog post explaining the feature
- Update README with ROI metrics
- Submit to HN/Reddit with data
- Reach out to Anthropic with findings

---

## Success Metrics

**Technical Success**:
- ✅ Token capture accuracy: >95% of SDK responses captured
- ✅ Database migration: 0 data loss, all observations migrated
- ✅ Display accuracy: Metrics match raw data within 5%

**Business Success**:
- ✅ Demonstrate 50-75% token reduction across 10+ sessions
- ✅ YC application strengthened with empirical data
- ✅ User/Claude understanding of ROI improves (survey/feedback)

**Strategic Success**:
- ✅ Proof that memory optimization reduces infrastructure needs
- ✅ Data compelling enough for Anthropic partnership discussion
- ✅ Foundation for enterprise licensing ROI calculator

---

## Open Questions

1. **Token Attribution**:
   - Should each observation get cumulative session tokens, or split proportionally?
   - **Decision**: Use cumulative (simpler, shows total cost at that point)

2. **Cache Tokens**:
   - How to handle cache_read_input_tokens in ROI calculation?
   - **Decision**: Don't count cache reads as discovery (they're already discovered)

3. **Display Format**:
   - Show raw token counts or human-readable format (K, M)?
   - **Decision**: Use toLocaleString() for readability (e.g., "4,000" not "4K")

4. **Pricing Display**:
   - Should we show dollar costs too, or just tokens?
   - **Decision**: Tokens only initially. Pricing varies by model/plan, adds complexity

5. **Historical Data**:
   - What to do with old observations without discovery_tokens?
   - **Decision**: Show as 0 or '-', document limitation

---

## Files Modified Summary

**Core Implementation**:
- `src/services/worker/SDKAgent.ts` - Capture usage, pass to storage
- `src/services/worker-types.ts` - Add cumulative token fields
- `src/services/sqlite/migrations.ts` - Migration #8 for discovery_tokens
- `src/services/sqlite/SessionStore.ts` - Store discovery tokens
- `src/services/sqlite/types.ts` - Update interfaces
- `src/services/sqlite/SessionSearch.ts` - Include in queries
- `src/hooks/context-hook.ts` - Display metrics

**Optional**:
- `src/services/sync/ChromaSync.ts` - Include in vector metadata
- `src/services/worker/SessionManager.ts` - Initialize cumulative tokens

**Documentation**:
- `CLAUDE.md` - Update with new feature
- `README.md` - Add ROI metrics section
- Issue #104 - Track implementation progress

---

## Timeline Estimate

**Day 1** (Tomorrow):
- [ ] Create branch ✅
- [ ] Write implementation plan ✅
- [ ] Phase 1: Capture token usage (2 hours)
- [ ] Phase 2: Update types (30 min)
- [ ] Phase 3: Database migration (1 hour)

**Day 2**:
- [ ] Phase 4: Update SessionStore (1 hour)
- [ ] Phase 5: Update types (30 min)
- [ ] Phase 6: Update search queries (1 hour)
- [ ] Testing: Unit tests (2 hours)

**Day 3**:
- [ ] Phase 7: Update context hook display (2 hours)
- [ ] Testing: Integration tests (2 hours)
- [ ] Manual testing and iteration (2 hours)

**Day 4**:
- [ ] Collect real usage data (ongoing throughout day)
- [ ] Generate YC metrics/charts (2 hours)
- [ ] Amend YC application (2 hours)
- [ ] Documentation updates (1 hour)

**Total**: ~20 hours of development over 4 days

---

## Risk Mitigation

**Risk 1**: Agent SDK usage data incomplete or missing
**Mitigation**: Default to 0, log warnings, don't break existing functionality

**Risk 2**: Migration fails on large databases
**Mitigation**: Test on database copy first, add rollback mechanism

**Risk 3**: Token estimates inaccurate
**Mitigation**: Document methodology, provide "rough estimate" disclaimer

**Risk 4**: Display too noisy/overwhelming
**Mitigation**: Make display configurable via settings, start collapsed

**Risk 5**: YC data not compelling enough
**Mitigation**: Run on diverse projects, cherry-pick best examples, be honest about limitations

---

## Next Steps

1. ✅ Create branch `enhancement/roi`
2. ✅ Write implementation plan
3. Start Phase 1: Implement token capture in SDKAgent.ts
4. Run manual test to verify usage data captured
5. Continue through phases sequentially
6. Collect data for YC application by end of week

---

## Notes for Tomorrow

**Start here**: `src/services/worker/SDKAgent.ts` line 64-86
**Key insight**: `message.message.usage` contains the token data
**Don't forget**: Initialize cumulative tokens to 0 in SessionManager
**Test with**: Simple session that reads a few files and creates 1-2 observations

**The goal**: By end of week, have real numbers showing 50-75% token savings to prove the hypothesis and strengthen YC application.

---

*This plan represents ~20 hours of focused development. Prioritize getting Phase 1-7 working correctly over perfection. The YC data is the critical deliverable.*
