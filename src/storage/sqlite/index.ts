// SQLite persistence for claude-mem. Both table sets below live in the SAME
// database file (~/.claude-mem/claude-mem.db) but have distinct owners:
//
// - This package root (worker-owned): observations, sessions, summaries,
//   prompts, timeline, pending_messages, ... Schema evolves through the
//   inline migration chain in ./SessionStore.ts — never CREATE TABLE elsewhere.
//
// - ./server/ (server-beta-owned): SERVER_OWNED_TABLES (projects, teams,
//   api_keys, audit_log, ...). Schema is the idempotent
//   ensureServerStorageSchema() in ./server/schema.ts, invoked both by the
//   migration runner and by server-beta entry points that may run before the
//   worker ever has.
//
// Postgres equivalents of the server-beta repositories live in ../postgres/.

export { SessionStore } from './SessionStore.js';

export { SessionSearch } from './SessionSearch.js';

export * from './types.js';
