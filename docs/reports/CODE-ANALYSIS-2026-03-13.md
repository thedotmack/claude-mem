# Claude-Mem: Comprehensive Code Analysis & Optimization Report

**Date**: 2026-03-13
**Scope**: Full codebase — 179 source files, 62 test files, 14 configuration files
**Methodology**: Static analysis, architectural review, security audit, performance profiling

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Critical Bugs & Repairs](#critical-bugs--repairs)
3. [Security Vulnerabilities](#security-vulnerabilities)
4. [Race Conditions & Concurrency](#race-conditions--concurrency)
5. [Performance Optimizations](#performance-optimizations)
6. [Architectural Improvements](#architectural-improvements)
7. [Error Handling & Resilience](#error-handling--resilience)
8. [Search & Retrieval Upgrades](#search--retrieval-upgrades)
9. [Exponential Accelerators](#exponential-accelerators)
10. [Self-Evolving Code Patterns](#self-evolving-code-patterns)
11. [Implementation Priority Matrix](#implementation-priority-matrix)

---

## Executive Summary

| Category | Count | Severity Distribution |
|----------|-------|-----------------------|
| Critical Bugs | 8 | Immediate action required |
| Security Vulnerabilities | 6 | High-risk attack surface |
| Race Conditions | 11 | Data integrity at stake |
| Performance Issues | 9 | Measurable latency impact |
| Architectural Concerns | 7 | Long-term maintainability |
| Error Handling Gaps | 12 | Silent failure modes |
| **Total Issues** | **53** | |

**Strongest Areas**: SQLite layer, TypeScript type system usage, hook lifecycle design
**Weakest Areas**: Concurrency safety, Chroma sync consistency, cross-agent interop

---

## Critical Bugs & Repairs

### BUG-001: OpenRouter Agent Loses Multi-Turn Context
**File**: `src/services/worker/OpenRouterAgent.ts:117-118, 188, 230`
**Impact**: Complete context loss across conversation turns

The OpenRouter agent has commented-out lines that should push assistant responses into `conversationHistory`. The Gemini agent does this correctly at lines 162, 233, 283. Without these lines, each OpenRouter turn starts fresh — the agent forgets everything from prior turns.

```typescript
// FIX: Uncomment these three lines
session.conversationHistory.push({ role: 'assistant', content: initResponse.content });   // L117
session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });    // L188
session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content }); // L230
```

### BUG-002: Stale Memory Session ID Never Cleared
**File**: `src/services/worker/SessionManager.ts:110-116`
**Impact**: Infinite retry loop on SDK crash recovery

When the worker restarts, it detects a stale `memorySessionId` and logs a warning — but never clears it from the database. If the SDK crashes before capturing a new ID, the next restart sees the same stale ID and tries to resume, getting "No conversation found" errors repeatedly.

```typescript
// FIX: Clear the stale ID
if (existing?.memorySessionId) {
  logger.warn(`Clearing stale memorySessionId from previous worker`);
  this.dbManager.clearMemorySessionId(sessionDbId);  // NEW: actually clear it
}
```

### BUG-003: ChromaSearch Metadata Deduplication Breaks Index Alignment
**File**: `src/services/worker/search/strategies/ChromaSearchStrategy.ts:204-217`
**Impact**: Wrong observations returned for search queries

When multiple Chroma documents map to the same SQLite ID (e.g., observation narrative + facts), only the first metadata entry is kept. Later code at line 740 accesses `rawMetadatas[i]` assuming 1:1 alignment with results — but deduplication broke that alignment.

```typescript
// FIX: Use metadata map instead of raw array indexing
const metadataMap = new Map<number, ChromaMetadata>();
for (const meta of rawMetadatas) {
  if (!metadataMap.has(meta.sqlite_id)) {
    metadataMap.set(meta.sqlite_id, meta);
  }
}
// Then look up by ID, not by array index
```

### BUG-004: SearchOrchestrator Mutates Caller's Parameters
**File**: `src/services/worker/search/SearchOrchestrator.ts:243-255`
**Impact**: Side effects corrupt upstream state

`normalizeSearchParams()` mutates the input object via `delete normalized.obs_type`. This modifies the caller's original object, causing unpredictable behavior if the same params are reused.

```typescript
// FIX: Clone before mutation
const normalized = { ...params };  // shallow clone
delete normalized.obs_type;
return normalized;
```

### BUG-005: DataRoutes Unsafe JSON Parse with Split Fallback
**File**: `src/services/worker/http/routes/DataRoutes.ts:117-122`
**Impact**: Silent data corruption on malformed input

Parsing string-encoded arrays with fallback to `split()` silently produces wrong results. `"[1,2,3"` becomes `["[1,2,3"]` instead of failing.

### BUG-006: GeminiAgent Role Mapping Drops System Messages
**File**: `src/services/worker/GeminiAgent.ts:349-354`
**Impact**: System prompts silently treated as user messages

Role mapping only handles `'assistant' -> 'model'` and falls through to `'user'` for everything else, including `'system'` role messages.

### BUG-007: ContextBuilder Resource Leak on Init Failure
**File**: `src/services/context/ContextBuilder.ts:138-169`
**Impact**: Database handles leaked when native modules fail

If database initialization fails at line 138, the function returns early without closing `db`. The `finally` block's `db.close()` only runs in the happy path.

### BUG-008: SessionQueueProcessor Idle Timeout Never Fires
**File**: `src/services/queue/SessionQueueProcessor.ts:54-64`
**Impact**: Zombie sessions accumulate indefinitely

`idleDuration` resets on every spurious wakeup (message event with no actual messages). If the event fires frequently but the DB queue is empty, the idle timer never accumulates to threshold.

---

## Security Vulnerabilities

### SEC-001: Command Injection via Process Spawning (CWE-78)
**File**: `src/services/infrastructure/ProcessManager.ts:622-696`
**Severity**: HIGH

`spawnDaemon()` uses `scriptPath` in PowerShell commands with only single-quote escaping. A crafted path like `'; Remove-Item C:\ -Recurse'` could execute arbitrary commands.

**Fix**: Use `Path.resolve()` to validate path stays within expected directory. Validate against allowlist of expected script names.

### SEC-002: Path Traversal in Search Context Preview
**File**: `src/services/worker/http/routes/SearchRoutes.ts:180`
**Severity**: MEDIUM

Project name from query params is used unsanitized in path construction. Input `/preview/../../../etc/passwd` could leak filesystem contents.

**Fix**: Sanitize project name to alphanumeric + dashes only.

### SEC-003: Insufficient IP Validation
**File**: `src/services/worker/http/routes/SettingsRoutes.ts:271`
**Severity**: MEDIUM

Regex `/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` accepts `999.999.999.999`. Use `net.isIP()` from Node.js stdlib.

### SEC-004: URL Validation Accepts file:// and data: Protocols
**File**: `src/services/worker/http/routes/SettingsRoutes.ts:350-356`
**Severity**: MEDIUM

`new URL(url)` validates syntax but not protocol. Settings could reference local filesystem via `file://` URLs.

**Fix**: Whitelist `http:` and `https:` protocols explicitly.

### SEC-005: SQL String Interpolation in ChromaSync
**File**: `src/services/sync/ChromaSync.ts:533, 574, 615`
**Severity**: MEDIUM

`AND id NOT IN (${existingObsIds.join(',')})` — while mitigated by `id > 0` checks, this is still a parameterized query violation. Use `WHERE id NOT IN (${ids.map(() => '?').join(',')})` with params.

### SEC-006: Incomplete ReDoS Protection in Tag Stripping
**File**: `src/utils/tag-stripping.ts:39-46`
**Severity**: LOW

Tag count validation only logs a warning but continues processing. A payload with 10,000 nested `<private>` tags still hits the regex engine.

**Fix**: Hard-reject inputs exceeding tag count threshold.

---

## Race Conditions & Concurrency

### RACE-001: FK Constraint Violation Window in SDK Agent
**File**: `src/services/worker/SDKAgent.ts:163-190`

Between memory session ID change and database update, observations can be stored with a mismatched session ID, causing foreign key constraint failures.

### RACE-002: Generator Activity Timeout Leaves Partial State
**File**: `src/services/worker/SessionManager.ts:290-301`

`deleteSession()` races the async generator with a 30s timeout. If the generator is mid-yield when timeout fires, observations are partially written.

### RACE-003: Concurrent SDK Resume Collision
**File**: `src/services/worker/SDKAgent.ts:79-80`

No locking prevents multiple agents from seeing `shouldResume=true` simultaneously. Both submit resume, SDK returns different session IDs, database gets confused.

### RACE-004: ChromaSync Collection Creation Race
**File**: `src/services/sync/ChromaSync.ts:94-111`

`collectionCreated` flag is not atomic. Concurrent promises calling `ensureCollectionExists()` simultaneously trigger duplicate creation attempts.

**Fix**: Use Promise-based singleton pattern:
```typescript
private collectionPromise: Promise<void> | null = null;

async ensureCollectionExists(): Promise<void> {
  if (!this.collectionPromise) {
    this.collectionPromise = this._createCollection();
  }
  return this.collectionPromise;
}
```

### RACE-005: EnvManager Concurrent File Write
**File**: `src/shared/EnvManager.ts:139-169`

Read-modify-write on `.env` file without file locking. Two concurrent calls lose one write.

### RACE-006: SSE Broadcast Loop Failure Cascade
**File**: `src/services/worker/SSEBroadcaster.ts:56-59`

If `client.write()` throws for one client, the entire broadcast loop fails and remaining clients miss the event.

**Fix**: Wrap each write in try-catch, remove failed clients.

### RACE-007: Spawn Guard Flag Not Cleaned on Sync Throw
**File**: `src/services/worker/http/routes/SessionRoutes.ts:100-102`

`spawnInProgress` flag sticks forever if `startGeneratorWithProvider` throws synchronously before setting `generatorPromise`.

### RACE-008-011: Additional session tracking, PID file, orphan cleanup, and map synchronization races documented in SessionManager.ts and ProcessManager.ts.

---

## Performance Optimizations

### PERF-001: O(n^2) Context Truncation in OpenRouter
**File**: `src/services/worker/OpenRouterAgent.ts:302-335`

`unshift()` inside a reverse loop creates O(n^2) behavior. Build the array in reverse and concat once:
```typescript
const kept = history.slice(-(maxMessages));
```

### PERF-002: O(n^2) Hybrid Search Intersection
**File**: `src/services/worker/search/strategies/HybridSearchStrategy.ts:263`

`rankedIds.includes(chromaId)` is O(n) inside a loop over chromaResults. Use a `Set<string>` for O(1) lookups.

### PERF-003: Global Rate Limiter Blocks All Agents
**File**: `src/services/worker/GeminiAgent.ts:57-82`

Module-level `lastRequestTime` means one agent's rate limit blocks all concurrent agents. Use per-session or per-model tracking.

### PERF-004: Dynamic require() Inside Request Handlers
**File**: `src/services/worker/http/routes/DataRoutes.ts:391-392, 445, 464`

`require('../../../sqlite/PendingMessageStore.js')` called on every request. Move to module-level import.

### PERF-005: Unbounded GROUP BY Query
**File**: `src/services/worker/http/routes/DataRoutes.ts:261-267`

`SELECT DISTINCT project FROM observations GROUP BY project` returns unlimited rows. Add `LIMIT` for pagination.

### PERF-006: 100ms Busy-Wait During Shutdown
**File**: `src/services/infrastructure/ProcessManager.ts:241-265`

`waitForProcessesExit()` polls with 100ms interval across potentially 100+ PIDs. Use event-driven approach or increase interval with backoff.

### PERF-007: Hardcoded Token Cost Estimation
**File**: `src/services/worker/GeminiAgent.ts:166-167`

`Math.floor(tokensUsed * 0.7)` for input and `0.3` for output is wildly inaccurate. Use actual token counts from API response metadata.

### PERF-008: No SQLite Write Timeout
**File**: `src/services/sqlite/SessionStore.ts`

Database writes in the observation hot path block indefinitely if the DB is locked. Add `busy_timeout` pragma:
```sql
PRAGMA busy_timeout = 5000;
```

### PERF-009: FTS5 Availability Silently Degrades
**File**: `src/services/sqlite/SessionSearch.ts:168-176`

FTS5 probe catches all errors without logging. Users get degraded full-text search without any diagnostic indicator.

---

## Architectural Improvements

### ARCH-001: Split ProcessManager Into Focused Services

`ProcessManager.ts` handles 9+ responsibilities: runtime resolution, PID file I/O, signal handling, process enumeration, orphan cleanup, timeout calculation, child enumeration, force kill, and daemon spawning.

**Proposed decomposition**:
- `PidFileManager` — PID file read/write/validation
- `ProcessEnumerator` — Platform-specific process listing
- `OrphanCleaner` — Cleanup of stale processes
- `DaemonSpawner` — Process launching with platform adaptation

### ARCH-002: Unify Agent Response Handling

GeminiAgent and OpenRouterAgent have divergent patterns for conversation history management. Create a shared `AgentBase` class:

```typescript
abstract class AgentBase {
  protected appendToHistory(session: AgentSession, role: string, content: string): void {
    session.conversationHistory.push({ role, content });
  }

  abstract processInit(session: AgentSession): Promise<AgentResponse>;
  abstract processObservations(session: AgentSession): Promise<AgentResponse>;
  abstract processSummary(session: AgentSession): Promise<AgentResponse>;
}
```

### ARCH-003: Database Initialization Guard

Worker-service.ts starts the HTTP server synchronously but initializes the database asynchronously in the background. Routes can execute before `DatabaseManager.initialize()` completes.

**Fix**: Add a readiness gate middleware:
```typescript
app.use((req, res, next) => {
  if (!this.dbManager.isReady()) {
    return res.status(503).json({ error: 'Service initializing', retry_after: 1 });
  }
  next();
});
```

### ARCH-004: ChromaSync Transactional Consistency

Batch failures in ChromaSync leave Chroma and SQLite in inconsistent state (some documents synced, others not). Implement a sync log table:

```sql
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY,
  entity_type TEXT,     -- 'observation' | 'summary'
  entity_id INTEGER,
  synced_at TEXT,
  status TEXT           -- 'pending' | 'synced' | 'failed'
);
```

### ARCH-005: Settings Schema-Driven Validation

`SettingsRoutes.ts:87-125` has 40+ hardcoded setting keys. Replace with a schema definition:

```typescript
const SETTINGS_SCHEMA = {
  contextTokenBudget: { type: 'number', min: 100, max: 50000, default: 8000 },
  chromaEnabled: { type: 'boolean', default: true },
  // ... auto-validates, auto-documents
} as const;
```

### ARCH-006: Middleware Pattern for Response Logging

`middleware.ts:63-68` monkey-patches `res.send` to log responses. Replace with proper Express middleware using `on-finished` event:

```typescript
import onFinished from 'on-finished';
app.use((req, res, next) => {
  onFinished(res, (err, res) => { /* log here */ });
  next();
});
```

### ARCH-007: Typed Error Hierarchy

Error handling mixes string matching (`isWorkerUnavailableError` regex patterns) with instanceof checks. Create typed error classes:

```typescript
class WorkerUnavailableError extends Error { readonly code = 'WORKER_UNAVAILABLE'; }
class DatabaseNotInitializedError extends Error { readonly code = 'DB_NOT_INIT'; }
class SessionNotFoundError extends Error { readonly code = 'SESSION_NOT_FOUND'; }
```

---

## Error Handling & Resilience

### ERR-001: Hook Command Error Classification Is Fragile
**File**: `src/cli/hook-command.ts:44-56`

Uses regex string matching against error messages (`/failed:\s*5\d{2}/`) which varies by fetch library. Replace with structured error codes.

### ERR-002: Removed AbortSignal Timeouts (3 locations)
**Files**: `observation.ts:63`, `context.ts:43`, `HealthMonitor.ts:44`

All three removed timeout protection due to "Windows Bun cleanup issue". This leaves fetches that can hang indefinitely.

**Fix**: Implement manual timeout with `Promise.race`:
```typescript
const timeout = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('Timeout')), 5000)
);
const result = await Promise.race([fetch(url), timeout]);
```

### ERR-003: Uncaught readFileSync in DataRoutes
**File**: `src/services/worker/http/routes/DataRoutes.ts:216`

`readFileSync` + `JSON.parse` without try-catch. Missing package.json crashes the handler.

### ERR-004: ResponseProcessor Silent Loop Failure
**File**: `src/services/worker/agents/ResponseProcessor.ts:117-119`

If `confirmProcessed()` throws mid-loop, remaining messages are never confirmed.

### ERR-005: HealthMonitor Returns "unknown" as Valid Version
**File**: `src/services/infrastructure/HealthMonitor.ts:164-174`

`checkVersionMatch()` returns `matches: true` when version is unknown, masking stale binaries.

### ERR-006-012: Additional gaps in JSON validation, session init response parsing, database initialization error propagation, and PowerShell JSON parsing.

---

## Search & Retrieval Upgrades

### SEARCH-001: Implement Reciprocal Rank Fusion (RRF)

Replace the current ad-hoc hybrid merge with RRF scoring for combining SQLite FTS5 and Chroma vector results:

```typescript
function reciprocalRankFusion(
  rankings: Map<string, number>[],
  k: number = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [id, rank] of ranking) {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank));
    }
  }
  return scores;
}
```

### SEARCH-002: Query Expansion with Synonyms

Before hitting FTS5, expand user queries with domain-aware synonyms:
- "error" -> "error OR exception OR failure OR bug"
- "auth" -> "auth OR authentication OR login OR jwt OR oauth"

### SEARCH-003: Tiered Search with Early Exit

Stop searching if the first tier returns high-confidence results:
1. **Exact FTS5 match** — if score > threshold, return immediately
2. **Semantic Chroma search** — if score > threshold, merge and return
3. **Fuzzy SQLite LIKE** — fallback for typos and partial matches

### SEARCH-004: Observation Importance Scoring

Add a `importance_score` column computed from:
- Recency decay (exponential)
- Reference count (how often this observation connects to others)
- User interaction signals (was this context used in a follow-up?)

### SEARCH-005: Pre-computed Embedding Cache

Store computed embeddings alongside observations to avoid re-embedding on every search:

```sql
ALTER TABLE observations ADD COLUMN embedding_hash TEXT;
ALTER TABLE observations ADD COLUMN embedding_model TEXT;
```

---

## Exponential Accelerators

### ACC-001: Predictive Context Pre-loading

Analyze session patterns to pre-load likely-needed context before the user asks:

```typescript
class PredictiveContextEngine {
  // Track which observations are accessed together
  private cooccurrenceMatrix: Map<string, Map<string, number>> = new Map();

  recordAccess(observationIds: string[]): void {
    for (const a of observationIds) {
      for (const b of observationIds) {
        if (a !== b) {
          const row = this.cooccurrenceMatrix.get(a) || new Map();
          row.set(b, (row.get(b) || 0) + 1);
          this.cooccurrenceMatrix.set(a, row);
        }
      }
    }
  }

  predict(currentIds: string[], topK: number = 5): string[] {
    const scores = new Map<string, number>();
    for (const id of currentIds) {
      const related = this.cooccurrenceMatrix.get(id);
      if (related) {
        for (const [relatedId, count] of related) {
          if (!currentIds.includes(relatedId)) {
            scores.set(relatedId, (scores.get(relatedId) || 0) + count);
          }
        }
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id]) => id);
  }
}
```

### ACC-002: Observation Graph with Causal Links

Build a directed graph of observations where edges represent causal or temporal relationships:

```sql
CREATE TABLE observation_edges (
  source_id INTEGER REFERENCES observations(id),
  target_id INTEGER REFERENCES observations(id),
  edge_type TEXT CHECK(edge_type IN ('causes', 'follows', 'contradicts', 'refines')),
  confidence REAL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, edge_type)
);
```

This enables graph traversal queries: "What led to this bug?" or "What was the chain of decisions?"

### ACC-003: Adaptive Token Budget Allocation

Instead of a fixed token budget, dynamically allocate based on task complexity:

```typescript
class AdaptiveTokenAllocator {
  calculateBudget(params: {
    taskComplexity: number;     // 0-1, estimated from prompt analysis
    historyDepth: number;       // how many prior sessions matter
    observationDensity: number; // observations per session
    userPreference: number;     // configured base budget
  }): number {
    const base = params.userPreference;
    const complexityMultiplier = 1 + (params.taskComplexity * 0.5);
    const depthMultiplier = Math.log2(params.historyDepth + 1) / 4;
    const densityPenalty = Math.min(params.observationDensity / 100, 0.3);

    return Math.round(base * complexityMultiplier * (1 + depthMultiplier) * (1 - densityPenalty));
  }
}
```

### ACC-004: Streaming Observation Pipeline

Replace the batch-process-then-store pattern with a streaming pipeline using async generators:

```typescript
async function* observationPipeline(
  rawEvents: AsyncIterable<RawEvent>
): AsyncIterable<ProcessedObservation> {
  const buffer: RawEvent[] = [];

  for await (const event of rawEvents) {
    buffer.push(event);

    // Flush when buffer is full or event is terminal
    if (buffer.length >= 10 || event.type === 'session_end') {
      const batch = buffer.splice(0);
      const processed = await compressBatch(batch);
      for (const obs of processed) {
        yield obs;  // Downstream can store immediately
      }
    }
  }
}
```

### ACC-005: Self-Optimizing Query Planner

Track query performance and automatically choose the best search strategy:

```typescript
class QueryPlanner {
  private strategyStats: Map<string, { totalMs: number; count: number; hits: number }> = new Map();

  async execute(query: SearchQuery): Promise<SearchResult[]> {
    const candidates = this.rankStrategies(query);

    for (const strategy of candidates) {
      const start = performance.now();
      const results = await strategy.search(query);
      const elapsed = performance.now() - start;

      this.recordPerformance(strategy.name, elapsed, results.length);

      if (results.length > 0) return results;
    }

    return [];
  }

  private rankStrategies(query: SearchQuery): SearchStrategy[] {
    // Rank by historical hit rate / latency ratio
    return this.getStrategies()
      .sort((a, b) => this.score(b.name) - this.score(a.name));
  }

  private score(name: string): number {
    const stats = this.strategyStats.get(name);
    if (!stats || stats.count === 0) return 0.5; // neutral for unknown
    const hitRate = stats.hits / stats.count;
    const avgMs = stats.totalMs / stats.count;
    return hitRate / (avgMs / 1000 + 1); // hits per second-equivalent
  }
}
```

---

## Self-Evolving Code Patterns

### SELF-001: Runtime Performance Telemetry with Auto-Tuning

Instrument critical paths and auto-adjust configuration based on measured performance:

```typescript
class PerformanceTelemetry {
  private metrics: Map<string, { p50: number; p95: number; p99: number; samples: number[] }> = new Map();

  track(operation: string, durationMs: number): void {
    const entry = this.metrics.get(operation) || { p50: 0, p95: 0, p99: 0, samples: [] };
    entry.samples.push(durationMs);

    // Keep rolling window of 1000 samples
    if (entry.samples.length > 1000) entry.samples.shift();

    const sorted = [...entry.samples].sort((a, b) => a - b);
    entry.p50 = sorted[Math.floor(sorted.length * 0.5)];
    entry.p95 = sorted[Math.floor(sorted.length * 0.95)];
    entry.p99 = sorted[Math.floor(sorted.length * 0.99)];

    this.metrics.set(operation, entry);
  }

  getRecommendations(): ConfigRecommendation[] {
    const recommendations: ConfigRecommendation[] = [];

    for (const [op, stats] of this.metrics) {
      // Auto-suggest batch size increases if p95 is low
      if (op === 'chroma_sync' && stats.p95 < 100) {
        recommendations.push({
          setting: 'chromaSyncBatchSize',
          currentValue: 50,
          suggestedValue: 100,
          reason: `Chroma sync p95=${stats.p95}ms — headroom for larger batches`
        });
      }

      // Auto-suggest context budget reduction if generation is slow
      if (op === 'context_generation' && stats.p95 > 2000) {
        recommendations.push({
          setting: 'contextTokenBudget',
          currentValue: 8000,
          suggestedValue: 5000,
          reason: `Context generation p95=${stats.p95}ms — reduce budget to improve latency`
        });
      }
    }

    return recommendations;
  }
}

interface ConfigRecommendation {
  setting: string;
  currentValue: number;
  suggestedValue: number;
  reason: string;
}
```

### SELF-002: Schema Evolution Engine

Auto-detect when new observation patterns emerge and adapt the schema:

```typescript
class SchemaEvolutionEngine {
  private patternTracker: Map<string, number> = new Map();

  trackObservation(obs: Record<string, unknown>): void {
    const signature = Object.keys(obs).sort().join(',');
    this.patternTracker.set(signature, (this.patternTracker.get(signature) || 0) + 1);
  }

  suggestMigrations(): SchemaMigration[] {
    const migrations: SchemaMigration[] = [];

    for (const [signature, count] of this.patternTracker) {
      if (count > 100) {
        const fields = signature.split(',');
        for (const field of fields) {
          if (!this.isKnownColumn(field)) {
            migrations.push({
              type: 'add_column',
              table: 'observations',
              column: field,
              sqlType: this.inferType(field),
              reason: `Field "${field}" appeared in ${count} observations — promoting to column for indexed queries`
            });
          }
        }
      }
    }

    return migrations;
  }

  private inferType(field: string): string {
    if (field.endsWith('_at') || field.endsWith('_time')) return 'TEXT'; // ISO timestamps
    if (field.endsWith('_count') || field.endsWith('_id')) return 'INTEGER';
    if (field.endsWith('_score') || field.endsWith('_rate')) return 'REAL';
    return 'TEXT';
  }

  private isKnownColumn(name: string): boolean {
    const known = ['id', 'session_id', 'title', 'facts', 'obs_type', 'tool_name', 'created_at'];
    return known.includes(name);
  }
}

interface SchemaMigration {
  type: 'add_column' | 'add_index' | 'create_table';
  table: string;
  column: string;
  sqlType: string;
  reason: string;
}
```

### SELF-003: Intelligent Cache with Decay

Implement a cache layer that learns access patterns and pre-warms hot data:

```typescript
class IntelligentCache<T> {
  private cache: Map<string, { value: T; lastAccess: number; accessCount: number; ttl: number }> = new Map();
  private readonly maxSize: number;
  private readonly baseTtl: number;

  constructor(maxSize: number = 1000, baseTtlMs: number = 300_000) {
    this.maxSize = maxSize;
    this.baseTtl = baseTtlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.lastAccess > entry.ttl) {
      this.cache.delete(key);
      return undefined;
    }

    // Reward frequent access with longer TTL (adaptive caching)
    entry.accessCount++;
    entry.lastAccess = Date.now();
    entry.ttl = Math.min(this.baseTtl * Math.log2(entry.accessCount + 1), this.baseTtl * 10);

    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) {
      this.evictLeastValuable();
    }

    this.cache.set(key, {
      value,
      lastAccess: Date.now(),
      accessCount: 1,
      ttl: this.baseTtl
    });
  }

  private evictLeastValuable(): void {
    let leastKey: string | null = null;
    let leastScore = Infinity;

    const now = Date.now();
    for (const [key, entry] of this.cache) {
      // Score = access frequency * recency
      const recency = 1 / (now - entry.lastAccess + 1);
      const frequency = entry.accessCount;
      const score = frequency * recency;

      if (score < leastScore) {
        leastScore = score;
        leastKey = key;
      }
    }

    if (leastKey) this.cache.delete(leastKey);
  }
}
```

### SELF-004: Observation Quality Scorer

Automatically score observation quality and flag low-value entries for pruning:

```typescript
class ObservationQualityScorer {
  score(obs: Observation): QualityScore {
    let score = 0;
    const reasons: string[] = [];

    // Content richness
    const factCount = obs.facts?.length || 0;
    if (factCount >= 3) { score += 30; reasons.push('rich facts'); }
    else if (factCount >= 1) { score += 15; reasons.push('some facts'); }
    else { reasons.push('no facts'); }

    // Title specificity (penalize generic titles)
    const genericPatterns = /^(update|change|fix|work on|modify)/i;
    if (obs.title && !genericPatterns.test(obs.title)) {
      score += 20;
      reasons.push('specific title');
    }

    // Temporal context
    if (obs.created_at_epoch) { score += 10; reasons.push('timestamped'); }

    // Cross-reference potential (mentions files, functions, etc.)
    const codeRefs = (JSON.stringify(obs.facts) || '').match(/\b\w+\.(ts|js|py|rs|go)\b/g);
    if (codeRefs && codeRefs.length > 0) {
      score += 20;
      reasons.push(`${codeRefs.length} code refs`);
    }

    // Uniqueness (penalize near-duplicates)
    if (this.isNearDuplicate(obs)) {
      score -= 30;
      reasons.push('near-duplicate');
    }

    return { score: Math.max(0, Math.min(100, score)), reasons };
  }

  private isNearDuplicate(obs: Observation): boolean {
    // Implement via embedding similarity or title+facts hash
    return false;
  }
}

interface QualityScore {
  score: number;    // 0-100
  reasons: string[];
}
```

### SELF-005: Circuit Breaker for External Services

Prevent cascading failures when Chroma or external APIs are down:

```typescript
class CircuitBreaker {
  private failures: number = 0;
  private lastFailure: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeMs: number = 30_000
  ) {}

  async execute<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = 'half-open';
      } else {
        return fallback();
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      return fallback();
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}

// Usage:
const chromaBreaker = new CircuitBreaker(3, 60_000);
const results = await chromaBreaker.execute(
  () => chromaSearch(query),
  () => sqliteOnlySearch(query)  // graceful fallback
);
```

---

## Implementation Priority Matrix

| Priority | Item | Impact | Effort | Category |
|----------|------|--------|--------|----------|
| **P0** | BUG-001: OpenRouter context loss | Critical | 5 min | Bug fix |
| **P0** | BUG-002: Stale session ID clear | Critical | 15 min | Bug fix |
| **P0** | SEC-001: Command injection | High | 1 hr | Security |
| **P0** | RACE-004: ChromaSync creation race | High | 30 min | Concurrency |
| **P1** | BUG-003: Chroma metadata alignment | High | 2 hr | Bug fix |
| **P1** | BUG-004: Param mutation | Medium | 10 min | Bug fix |
| **P1** | SEC-002: Path traversal | Medium | 30 min | Security |
| **P1** | PERF-001: O(n^2) truncation | Medium | 30 min | Performance |
| **P1** | PERF-002: O(n^2) intersection | Medium | 15 min | Performance |
| **P1** | ERR-002: Timeout restoration | Medium | 1 hr | Resilience |
| **P1** | ARCH-003: DB readiness gate | High | 1 hr | Architecture |
| **P2** | PERF-003: Global rate limiter | Medium | 1 hr | Performance |
| **P2** | ARCH-001: Split ProcessManager | Medium | 4 hr | Architecture |
| **P2** | ARCH-002: Agent base class | Medium | 3 hr | Architecture |
| **P2** | SEARCH-001: RRF scoring | High | 3 hr | Search |
| **P2** | ACC-005: Self-optimizing planner | High | 4 hr | Accelerator |
| **P2** | SELF-005: Circuit breaker | High | 2 hr | Resilience |
| **P3** | ACC-001: Predictive pre-loading | Very High | 8 hr | Accelerator |
| **P3** | ACC-002: Observation graph | Very High | 12 hr | Accelerator |
| **P3** | ACC-003: Adaptive token budget | High | 4 hr | Accelerator |
| **P3** | SELF-001: Auto-tuning telemetry | High | 6 hr | Self-evolving |
| **P3** | SELF-002: Schema evolution | Medium | 8 hr | Self-evolving |
| **P3** | SELF-003: Intelligent cache | High | 4 hr | Self-evolving |
| **P3** | SELF-004: Quality scorer | Medium | 3 hr | Self-evolving |

---

## Closing Assessment

Claude-mem has a solid architectural foundation — the 5-hook lifecycle, the SQLite + Chroma dual-storage pattern, and the SDK agent abstraction are well-conceived. The codebase is at a critical inflection point where fixing the P0 items (especially the OpenRouter context loss and concurrency bugs) and implementing the accelerators (predictive pre-loading, observation graphs, self-optimizing queries) would compound into an order-of-magnitude improvement in both reliability and intelligence.

The self-evolving patterns (SELF-001 through SELF-005) transform claude-mem from a static memory system into one that continuously improves its own performance characteristics based on real usage data — the closest thing to "code that writes itself" that's architecturally sound.
