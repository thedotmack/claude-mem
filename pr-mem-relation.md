# PR: Add MemoryRelation Typed-Edge System

**Branch:** `claude_and_billyziege/feature-memory-relations`
**Target:** `main` (thedotmack/claude-mem)
**Authors:** Brandon Zerbe (@billyziege) + Claude Sonnet 4.6

---

## Summary

Adds a `memory_relations` table and full MCP/REST surface so memory items
can be linked with semantic typed edges. The motivating problem: claude-mem
has no way to express that one memory *supersedes* another — when you learn
something new that invalidates an old observation, the old one keeps
appearing in search results with equal weight. This PR fixes that, and
generalises the mechanism to cover three additional relation types useful
in richer memory architectures.

**Four relation types:**

| type | semantics |
|---|---|
| `supersedes` | source replaces target — target is excluded from search by default |
| `elaborates_on` | source adds detail to target without invalidating it |
| `contextualizes` | source provides background for target |
| `obfuscates` | source hides target (e.g. a cover story, a disguise, a redaction) |

The staleness problem is solved without destroying history: a superseded
memory stays in the DB, remains queryable with `excludeSuperseded=false`,
and can be resurfaced by deactivating the relation (`relation_set_active`).

---

## Changes

### Schema — `src/storage/sqlite/schema.ts`

New `memory_relations` table added to `ensureServerStorageSchema`:

```sql
CREATE TABLE IF NOT EXISTS memory_relations (
  id                TEXT    PRIMARY KEY,
  source_memory_id  TEXT    NOT NULL,
  target_memory_id  TEXT    NOT NULL,
  relation_type     TEXT    NOT NULL
                    CHECK(relation_type IN ('supersedes', 'elaborates_on',
                                            'contextualizes', 'obfuscates')),
  is_active         INTEGER NOT NULL DEFAULT 1,
  condition         TEXT,
  metadata          TEXT    NOT NULL DEFAULT '{}',
  created_at_epoch  INTEGER NOT NULL,
  FOREIGN KEY(source_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
  FOREIGN KEY(target_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
  UNIQUE(source_memory_id, target_memory_id, relation_type)
);
```

Four indexes: `source_memory_id`, `target_memory_id`, `relation_type`,
`(is_active, relation_type)`.

`SERVER_STORAGE_SCHEMA_VERSION` bumped from 33 → 35 (skipping 34, which is
already used by `rebuildPendingMessagesForFinalQueueSchema` in the migration
runner — sharing the same `schema_versions` table requires non-overlapping
version numbers).

`CREATE TABLE IF NOT EXISTS` means existing databases pick up the new table
on the next server restart with no separate migration method required.

### Zod Schemas — `src/core/schemas/memory-item.ts`

New exports: `MemoryRelationTypeSchema`, `MemoryRelationSchema`,
`CreateMemoryRelationSchema`, and their inferred types
(`MemoryRelationType`, `MemoryRelation`, `CreateMemoryRelation`).

### Storage — `src/storage/sqlite/memory-relations.ts` (new file)

`MemoryRelationsRepository` with:

- `create(input)` → inserts and returns the new relation
- `getById(id)` → single fetch
- `listBySource(sourceMemoryId)` → all relations where this memory is the source
- `listByTarget(targetMemoryId)` → all relations where this memory is the target
- `setActive(id, isActive)` → flip `is_active` without deleting
- `getSupersededIds(projectId?)` → IDs of memories that have an active
  `supersedes` edge pointing at them; used for search filtering

Exported via `src/storage/sqlite/index.ts`.

### Search behaviour — `src/storage/sqlite/memory-items.ts`

`search()` and `listByProject()` both gain an `excludeSuperseded` parameter
(default `true`). When true, a `NOT EXISTS` subquery filters any memory that
has an active `supersedes` relation pointing at it:

```sql
AND NOT EXISTS (
  SELECT 1 FROM memory_relations
  WHERE memory_relations.target_memory_id = memory_items.id
    AND memory_relations.relation_type = 'supersedes'
    AND memory_relations.is_active = 1
)
```

Pass `excludeSuperseded=false` to retrieve the full unfiltered history.

### REST endpoints — `src/server/routes/v1/ServerV1Routes.ts`

| method | path | auth | description |
|---|---|---|---|
| `POST` | `/v1/relations` | write | Create a relation. Resolves project from source memory for auth scoping. |
| `GET` | `/v1/memories/:id/relations` | read | List relations. Returns `{ asSource, asTarget }`. Optional `?direction=source\|target\|both` (default `both`). |
| `POST` | `/v1/relations/:id/set-active` | write | Flip `is_active`. POST (not PATCH) consistent with `/v1/sessions/:id/end` pattern. |

### HTTP client — `src/services/hooks/server-beta-client.ts`

Three new methods on `ServerBetaClient` and their request/response interfaces:

- `createRelation(input)` → `POST /v1/relations`
- `listMemoryRelations(memoryId, direction?)` → `GET /v1/memories/:id/relations`
- `setRelationActive(relationId, isActive)` → `POST /v1/relations/:id/set-active`

All route through the existing `private request<T>` so auth headers,
timeout handling, and `ServerBetaClientError` propagation are inherited.

### MCP tools — `src/servers/mcp-server.ts`

Three new tools (server-beta runtime only, consistent with `observation_*`):

| tool | description |
|---|---|
| `memory_relate` | Create a typed relation. Required: `sourceMemoryId`, `targetMemoryId`, `relationType`. Optional: `condition` (narrative resurfacing condition, mainly for `obfuscates`). |
| `memory_relations_list` | List relations for a memory. Required: `memoryId`. Optional: `direction` (`source\|target\|both`, default `both`). |
| `relation_set_active` | Flip a relation's `is_active`. Required: `relationId`, `isActive` (boolean). |

---

## Design decisions

**Why `supersedes` filters search by default rather than deleting the old memory:**
Deletion destroys audit history and is irreversible. `is_active=false`
resurfaces the old memory if the relation is deactivated — useful when an
"update" turns out to be wrong, or when reconstructing what was believed at
a point in time.

**Why POST for `set-active` rather than PATCH:**
The existing codebase uses `POST /v1/sessions/:id/end` for state transitions.
PATCH would require extending `ServerBetaClient.request<T>` to support a
third HTTP verb for a single endpoint. POST is consistent and simpler.

**Why version 35 and not 34:**
`rebuildPendingMessagesForFinalQueueSchema` in `MigrationRunner` already
records version 34 in `schema_versions`. Using 34 for the server storage
version would cause that migration's early-exit guard
(`if (applied) return`) to skip the pending_messages rebuild on fresh
installs, corrupting the queue schema. 35 is the next safe slot.

**Why `CREATE TABLE IF NOT EXISTS` rather than a new migration method:**
`createServerOwnedTables()` already calls `ensureServerStorageSchema(db)`
on every startup with no early-exit guard. `IF NOT EXISTS` is idempotent,
so the new table is created on first restart for both new and existing
installs without adding a new migration case to the runner.

---

## Testing checklist (pre-submission)

- [ ] Fresh install: `memory_relations` table created on first start
- [ ] Existing install: table appears after restart, no data loss
- [ ] `POST /v1/relations` — happy path, 404 on missing source, 403 on wrong project
- [ ] `GET /v1/memories/:id/relations` — all three `direction` values
- [ ] `POST /v1/relations/:id/set-active` — activate/deactivate round-trip
- [ ] `search()` with `excludeSuperseded=true` (default) hides superseded items
- [ ] `search()` with `excludeSuperseded=false` returns full history
- [ ] `memory_relate` MCP tool — creates relation, returns JSON
- [ ] `memory_relations_list` MCP tool — both directions
- [ ] `relation_set_active` MCP tool — resurfaces a superseded memory
- [ ] All three MCP tools return a typed `ServerBetaClientError` when server-beta is not configured
- [ ] UNIQUE constraint on `(source, target, type)` rejects duplicate edges
- [ ] ON DELETE CASCADE: deleting a memory_item removes its relations

---

## Files changed

```
src/core/schemas/memory-item.ts          +26 lines  (new Zod schemas)
src/storage/sqlite/memory-relations.ts   new file   (repository)
src/storage/sqlite/index.ts              +1 line    (export)
src/storage/sqlite/schema.ts             +22 lines  (table + indexes, version bump)
src/storage/sqlite/memory-items.ts       +24 lines  (excludeSuperseded param)
src/server/routes/v1/ServerV1Routes.ts   +50 lines  (3 REST endpoints)
src/services/hooks/server-beta-client.ts +63 lines  (interfaces + 3 client methods)
src/servers/mcp-server.ts               +123 lines  (3 handler functions + 3 tools)
src/services/sqlite/schema.sql           +2 lines   (doc comment update)
```
