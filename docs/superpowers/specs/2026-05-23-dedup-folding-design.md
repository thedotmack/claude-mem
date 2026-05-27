# S3 — Auto Dedup Folding (Design)

**Date**: 2026-05-23
**Status**: Approved (pending implementation)
**Related**: S2 auto-redaction (2026-05-22-auto-redaction-design.md) — shares opt-in / flat-key config style

## 1. Goal

Collapse redundant tool observations within a short time window **before** they reach the Claude Agent SDK, so 5× `Bash(ls /foo)` in 30 seconds triggers **one** SDK round-trip instead of five.

**Primary motivation**: SDK token cost. Each pending message currently spawns its own `buildObservationPrompt` → separate SDK turn, even when the input is byte-identical to a recent neighbor.

## 2. Non-Goals

- **Cross-session dedup**: Each `session_db_id` is its own fold scope.
- **Output-aware dedup**: We do not hash `tool_response`. Same input + different output (e.g. `Bash("npm test")` flaky) still folds. Mitigation: tool blacklist.
- **Backfill of historical pending_messages**: Migration adds columns with defaults; existing rows get `fold_count=1, fold_key=NULL`. No re-process pass.
- **UI-layer fold**: The existing post-SDK `content_hash` dedup still runs as the second line of defense; viewer behavior unchanged.

## 3. Architecture

### 3.1 Where Fold Happens

Inside `SessionManager.queueObservation`, **before** `PendingMessageStore.enqueue`. Decision tree:

```
incoming observation
  └─> compute fold_key = sha256(canonical({tool_name, tool_input, cwd, agent_id})).slice(0,16)
  └─> if !dedupFoldEnabled OR tool_name in disabledTools:
        proceed to enqueue (no fold)
  └─> SELECT id, created_at_epoch FROM pending_messages
        WHERE session_db_id = ? AND fold_key = ?
              AND created_at_epoch >= (now - windowSeconds * 1000)
        ORDER BY created_at_epoch DESC LIMIT 1
  └─> if hit:
        UPDATE pending_messages SET fold_count = fold_count + 1 WHERE id = ?
        return DUP_FOLDED (do NOT ensureGeneratorRunning)
  └─> else:
        INSERT new row with fold_key set, fold_count = 1
        proceed normally → ensureGeneratorRunning
```

**Important**: fold hit does **not** dispatch to SDK. The folded entry is materialized only when the bumped row finally drains through `getMessageIterator` (which happens on the next non-folded sibling or session checkpoint).

### 3.2 What Reaches the SDK

`buildObservationPrompt` is enriched: when `fold_count > 1`, the prompt gets an extra `<repetition>` element so the SDK observer knows the same call happened N times.

```xml
<observed_from_primary_session>
  <what_happened>Bash</what_happened>
  <occurred_at>2026-05-23T10:11:12.000Z</occurred_at>
  <working_directory>/repo</working_directory>
  <parameters>{ "command": "ls /foo" }</parameters>
  <outcome>...</outcome>
  <repetition>This tool call was repeated 5 times in a 30s window.</repetition> <!-- "30s" reflects the configured CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS at the moment the prompt is built -->
</observed_from_primary_session>
```

The observer decides whether to surface the repetition in `<facts>` — we do not force a specific schema.

### 3.3 What Survives in Existing Defenses

- **Hook-retry dedup** (`UNIQUE(content_session_id, tool_use_id)`) still wins for the case "same hook fired twice". Fold is independent and orthogonal.
- **Post-SDK content_hash dedup** (`UNIQUE(memory_session_id, content_hash)`) still runs after SDK extraction. If two unfolded paths produce identical `title+narrative`, the second `storeObservation` becomes a no-op.

## 4. Fold Key

### 4.1 Algorithm

```ts
function computeFoldKey(obs: PendingObservation): string {
  const canonical = JSON.stringify({
    tool_name: obs.tool_name,
    tool_input: sortObjectKeys(obs.tool_input),  // stable across object reorderings
    cwd: obs.cwd ?? '',
    agent_id: obs.agent_id ?? '',
  });
  return sha256(canonical).slice(0, 16);  // hex prefix, 64 bits — sufficient inside a session scope
}
```

`sortObjectKeys` is a recursive helper that returns a new object with keys sorted alphabetically. Arrays preserve order.

### 4.2 Why Each Field

| Field        | Reason                                                        |
|--------------|---------------------------------------------------------------|
| `tool_name`  | Different tools are never the same operation.                 |
| `tool_input` | The actual arguments — the primary equivalence test.          |
| `cwd`        | `Bash(ls)` in `/a` and `/b` are different operations.         |
| `agent_id`   | Subagent and main agent traces stay separate.                 |

### 4.3 Why NOT These

| Field            | Reason for exclusion                                                              |
|------------------|-----------------------------------------------------------------------------------|
| `tool_output`    | We do not have a SDK-extracted summary yet at fold time; raw response may vary.   |
| `prompt_number`  | Repetitions across user prompts are still redundant within the window.            |
| `created_at`     | Time is the *window* dimension, not part of identity.                             |
| `session_db_id`  | Implicit in the SELECT WHERE clause; not part of the hash.                        |

## 5. Time Window

- **Default**: 30 seconds.
- **Configurable**: `CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS` (integer, validated `>= 1, <= 3600`).
- **Semantics**: Sliding from the first row's `created_at_epoch`. New entries within `[first, first + windowSec]` fold onto it. Past that, the next match opens a new row.
- **Why 30s**: Empirically covers polling/retry loops (`while sleep 5; do; ...`), tight edit-test cycles, and accidental double-clicks. 60s would catch more but risks collapsing genuinely independent calls.
- **Clock source**: `Date.now()` on the worker. We rely on monotonicity within a single worker process; cross-machine drift is not a concern (single-worker architecture).

## 6. Schema Changes

### 6.1 New Columns on `pending_messages`

```sql
ALTER TABLE pending_messages ADD COLUMN fold_key TEXT;
ALTER TABLE pending_messages ADD COLUMN fold_count INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_pending_fold
  ON pending_messages(session_db_id, fold_key, created_at_epoch);
```

### 6.2 Migration

This project uses a TypeScript migration runner at `src/services/sqlite/migrations/runner.ts` keyed by `schema_versions.version`. The highest existing version is 34 — the new migration takes version 35 (or the next free slot at implementation time).

Skeleton (matches the existing pattern):

```ts
const applied = this.db.prepare('SELECT version FROM schema_versions WHERE version = ?').get(35) as SchemaVersion | undefined;
if (!applied) {
  this.db.exec(`
    ALTER TABLE pending_messages ADD COLUMN fold_key TEXT;
    ALTER TABLE pending_messages ADD COLUMN fold_count INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_pending_fold
      ON pending_messages(session_db_id, fold_key, created_at_epoch);
  `);
  this.db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(35, new Date().toISOString());
}
```

- Idempotent (`IF NOT EXISTS` on index, `schema_versions` gate on the ALTERs).
- No data backfill (existing rows are de facto `fold_count=1, fold_key=NULL`).
- `fold_key` is nullable to mark pre-feature rows; new INSERTs always set it.

### 6.3 `Observation` Type (SDK input shape)

`src/sdk/prompts.ts` — extend the `Observation` interface:

```ts
export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
  fold_count?: number;  // NEW — default 1 when omitted
}
```

`buildObservationPrompt` reads `fold_count` from the observation and accepts an optional `opts: { windowSeconds?: number }` parameter for the window. Default 30 matches `DEFAULT_WINDOW_SECONDS`. The Task 8 wire-up (`SessionManager`/Provider call sites) passes `getDedupFoldConfig().windowSeconds`. Emit only when `fold_count > 1`. The `getMessageIterator` SQL projection must include `fold_count` so it reaches the prompt builder.

## 7. Configuration

Sourced from `~/.claude-mem/settings.json` via the existing `SettingsDefaultsManager`. Flat string keys, sibling to the S2 redaction keys:

| Key                                       | Default | Type           | Meaning                                  |
|-------------------------------------------|---------|----------------|------------------------------------------|
| `CLAUDE_MEM_DEDUP_FOLD_ENABLED`           | `false` | boolean string | Opt-in master switch.                    |
| `CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS`    | `30`    | integer string | Sliding window size.                     |
| `CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS`    | ``      | CSV string     | Tool names to never fold (e.g. `Bash`).  |

Parsing: same parser style as S2 `loadRedactionConfig`. Invalid integer → fallback to default with a `logger.warn('DEDUP', ...)`. Empty CSV → empty array.

## 8. Caching

`getDedupFoldConfig()` reuses the 5-second TTL cache pattern from S2 (`getRedactionConfig()`):

```ts
let cached: { config: DedupFoldConfig; expiresAt: number } | null = null;

export function getDedupFoldConfig(): DedupFoldConfig {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.config;
  const config = loadDedupFoldConfig(SettingsDefaultsManager.loadAll());
  cached = { config, expiresAt: now + 5_000 };
  return config;
}

export function _resetDedupFoldConfigCache(): void { cached = null; }
```

`_resetDedupFoldConfigCache` is exported for tests only.

## 9. Logger Component

Add `'DEDUP'` to the `Component` union in `src/utils/logger.ts`. Place it in alphabetic order against whatever the current union contains at implementation time.

## 10. Public Module Surface

`src/services/worker/dedup-fold.ts`:

```ts
export interface DedupFoldConfig {
  enabled: boolean;
  windowSeconds: number;
  disabledTools: string[];
}

export interface DedupFoldDecision {
  fold: true;
  foldOntoRowId: number;
  newFoldCount: number;
} | {
  fold: false;
  foldKey: string;  // emit so caller can store on the new row
};

export function computeFoldKey(obs: { tool_name: string; tool_input: unknown; cwd?: string; agent_id?: string }): string;
export function shouldFold(
  obs: PendingObservation,
  sessionDbId: number,
  config: DedupFoldConfig,
  store: PendingMessageStore,
): DedupFoldDecision;
export function loadDedupFoldConfig(settings: Record<string, string>): DedupFoldConfig;
export function getDedupFoldConfig(): DedupFoldConfig;
export function _resetDedupFoldConfigCache(): void;
```

`PendingMessageStore` gains two methods:

```ts
findFoldCandidate(sessionDbId: number, foldKey: string, windowMs: number, now: number): { id: number; createdAtEpoch: number } | null;
bumpFoldCount(rowId: number): { newCount: number };
```

`findFoldCandidate` runs the SELECT from §3.1; `shouldFold` is a pure decision wrapper around it. `SessionManager.queueObservation` calls `shouldFold` first, then either `bumpFoldCount` (folded path) or proceeds to `enqueue` with the `fold_key` set on the new row.

## 11. Test Plan

`tests/services/worker/dedup-fold.test.ts` (bun:test, mirrors S2 test style):

### 11.1 `computeFoldKey`
- Returns identical key for `{a:1,b:2}` and `{b:2,a:1}` (canonical sort).
- Returns different keys when `cwd` differs, `agent_id` differs, `tool_name` differs.
- Stable across runs (snapshot a sample value).

### 11.2 `loadDedupFoldConfig`
- Defaults: `enabled=false`, `windowSeconds=30`, `disabledTools=[]`.
- `'true'`/`'false'` strings parse to booleans.
- Invalid integer in `WINDOW_SECONDS` → falls back to 30 + warns.
- CSV splits and trims: `'Bash, Edit ,'` → `['Bash', 'Edit']`.

### 11.3 `getDedupFoldConfig` cache
- Two calls within 5s return same reference.
- After 5s expiry, re-reads settings.
- `_resetDedupFoldConfigCache()` forces re-read.

### 11.4 `shouldFold` decision
- Feature disabled → always `{fold:false}`.
- Tool in disabledTools → `{fold:false}`.
- No prior row → `{fold:false, foldKey: <hex>}`.
- Prior row within window, same fold_key → `{fold:true, foldOntoRowId, newFoldCount}`.
- Prior row past window → `{fold:false}` (opens new group).
- Prior row in different session → not considered.

### 11.5 Integration (`tests/integration/dedup-fold-wired.test.ts`)
- 5× identical `Bash(ls)` within 30s → 1 row in `pending_messages` with `fold_count=5`.
- The SDK message generator receives a prompt containing `<repetition>This tool call was repeated 5 times`.
- Same call >30s apart → 2 rows, `fold_count=1` each.
- `enabled=false` → 5 rows (regression guard for opt-in default).
- Subagent vs main agent → not folded.

## 12. Observer Prompt Hint

`buildObservationPrompt` (in `src/sdk/prompts.ts`) emits the optional `<repetition>` element when `obs.fold_count > 1`. The exact insertion point: between `<outcome>` and the closing tag, matching the order shown in §3.2.

`buildInitPrompt` and `buildContinuationPrompt` are **unchanged** — fold only affects per-observation prompts.

## 13. Documentation

`docs/public/usage/dedup-folding.mdx` — same Mintlify style as `auto-redaction.mdx`:

- Concept overview (1 paragraph)
- Settings table (3 keys)
- Worked example (`Bash(ls)` × 5 → 1 SDK call + `<repetition>5</repetition>`)
- Edge cases (window crossing, subagent isolation, disabled tools)
- How it interacts with existing dedup defenses

## 14. Wire-Up Sites (final list)

| File                                                      | Change                                                    |
|-----------------------------------------------------------|-----------------------------------------------------------|
| `src/services/worker/dedup-fold.ts` (new)                 | Core module.                                              |
| `src/services/sqlite/PendingMessageStore.ts`              | `bumpFoldCount`; `enqueue` accepts `foldKey`.             |
| `src/services/sqlite/schema.sql`                          | Two new columns + index (fresh-DB baseline).              |
| `src/services/sqlite/migrations/runner.ts`                | Add version-35 block per §6.2.                            |
| `src/services/worker/SessionManager.ts`                   | Call `shouldFold` inside `queueObservation`.              |
| `src/sdk/prompts.ts`                                      | Extend `Observation` interface + emit `<repetition>`.     |
| `src/shared/SettingsDefaultsManager.ts`                   | Three new flat keys with defaults.                        |
| `src/utils/logger.ts`                                     | Add `'DEDUP'` to `Component` union.                       |
| `docs/public/usage/dedup-folding.mdx` (new)               | User-facing doc.                                          |
| `tests/services/worker/dedup-fold.test.ts` (new)          | Unit tests.                                               |
| `tests/integration/dedup-fold-wired.test.ts` (new)        | End-to-end fold behavior.                                 |

## 15. Risks + Mitigations

| Risk                                                                  | Severity | Mitigation                                                              |
|-----------------------------------------------------------------------|----------|-------------------------------------------------------------------------|
| `Bash("npm test")` × 5, each fails differently → loses "5 failures"   | M        | User can `CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS=Bash`; SDK still gets `<repetition>` count hint to investigate. |
| Migration on large existing DB                                        | L        | `IF NOT EXISTS` + nullable column + default literal: SQLite ALTER is metadata-only for these forms. |
| Clock skew                                                            | L        | Single worker process; `Date.now()` monotonic enough.                   |
| Fold key collision (16-char prefix = 64 bits)                         | L        | Inside one session, collision probability negligible (<10⁻¹⁰ per session). |
| Subagent rapid identical calls genuinely meaningful                   | L        | Already separated via `agent_id` in fold key.                           |

## 16. Rollout

1. Implement behind `enabled=false` (opt-in).
2. Ship in a minor release; document in usage docs.
3. Collect feedback for one cycle before considering default-on.
4. If default-on later: keep `disabledTools` escape hatch; add a one-shot migration to backfill `fold_key` on existing pending rows (low priority).
