# Server Storage Boundary

Phase 4 adds the contracts and SQLite tables for the future server-owned storage model. It is additive only: worker routes, providers, existing search, and legacy observation writes still use the current `sdk_sessions`, `observations`, `session_summaries`, `user_prompts`, and `pending_messages` tables.

## Tables

Server-owned tables are created by `ensureServerStorageSchema()` in `src/storage/sqlite/schema.ts`:

- `projects`
- `server_sessions`
- `agent_events`
- `memory_items`
- `memory_sources`
- `teams`
- `team_members`
- `api_keys`
- `audit_log`

`MigrationRunner` records these tables as schema version 33. Repositories also call the same helper so future server bootstrap code can use the storage boundary without depending on worker initialization.

## Contracts

Shared Zod contracts live under `src/core/schemas/`. Repository methods parse inputs and outputs through these schemas and store structured fields as JSON `TEXT`, matching the existing Bun SQLite style.

## Observation To Memory Translation

The translation layer is intentionally documented but not wired into existing search in this phase.

Decision: legacy `observations` remain the source of truth until a later migration explicitly backfills and switches readers. A future translator should create one `memory_items` row per legacy `observations` row with:

- `memory_items.kind = 'observation'`
- `memory_items.type = observations.type`
- `memory_items.project_id` resolved from the canonical `projects` row for `observations.project`
- `memory_items.server_session_id` resolved through `server_sessions.memory_session_id = observations.memory_session_id`
- `memory_items.legacy_observation_id = observations.id`
- `title`, `subtitle`, `text`, `narrative`, `facts`, `concepts`, `files_read`, and `files_modified` copied from the legacy row
- one `memory_sources` row with `source_type = 'observation'`, `legacy_table = 'observations'`, and `legacy_id = observations.id`

The schema enforces this as an idempotent backfill target with partial unique
indexes on `memory_items.legacy_observation_id` and
`memory_sources(source_type, legacy_table, legacy_id)` when legacy source IDs are
present.

Until that backfill exists, new repositories may write `memory_items` directly for server-owned workflows, but no worker path should read from `memory_items` as a replacement for `observations`.

Rows that reference `server_sessions` must stay inside the same `project_id`.
SQLite triggers reject cross-project `agent_events` and `memory_items` links so
project-scoped reads cannot accidentally mix memories from another project.

## Auth Placeholder

`api_keys` is a local placeholder for future Better Auth integration. This phase stores hashes, prefixes, scopes, and status locally; it does not introduce a Better Auth runtime dependency or middleware wiring.
