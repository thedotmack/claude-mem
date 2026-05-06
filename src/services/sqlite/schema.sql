-- claude-mem SQLite schema
--
-- Authoritative shape of the database after all migrations through
-- runner.ts have been applied (current tip = migration 29). Fresh
-- databases boot directly into this shape; existing databases reach
-- it via the migration runner.
--
-- Source of truth: src/services/sqlite/migrations/runner.ts
-- Regenerated from the migration runner and current schema invariants.
--
-- Invariants enforced here (Plan 01):
--   * pending_messages.UNIQUE(content_session_id, tool_use_id) — replaces
--     in-memory pendingTools Map for ingestion pairing (Plan 03 also depends).
--   * pending_messages.worker_pid INTEGER — populated by self-healing
--     claim query; replaces the legacy stale-reset epoch column.
--   * observations.UNIQUE(memory_session_id, content_hash) — replaces the
--     legacy dedup window; ON CONFLICT DO NOTHING absorbs duplicates.

CREATE TABLE IF NOT EXISTS schema_versions (
  id INTEGER PRIMARY KEY,
  version INTEGER UNIQUE NOT NULL,
  applied_at TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────
-- sdk_sessions: one row per Claude/Codex session observed by claude-mem.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sdk_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id  TEXT    UNIQUE NOT NULL,
  memory_session_id   TEXT    UNIQUE,
  project             TEXT    NOT NULL,
  platform_source     TEXT    NOT NULL DEFAULT 'claude',
  user_prompt         TEXT,
  started_at          TEXT    NOT NULL,
  started_at_epoch    INTEGER NOT NULL,
  completed_at        TEXT,
  completed_at_epoch  INTEGER,
  status              TEXT    NOT NULL DEFAULT 'active'
                              CHECK(status IN ('active', 'completed', 'failed')),
  worker_port         INTEGER,
  prompt_counter      INTEGER DEFAULT 0,
  custom_title        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id        ON sdk_sessions(content_session_id);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id           ON sdk_sessions(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project          ON sdk_sessions(project);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status           ON sdk_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started          ON sdk_sessions(started_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source  ON sdk_sessions(platform_source);

-- ─────────────────────────────────────────────────────────────────────
-- observations: structured memory rows extracted from SDK output.
-- UNIQUE(memory_session_id, content_hash) replaces the legacy dedup window;
-- writes use INSERT … ON CONFLICT DO NOTHING.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id    TEXT    NOT NULL,
  project              TEXT    NOT NULL,
  text                 TEXT,
  type                 TEXT    NOT NULL,
  title                TEXT,
  subtitle             TEXT,
  facts                TEXT,
  narrative            TEXT,
  concepts             TEXT,
  files_read           TEXT,
  files_modified       TEXT,
  prompt_number        INTEGER,
  discovery_tokens     INTEGER DEFAULT 0,
  content_hash         TEXT,
  agent_type           TEXT,
  agent_id             TEXT,
  merged_into_project  TEXT,
  generated_by_model   TEXT,
  metadata             TEXT,
  created_at           TEXT    NOT NULL,
  created_at_epoch     INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE(memory_session_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_observations_sdk_session  ON observations(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_observations_project      ON observations(project);
CREATE INDEX IF NOT EXISTS idx_observations_type         ON observations(type);
CREATE INDEX IF NOT EXISTS idx_observations_created      ON observations(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_observations_agent_type   ON observations(agent_type);
CREATE INDEX IF NOT EXISTS idx_observations_agent_id     ON observations(agent_id);
CREATE INDEX IF NOT EXISTS idx_observations_merged_into  ON observations(merged_into_project);

-- ─────────────────────────────────────────────────────────────────────
-- session_summaries: one summary row per memory session.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_summaries (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id    TEXT    NOT NULL,
  project              TEXT    NOT NULL,
  request              TEXT,
  investigated         TEXT,
  learned              TEXT,
  completed            TEXT,
  next_steps           TEXT,
  files_read           TEXT,
  files_edited         TEXT,
  notes                TEXT,
  prompt_number        INTEGER,
  discovery_tokens     INTEGER DEFAULT 0,
  merged_into_project  TEXT,
  created_at           TEXT    NOT NULL,
  created_at_epoch     INTEGER NOT NULL,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session  ON session_summaries(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_session_summaries_project      ON session_summaries(project);
CREATE INDEX IF NOT EXISTS idx_session_summaries_created      ON session_summaries(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_merged_into          ON session_summaries(merged_into_project);

-- ─────────────────────────────────────────────────────────────────────
-- pending_messages: persistent work queue for SDK messages.
-- worker_pid + UNIQUE(content_session_id, tool_use_id) make the claim
-- query self-healing without any legacy stale-reset epoch column.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_messages (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id            INTEGER NOT NULL,
  content_session_id       TEXT    NOT NULL,
  tool_use_id              TEXT,
  message_type             TEXT    NOT NULL
                                   CHECK(message_type IN ('observation', 'summarize')),
  tool_name                TEXT,
  tool_input               TEXT,
  tool_response            TEXT,
  cwd                      TEXT,
  last_user_message        TEXT,
  last_assistant_message   TEXT,
  prompt_number            INTEGER,
  status                   TEXT    NOT NULL DEFAULT 'pending'
                                   CHECK(status IN ('pending', 'processing')),
  created_at_epoch         INTEGER NOT NULL,
  agent_type               TEXT,
  agent_id                 TEXT,
  FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_messages_session        ON pending_messages(session_db_id);
CREATE INDEX IF NOT EXISTS idx_pending_messages_status         ON pending_messages(status);
CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id);
CREATE INDEX IF NOT EXISTS idx_pending_messages_worker_pid     ON pending_messages(worker_pid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
  ON pending_messages(content_session_id, tool_use_id)
  WHERE tool_use_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- user_prompts: per-prompt history (UI + FTS search).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_prompts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT    NOT NULL,
  prompt_number      INTEGER NOT NULL,
  prompt_text        TEXT    NOT NULL,
  created_at         TEXT    NOT NULL,
  created_at_epoch   INTEGER NOT NULL,
  FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_created        ON user_prompts(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number  ON user_prompts(prompt_number);
CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup         ON user_prompts(content_session_id, prompt_number);

-- ─────────────────────────────────────────────────────────────────────
-- observation_feedback: usage-signal tracking for tier routing.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observation_feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id   INTEGER NOT NULL,
  signal_type      TEXT    NOT NULL,
  session_db_id    INTEGER,
  created_at_epoch INTEGER NOT NULL,
  metadata         TEXT,
  FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id);
CREATE INDEX IF NOT EXISTS idx_feedback_signal      ON observation_feedback(signal_type);
