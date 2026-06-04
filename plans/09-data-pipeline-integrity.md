# [plan-09] Data-Pipeline Integrity & Migration Transparency — stop "healthy worker, frozen observations"

## Defect

The worker can report healthy while new data silently stops reaching the `observations` table. The write path and schema contract are enforced inconsistently and their failures are swallowed, so the operator-visible symptom is identical across several distinct root causes: memory looks "frozen" and there is no error. Concretely: an idempotent migration is skipped on pre-existing DBs and its absence is silent; the MCP write tools drop required fields so the row the sync trigger needs is never populated; session identity is never set so messages are dropped; and the search layer ignores the source-scoping filter so memories bleed across agents.

The architectural fix is a **verified write-path + migration contract**: migrations run unconditionally and idempotently on every boot with a logged schema-version audit; the MCP/REST create path validates the field→column→trigger chain so a record cannot be accepted yet fail to persist; ingestion filtering is expressive enough to exclude noise; and source-scoping is applied wherever memory is read.

## Children

- #2433 — `merged_into_project` migration silently skipped on pre-existing DBs (`schema_versions ≤ 23`); queries throw no-such-column, UI falsely shows "no memory yet"
- #2684 — MCP `observation_add` / `memory_add` drop `narrative`/`title`/`type` → empty records, `narrative` column never populated, sync trigger never fires, observations frozen
- #2533 — observations never persisted; `pending_messages` empty, `memory_session_id`/`worker_port` never set
- #2389 — `/api/search` ignores `platformSource`; Codex/other-agent search returns cross-platform / null-source memories
- #2442 — transcript `MatchRule` has no negation, so structurally-identical guardian/subagent sessions can't be excluded and pollute memory

## Fix sequence

1. **Migrations always run, idempotently, with audit:** drop the conditional skip; run every migration on boot guarded by idempotency, and log a schema-version audit line so a missing column is impossible to ship silently (#2433).
2. **Write-path contract:** validate the MCP/REST `create` field set, map it to columns, and assert the sync trigger's precondition column is populated; reject (loudly) a create that can't persist instead of accepting an empty record (#2684, #2533).
3. **Session identity:** ensure `memory_session_id`/`worker_port` are set before messages are accepted, so nothing is dropped for want of identity (#2533).
4. **Read-side source-scoping:** thread `platform_source` through the search SQL, the `search` MCP tool schema, and context generation so agents only see their own memory unless explicitly cross-querying (#2389).
5. **Ingestion filtering:** add `not_equals`/`not_in`/`not_contains` (and fix `exists:false`) to transcript `MatchRule` so noise sessions can be excluded (#2442).

## Test matrix

| Stage | Condition | Required behavior |
|---|---|---|
| Boot on pre-existing DB (`schema_versions ≤ 23`) | migration pending | migration runs idempotently; schema-version logged; no no-such-column |
| MCP `observation_add` | full + partial field set | row persists with `narrative`; missing required field → loud reject, never empty row |
| Session start | first message | `memory_session_id`/`worker_port` set before accept |
| Search | `platformSource=codex` | only codex-sourced rows returned; no null-source bleed |
| Transcript ingest | guardian/subagent session | excluded by negation rule; not stored |

The matrix lives in CI. A "healthy worker, frozen observations" regression must fail CI before a user can file.

## Out of scope

- Worker process supervision / crashes → plan-03.
- Chroma vector-search engine stability → plan-03 (process supervision) / upstream.
- OpenCode client response parsing → plan-08.
