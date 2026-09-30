# Merged-Worktree Adoption

**Goal**: When a worktree's branch is merged into its parent, the worktree's observations become part of the parent project's observation list — without data movement, destructive schema changes, or lost provenance.

**Approach**: Add a nullable `merged_into_project` column to observations and session_summaries, extend query predicates with `OR merged_into_project = :parent`, propagate the same metadata to Chroma embeddings for semantic-search consistency, detect merges via git (authoritative), run adoption automatically on worker startup, and offer a CLI escape hatch for squash-merges.

**Key design decisions**:
- `observations.project` is **immutable provenance** — never overwritten.
- Merged-status is a **virtual pointer**, not a data move.
- **Chroma metadata stays in lockstep with SQLite** (full consistent sync, not lazy SQL expansion). Single source of truth per row.
- Detection is **git-authoritative** (`git worktree list --porcelain` + `git branch --merged`), with a manual CLI override for squash-merges.

---

## Phase 0 — Documentation Discovery (COMPLETE)

Findings consolidated from three parallel discovery subagents. The following are the ONLY APIs/patterns to copy from. Do not invent alternatives.

### Allowed APIs (copy from these locations)

| Need | File | Lines | What to copy |
|---|---|---|---|
| Migration idempotency via marker file | `src/services/infrastructure/ProcessManager.ts` | 680–830 | `runOneTimeCwdRemap` structure, marker file pattern `.cwd-remap-applied-v1` |
| Worker startup wiring | `src/services/worker-service.ts` | 363–365 | Call site inside `initializeBackground()`, invoked before `dbManager.initialize()` |
| `ALTER TABLE ADD COLUMN` idempotency | `src/services/sqlite/migrations/runner.ts` | 131–141 | `PRAGMA table_info(<table>)` guard before `ALTER TABLE ... ADD COLUMN` |
| Column addition example | `src/services/sqlite/migrations/runner.ts` | 495 | `db.run('ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0')` |
| Observations schema | `src/services/sqlite/migrations/runner.ts` | 82–96 | Existing columns + indices (do not duplicate) |
| `schema_versions` marker table | `src/services/sqlite/migrations/runner.ts` | 51–58 | `INSERT OR IGNORE INTO schema_versions ...` — used only when numbered migration |
| Logger | `src/utils/logger.ts` | 18 | Components: `SYSTEM`, `DB`, `CHROMA_SYNC`. Use `logger.info/warn/error('SYSTEM', ...)` |
| Worktree detection | `src/utils/worktree.ts` | 1–84 | `detectWorktree(cwd): WorktreeInfo { isWorktree, worktreeName, parentRepoPath, parentProjectName }` |
| Project-name derivation | `src/utils/project-name.ts` | 73–119 | `getProjectContext(cwd): ProjectContext { primary, parent, isWorktree, allProjects }` |
| Multi-project read (WHERE to extend) | `src/services/context/ObservationCompiler.ts` | 111–160 | `queryObservationsMulti` — `WHERE o.project IN (${projectPlaceholders})` |
| Same, for summaries | `src/services/context/ObservationCompiler.ts` | 168–196 | Parallel summary-fetching query with `ss.project IN (...)` |
| Context injection endpoint | `src/services/worker/http/routes/SearchRoutes.ts` | 211–253 | `handleContextInject` wires `projects` comma-separated query param into `generateContext` |
| Context entry point | `src/services/context/ContextBuilder.ts` | 126–183 | `generateContext()` picks `queryObservationsMulti` when `projects.length > 1` |
| Chroma metadata attach (observations) | `src/services/sync/ChromaSync.ts` | 132–140 | `baseMetadata` object — includes `project`, `sqlite_id`, etc. This is where `merged_into_project` is added. |
| Chroma collection architecture | `src/services/sync/ChromaSync.ts` | 806 (comment) | **Single shared collection `cm__claude-mem`**, scoped by metadata. Do NOT create a per-merged collection. |
| Chroma filter build (read side) | `src/services/sync/SearchManager.ts` | 174–177 | `whereFilter = { project: options.project }` — extended with `$or` in Phase 3 |
| Chroma update API | `src/services/sync/ChromaSync.ts` (grep) | — | `chroma_update_documents` via MCP — used by existing sync flows |
| CLI entrypoint switch | `src/npx-cli/index.ts` | 28–169 | Plain `switch (command)`, dynamic `import()` of `./commands/<name>.ts`. No commander/cac. |
| Admin-script template | `scripts/cwd-remap.ts` | 1–186 | Bun shebang, argv parsing, `--apply` gate, dry-run default |
| UI observation card | `src/ui/viewer/components/ObservationCard.tsx` | 58 | `<span className="card-project">{observation.project}</span>` — where the merged badge is added |

### Anti-patterns (do NOT do these)

- Do NOT overwrite `observations.project` or `session_summaries.project`. These are immutable provenance.
- Do NOT create a new Chroma collection for merged observations. Deployment uses a single shared `cm__claude-mem` collection.
- Do NOT introduce a `gh` CLI dependency. Codebase has no `gh` usage outside `.github/workflows/`. Use `git` subprocesses only.
- Do NOT use SQLite's unsupported `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` syntax. Use the `PRAGMA table_info` guard instead.
- Do NOT use a CLI framework (commander, cac, yargs). The codebase uses hand-rolled `switch (command)` + `process.argv.slice(2)`.
- Do NOT mutate `ProjectContext.allProjects` to inject merged children. The reverse lookup lives in the SQL/Chroma query predicates, not in `ProjectContext`.
- Do NOT run the lazy "SQL-expand projects then filter Chroma" approach. We want Chroma metadata to be the authoritative filter for semantic search.

---

## Phase 1 — Schema migration

**What to implement**: One nullable column + one index on each of `observations` and `session_summaries`. Idempotent via `PRAGMA table_info` guard.

### Files touched

- `src/services/sqlite/migrations/runner.ts`

### Implementation

Add a new method `ensureMergedIntoProjectColumns()` on `MigrationRunner`, modeled on the pattern at lines 131–141:

```typescript
private ensureMergedIntoProjectColumns(): void {
  const obsCols = this.db
    .query('PRAGMA table_info(observations)')
    .all() as TableColumnInfo[];
  if (!obsCols.some(c => c.name === 'merged_into_project')) {
    this.db.run('ALTER TABLE observations ADD COLUMN merged_into_project TEXT');
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)'
    );
  }

  const sumCols = this.db
    .query('PRAGMA table_info(session_summaries)')
    .all() as TableColumnInfo[];
  if (!sumCols.some(c => c.name === 'merged_into_project')) {
    this.db.run('ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT');
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)'
    );
  }
}
```

Call from `runAllMigrations()` — append immediately after the last existing `ensure*` method so it runs on every worker startup. The `PRAGMA table_info` check is O(1) and makes re-runs cheap.

### Verification

- Start the worker. Migration logs show no error.
- `sqlite3 ~/.claude-mem/claude-mem.db ".schema observations"` shows `merged_into_project TEXT`.
- Same for `session_summaries`.
- Restart worker → no ALTER TABLE error (guard worked).
- `sqlite3 ~/.claude-mem/claude-mem.db ".indices observations"` lists `idx_observations_merged_into`.

### Anti-pattern guards

- Do NOT use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — SQLite does not support it.
- Do NOT bump `schema_versions` for this migration. That table is for numbered migration history; the column-existence check is self-idempotent.

---

## Phase 2 — Adoption engine (SQLite + Chroma consistent)

**What to implement**: A single function that, given a parent repo path, detects all merged-worktree branches and stamps `merged_into_project` on both SQLite rows AND Chroma metadata in the same logical operation. Reused by worker startup (Phase 4) and CLI (Phase 5).

### Files touched

- `src/services/infrastructure/WorktreeAdoption.ts` (new)
- `src/services/sync/ChromaSync.ts` — add `updateMergedIntoProject(sqliteIds: number[], mergedIntoProject: string): Promise<void>`

### Public API

```typescript
export interface AdoptionResult {
  repoPath: string;
  parentProject: string;
  scannedWorktrees: number;
  mergedBranches: string[];          // branches classified as merged
  adoptedObservations: number;        // SQLite rows stamped
  adoptedSummaries: number;
  chromaUpdates: number;              // Chroma docs patched
  chromaFailed: number;
  dryRun: boolean;
  errors: Array<{ worktree: string; error: string }>;
}

export async function adoptMergedWorktrees(opts: {
  repoPath?: string;       // defaults to process.cwd()
  dataDirectory?: string;  // defaults to DATA_DIR
  dryRun?: boolean;
  onlyBranch?: string;     // manual override for squash-merge case
}): Promise<AdoptionResult>;
```

### Implementation outline

Mirror `runOneTimeCwdRemap` in `ProcessManager.ts:680–830` for DB lifecycle (open, transaction, finally-close). Add Chroma sync step after SQL commit.

1. **Resolve main repo path**
   - `const mainRepo = execSync('git rev-parse --git-common-dir', { cwd: opts.repoPath ?? process.cwd() })` — strip `/.git` suffix to get the working tree root.
   - This pattern is used in `scripts/cwd-remap.ts:48–51`. Copy that handling verbatim.

2. **Resolve parent project name**
   - `const parentProject = getProjectContext(mainRepo).primary` — imported from `src/utils/project-name.ts`.

3. **Enumerate worktrees**
   - `git -C <mainRepo> worktree list --porcelain` → parse `worktree <path>`, `branch refs/heads/<name>` lines.
   - Filter out the main worktree entry (its path equals `mainRepo`).

4. **Classify as merged**
   - If `opts.onlyBranch` provided: include only that branch (squash-merge escape hatch).
   - Else: `git -C <mainRepo> branch --merged HEAD --format='%(refname:short)'` → intersect with worktree branch list.

5. **Resolve worktree project names**
   - For each merged worktree path, `const worktreeProject = getProjectContext(worktreePath).primary` → yields the composite `parent/worktree` name.

6. **SQL transaction** (model on `ProcessManager.ts:745–760, 808`)
   - Open DB via `new Database(dbPath)` (manage own handle — must close before `dbManager.initialize()` runs).
   - For each merged worktree:
     - `SELECT id FROM observations WHERE project = ? AND merged_into_project IS NULL` → collect sqlite IDs to later push to Chroma.
     - `UPDATE observations SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL`.
     - Same for `session_summaries`.
   - Commit transaction.
   - If `dryRun`, roll back instead.

7. **Chroma metadata sync** (full consistent — NOT lazy)
   - For the set of sqlite IDs just stamped, call `ChromaSync.updateMergedIntoProject(sqliteIds, parentProject)`.
   - `ChromaSync.updateMergedIntoProject` implementation:
     ```typescript
     async updateMergedIntoProject(sqliteIds: number[], mergedIntoProject: string): Promise<void> {
       if (sqliteIds.length === 0) return;
       // Batch: look up Chroma doc IDs via metadata filter on sqlite_id, then patch.
       const where = { sqlite_id: { $in: sqliteIds } };
       const existing = await chromaMcp.callTool('chroma_get_documents', {
         collection_name: this.collectionName,
         where,
         include: ['metadatas']
       });
       const docIds: string[] = existing.ids ?? [];
       const metadatas: Record<string, unknown>[] = (existing.metadatas ?? []).map(m => ({
         ...m,
         merged_into_project: mergedIntoProject
       }));
       if (docIds.length === 0) return;
       await chromaMcp.callTool('chroma_update_documents', {
         collection_name: this.collectionName,
         ids: docIds,
         metadatas
       });
     }
     ```
   - On Chroma error: log via `logger.error('CHROMA_SYNC', ...)`, increment `chromaFailed`, but do NOT roll back SQL. SQL is source of truth; a subsequent run will retry the Chroma patch (idempotent — metadata set to same value is a no-op).

8. **Logging**
   - `logger.info('SYSTEM', 'Worktree adoption applied', { parentProject, adoptedObservations, adoptedSummaries, chromaUpdates, chromaFailed, mergedBranches })`.
   - On per-worktree error: `logger.warn('SYSTEM', 'Worktree adoption skipped branch', { worktree, error })` — collect in `errors[]`, continue.

9. **Re-adoption safety net**
   - Because Chroma updates can fail independently, add a secondary SQL-side reconciliation: on each adoption run, also find `observations WHERE merged_into_project IS NOT NULL` whose Chroma metadata lacks the field. Run the same `updateMergedIntoProject` on that delta.
   - Keep this bounded: only reconcile rows adopted in the last N days (e.g. 30) to avoid full-table scans.

### Verification

- Dry-run against a repo with one known-merged worktree: result shows correct `adoptedObservations`, DB unchanged, no Chroma writes.
- Real run: `SELECT COUNT(*) FROM observations WHERE merged_into_project IS NOT NULL` matches `adoptedObservations`.
- Chroma: `chroma_get_documents` with `where: { merged_into_project: 'claude-mem' }` returns the same row count.
- Re-run: `adoptedObservations = 0`, `chromaUpdates = 0` (both idempotent).
- Simulate Chroma outage (stop chroma): adoption logs `CHROMA_SYNC` error, `chromaFailed > 0`, SQL still stamps. Next run with Chroma back up reconciles the delta.

### Anti-pattern guards

- Do NOT rollback SQL on Chroma failure. SQL is authoritative; Chroma is a derived index.
- Do NOT call Chroma per-row. Batch by sqlite_id set to minimize round-trips.
- Do NOT adopt branches not in `git branch --merged HEAD` unless `onlyBranch` override is explicit.
- Do NOT touch observations whose `project` is not a composite worktree name. The worktree-name match is the safety gate.
- Do NOT skip the `merged_into_project IS NULL` clause on UPDATE — this is what makes the run idempotent.

---

## Phase 3 — Query plumbing (SQLite + Chroma $or)

**What to implement**: Extend the two multi-project read queries in `ObservationCompiler.ts` and the Chroma filter in `SearchManager.ts` to treat `merged_into_project` as a second match axis. Direct Chroma `$or` filter — no SQL-side expansion dance.

### Files touched

- `src/services/context/ObservationCompiler.ts`
- `src/services/sync/SearchManager.ts`

### 3a. SQLite WHERE-clause extension

`src/services/context/ObservationCompiler.ts:111–160` (`queryObservationsMulti`): change

```sql
WHERE o.project IN (${projectPlaceholders})
```

to

```sql
WHERE (o.project IN (${projectPlaceholders})
       OR o.merged_into_project IN (${projectPlaceholders}))
```

Double-bind the `projects` array:

```typescript
.all(
  ...projects,          // for o.project IN (...)
  ...projects,          // for o.merged_into_project IN (...)
  ...typeArray,
  ...conceptArray,
  ...(platformSource ? [platformSource] : []),
  config.totalObservationCount
)
```

`src/services/context/ObservationCompiler.ts:168–196` (summary variant): apply the same extension, using `ss.merged_into_project`.

### 3b. Chroma filter extension

`src/services/sync/SearchManager.ts:174–177`:

```typescript
if (options.project) {
  const projectFilter = {
    $or: [
      { project: options.project },
      { merged_into_project: options.project }
    ]
  };
  whereFilter = whereFilter
    ? { $and: [whereFilter, projectFilter] }
    : projectFilter;
}
```

When `options.project` is an array (if that path exists — grep first), build a flat `$or` over both fields × all requested projects.

### 3c. New-observation Chroma metadata

`src/services/sync/ChromaSync.ts:132–140` — extend `baseMetadata`:

```typescript
const baseMetadata: Record<string, string | number | null> = {
  sqlite_id: obs.id,
  doc_type: 'observation',
  memory_session_id: obs.memory_session_id,
  project: obs.project,
  merged_into_project: obs.merged_into_project ?? null,  // NEW
  created_at_epoch: obs.created_at_epoch,
  type: obs.type || 'discovery',
  title: obs.title || 'Untitled'
};
```

This makes every new observation Chroma-compatible with the Phase 3b filter from the first sync. For existing rows, Phase 2's adoption engine patches metadata retroactively.

**Check Chroma metadata type constraints**: Chroma rejects `null` in metadata — confirm via a quick test. If `null` is rejected, OMIT the field when unset (use `if (obs.merged_into_project) baseMetadata.merged_into_project = obs.merged_into_project;`).

### 3d. ContextBuilder compatibility check

`src/services/context/ContextBuilder.ts:126–183` — no change needed. `projects = input?.projects ?? context.allProjects` stays as-is; the extended WHERE clause in Phase 3a does all the work.

### Verification

- Before adoption: context-inject API for `claude-mem` returns N observations.
- After adoption of `claude-mem/dar-es-salaam`: API returns N + M (M = count of dar-es-salaam's own observations).
- Semantic search via Chroma (`/search` endpoint or MCP) with `project=claude-mem` returns dar-es-salaam-origin rows too.
- Worktree-local queries (`projects=[claude-mem, claude-mem/dar-es-salaam]`) still return `[parent + own]` unchanged.
- SQL EXPLAIN on the extended WHERE shows it uses `idx_observations_project` OR `idx_observations_merged_into` (both indices hit).

### Anti-pattern guards

- Do NOT lose the `o.project` filter — it's still required (merged-row predicate is additive, not a replacement).
- Do NOT forget to double-bind `projects` in the prepared statement — placeholder count must match argument count.
- Do NOT add a subquery or JOIN for merged discovery. A flat `OR` + index is faster.
- Do NOT write `null` into Chroma metadata if Chroma rejects it. Use the "omit if unset" pattern.

---

## Phase 4 — Automatic trigger on worker startup

**What to implement**: Call `adoptMergedWorktrees()` during worker startup, immediately after `runOneTimeCwdRemap()`. **Not** marker-gated — it runs every worker startup because git state evolves and the engine is idempotent.

### Files touched

- `src/services/worker-service.ts`

### Implementation

Import alongside existing `ProcessManager` imports at lines 41–53:

```typescript
import { adoptMergedWorktrees } from './infrastructure/WorktreeAdoption.js';
```

Insert immediately after the existing `runOneTimeCwdRemap()` call at lines 363–365:

```typescript
runOneTimeCwdRemap();

try {
  const result = await adoptMergedWorktrees({});
  if (result.adoptedObservations > 0 || result.chromaUpdates > 0) {
    logger.info('SYSTEM', 'Merged worktrees adopted on startup', result);
  }
  if (result.errors.length > 0) {
    logger.warn('SYSTEM', 'Worktree adoption had per-branch errors', { errors: result.errors });
  }
} catch (err) {
  logger.error('SYSTEM', 'Worktree adoption failed (non-fatal)', {}, err as Error);
}
```

**DB lifecycle note**: `adoptMergedWorktrees` must manage its own DB handle (open + close) before `dbManager.initialize()` runs at line 380. Mirror `runOneTimeCwdRemap`'s finally-block pattern.

### Verification

- Restart worker. Log shows "Merged worktrees adopted on startup" only on first run after a new merge lands.
- Subsequent restarts log nothing (idempotent).
- Simulate adoption exception (e.g., rename git temporarily): log shows error, worker startup continues successfully.
- Build-and-sync restart picks up new merges without manual intervention.

### Anti-pattern guards

- Do NOT block worker startup on adoption failure. Wrap in try/catch; swallow + log.
- Do NOT run adoption after `dbManager.initialize()`. The engine manages its own DB handle; two handles at once risk lock contention.
- Do NOT await Chroma sync before returning SQL success. Internally, yes; but don't make worker startup hang on Chroma I/O — cap with a reasonable timeout inside the engine.

---

## Phase 5 — CLI escape hatch

**What to implement**: `claude-mem adopt [--branch <name>] [--dry-run]` — covers squash-merge where `git branch --merged` returns nothing, and provides a manual override for any adoption run.

### Files touched

- `src/npx-cli/commands/adopt.ts` (new)
- `src/npx-cli/index.ts` (add `case 'adopt'`)
- `scripts/adopt-worktrees.ts` (new, optional — admin script for bulk ops)

### 5a. Command module

`src/npx-cli/commands/adopt.ts` — follow shape of sibling commands (dynamic-imported by the switch):

```typescript
import pc from 'picocolors';
import { adoptMergedWorktrees } from '../../services/infrastructure/WorktreeAdoption.js';

export interface AdoptCommandOptions {
  dryRun?: boolean;
  onlyBranch?: string;
}

export async function runAdoptCommand(opts: AdoptCommandOptions): Promise<void> {
  const result = await adoptMergedWorktrees({
    dryRun: opts.dryRun,
    onlyBranch: opts.onlyBranch
  });

  console.log(pc.bold(`\nWorktree adoption ${result.dryRun ? pc.yellow('(dry-run)') : pc.green('(applied)')}`));
  console.log(`  Parent project:         ${result.parentProject}`);
  console.log(`  Worktrees scanned:      ${result.scannedWorktrees}`);
  console.log(`  Merged branches:        ${result.mergedBranches.join(', ') || '(none)'}`);
  console.log(`  Observations adopted:   ${result.adoptedObservations}`);
  console.log(`  Summaries adopted:      ${result.adoptedSummaries}`);
  console.log(`  Chroma docs updated:    ${result.chromaUpdates}`);
  if (result.chromaFailed > 0) {
    console.log(pc.yellow(`  Chroma sync failures:   ${result.chromaFailed} (will retry on next run)`));
  }
  for (const err of result.errors) {
    console.log(pc.red(`  ! ${err.worktree}: ${err.error}`));
  }
}
```

### 5b. CLI switch

`src/npx-cli/index.ts` — add between existing cases, following the pattern at lines 28–169:

```typescript
case 'adopt': {
  const dryRun = args.includes('--dry-run');
  const branchIndex = args.indexOf('--branch');
  const onlyBranch = branchIndex !== -1 ? args[branchIndex + 1] : undefined;
  const { runAdoptCommand } = await import('./commands/adopt.js');
  await runAdoptCommand({ dryRun, onlyBranch });
  break;
}
```

### 5c. Admin script (optional)

`scripts/adopt-worktrees.ts` — Bun shebang script for users without the plugin installed. Model on `scripts/cwd-remap.ts:1–186`. Default: dry-run. Pass `--apply` to commit.

### Verification

- `npx claude-mem adopt --dry-run` in a repo with merged worktrees prints what WOULD be adopted without writing.
- `npx claude-mem adopt` writes + prints counts.
- `npx claude-mem adopt --branch feature/foo` forces adoption of that branch even if `git branch --merged` doesn't include it (squash case).
- `bun scripts/adopt-worktrees.ts --apply` equivalent to the CLI.
- Help text / unknown command still reports the existing error (CLI pattern preserved).

### Anti-pattern guards

- Do NOT require running from the worktree. Detection always resolves up to the common-dir, regardless of cwd.
- Do NOT default to `--apply`. Dry-run first matches `scripts/cwd-remap.ts` ergonomics.
- Do NOT introduce `commander`, `yargs`, `cac`. Stay with the existing hand-rolled parser.

---

## Phase 6 — UI surfacing

**What to implement**: When the viewer shows an observation in a parent-project context that originated in a merged worktree, display a "merged from <worktree>" badge so provenance is visible. Keep the original `project` field rendered too.

### Files touched

- `src/ui/viewer/components/ObservationCard.tsx`
- Type definition for `Observation` — wherever `.project` is declared, add `merged_into_project?: string | null`.
- Observation serializer on the worker → UI path (grep for `doc_type: 'observation'` or `serializeObservation` to find it).
- CSS file for ObservationCard styles.

### Implementation

Locate the current label render at `src/ui/viewer/components/ObservationCard.tsx:58`:

```tsx
<span className="card-project">{observation.project}</span>
```

Extend to:

```tsx
<span className="card-project">{observation.project}</span>
{observation.merged_into_project && (
  <span className="card-merged-badge" title={`Merged into ${observation.merged_into_project}`}>
    merged → {observation.merged_into_project}
  </span>
)}
```

Add CSS for `.card-merged-badge` — subtle secondary chip style (muted color, smaller font). Match existing `.card-source` / `.card-project` aesthetics.

### Verification

- After adoption, open viewer at `http://localhost:37777`, select the parent project. Merged observations show both their origin worktree name AND the "merged →" badge.
- Worktree view (if still addressable) shows no badge (badge only renders when `merged_into_project` is set; a worktree viewing its own observations would not see it, since in that view `merged_into_project` is the PARENT name, not the current project).
- Hover tooltip shows full target project name.

### Anti-pattern guards

- Do NOT hide merged observations in the parent view. The goal is visibility.
- Do NOT replace `project` display with `merged_into_project`. Both are meaningful: `project` = origin, `merged_into_project` = current home.
- Do NOT require a UI setting toggle to show the badge. Default on.

---

## Phase 7 — Verification pass

### Unit tests

- `adoptMergedWorktrees({ dryRun: true })` against a fixture repo with `[merged, unmerged, squash-merged]` worktrees → classification matches expectation.
- `ChromaSync.updateMergedIntoProject` on an empty `sqliteIds` array → no-op, no Chroma call.
- Extended `queryObservationsMulti` with a mixed set of `project` and `merged_into_project` matches → returns union, sorted by `created_at_epoch DESC`.

### Integration tests

- Start worker → create synthetic observations under `claude-mem/test-wt` → simulate branch merge (`git merge`) → restart worker → context-inject API for `claude-mem` returns test-wt observations.
- Same flow with a squash-merge → auto-adoption misses → run `claude-mem adopt --branch test-wt` → API now returns them.
- Re-run `claude-mem adopt` twice: second run reports `adoptedObservations: 0, chromaUpdates: 0`.

### Anti-pattern grep checks

Run before landing:

```bash
# No one renamed the project field
rg "UPDATE observations SET project" src/
# (Expected: zero hits other than the existing CWD remap)

# Adoption only touches via IS NULL guard
rg "merged_into_project" src/ -C2
# (Expected: all UPDATE sites include "IS NULL" predicate)

# CLI registered
rg "case 'adopt'" src/npx-cli/index.ts
# (Expected: one hit)

# Chroma metadata extension present
rg "merged_into_project" src/services/sync/ChromaSync.ts
# (Expected: hits in baseMetadata and updateMergedIntoProject)

# No gh CLI introduced
rg "\\bgh\\s+(pr|issue|api)" src/ scripts/
# (Expected: zero hits outside .github/workflows/)
```

### Documentation cross-check

- ObservationCompiler WHERE clause matches the shape used by the shipped worktree-reads-parent feature — both clauses symmetric, visible in a single read of the file.
- Chroma metadata field name `merged_into_project` matches SQLite column name exactly (no `mergedIntoProject`, `merged_project`, etc.).
- CLI `--branch` flag accepts the same format as worktree composite names.

---

## Summary

| Phase | Files touched | New LOC (approx.) |
|---|---|---|
| 1. Schema | `src/services/sqlite/migrations/runner.ts` | ~25 |
| 2. Adoption engine | `src/services/infrastructure/WorktreeAdoption.ts` (new), `src/services/sync/ChromaSync.ts` (new method) | ~200 |
| 3. Query plumbing | `src/services/context/ObservationCompiler.ts`, `src/services/sync/SearchManager.ts`, `src/services/sync/ChromaSync.ts` | ~40 |
| 4. Auto-trigger | `src/services/worker-service.ts` | ~15 |
| 5. CLI | `src/npx-cli/commands/adopt.ts` (new), `src/npx-cli/index.ts`, `scripts/adopt-worktrees.ts` (new) | ~100 |
| 6. UI | `src/ui/viewer/components/ObservationCard.tsx`, Observation type, serializer, CSS | ~20 |
| 7. Tests + verification | scattered | — |
| **Total** | | **~400 LOC** |

**Reversibility**: `UPDATE observations SET merged_into_project = NULL` + a Chroma `update_documents` call with the field omitted restores pre-adoption state completely. Nothing is destroyed.

**Architecture fit**: Mirrors the just-shipped CWD remap migration (`runOneTimeCwdRemap`) for structure, lifecycle, and logging conventions. Chroma metadata sync matches the existing per-observation attach pattern.

**Blast radius**: Zero risk to existing data (no writes to `project` field). Chroma additions are metadata-only (embeddings untouched). Query extensions are additive OR clauses — existing queries still return what they did.
