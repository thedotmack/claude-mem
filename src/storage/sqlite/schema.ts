// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';

export const SERVER_STORAGE_SCHEMA_VERSION = 33;

export const SERVER_OWNED_TABLES = [
  'projects',
  'server_sessions',
  'agent_events',
  'memory_items',
  'memory_sources',
  'teams',
  'team_members',
  'api_keys',
  'audit_log'
] as const;

const initializedDatabases = new WeakSet<Database>();

export function ensureServerStorageSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      root_path TEXT UNIQUE,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,
      UNIQUE(team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS server_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content_session_id TEXT,
      memory_session_id TEXT,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
      metadata TEXT NOT NULL DEFAULT '{}',
      started_at_epoch INTEGER NOT NULL,
      completed_at_epoch INTEGER,
      updated_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      server_session_id TEXT,
      source_type TEXT NOT NULL CHECK(source_type IN ('hook', 'worker', 'provider', 'server', 'api')),
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      content_session_id TEXT,
      memory_session_id TEXT,
      occurred_at_epoch INTEGER NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(server_session_id) REFERENCES server_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      server_session_id TEXT,
      legacy_observation_id INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('observation', 'summary', 'prompt', 'manual')),
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      text TEXT,
      narrative TEXT,
      facts TEXT NOT NULL DEFAULT '[]',
      concepts TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(server_session_id) REFERENCES server_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('observation', 'session_summary', 'user_prompt', 'manual', 'import')),
      legacy_table TEXT,
      legacy_id INTEGER,
      source_uri TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      project_id TEXT,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
      last_used_at_epoch INTEGER,
      expires_at_epoch INTEGER,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      updated_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      project_id TEXT,
      actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'api_key', 'system')),
      actor_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at_epoch INTEGER NOT NULL,
      FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE SET NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_projects_root_path ON projects(root_path)');
  db.run('CREATE INDEX IF NOT EXISTS idx_server_sessions_project ON server_sessions(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_server_sessions_content ON server_sessions(content_session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_server_sessions_memory ON server_sessions(memory_session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_server_sessions_status ON server_sessions(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_events_project_time ON agent_events(project_id, occurred_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_events_session_time ON agent_events(server_session_id, occurred_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_items_project_time ON memory_items(project_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_items_session_time ON memory_items(server_session_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_items_legacy_observation ON memory_items(legacy_observation_id)');
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_items_legacy_observation
    ON memory_items(legacy_observation_id)
    WHERE legacy_observation_id IS NOT NULL
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_items_kind_type ON memory_items(kind, type)');
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
      memory_item_id UNINDEXED,
      project_id UNINDEXED,
      title,
      subtitle,
      text,
      narrative,
      facts,
      concepts,
      tokenize='porter unicode61'
    )
  `);
  const memoryItemCount = db.prepare('SELECT COUNT(*) AS count FROM memory_items').get() as { count: number };
  const ftsItemCount = db.prepare('SELECT COUNT(*) AS count FROM memory_items_fts').get() as { count: number };
  if (memoryItemCount.count !== ftsItemCount.count) {
    const rebuildMemoryItemsFts = db.transaction(() => {
      db.run('DELETE FROM memory_items_fts');
      db.run(`
        INSERT INTO memory_items_fts (
          memory_item_id, project_id, title, subtitle, text, narrative, facts, concepts
        )
        SELECT id, project_id, title, subtitle, text, narrative, facts, concepts
        FROM memory_items
      `);
    });
    rebuildMemoryItemsFts();
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_sources_item ON memory_sources(memory_item_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_sources_legacy ON memory_sources(legacy_table, legacy_id)');
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_sources_legacy_source
    ON memory_sources(source_type, legacy_table, legacy_id)
    WHERE legacy_table IS NOT NULL AND legacy_id IS NOT NULL
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_team ON api_keys(team_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_team_time ON audit_log(team_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_project_time ON audit_log(project_id, created_at_epoch DESC)');
  db.run('CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_type, actor_id)');

  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_server_sessions_project_update
    BEFORE UPDATE OF project_id ON server_sessions
    WHEN EXISTS (
      SELECT 1 FROM agent_events
      WHERE server_session_id = OLD.id AND project_id <> NEW.project_id
    )
    OR EXISTS (
      SELECT 1 FROM memory_items
      WHERE server_session_id = OLD.id AND project_id <> NEW.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'server_sessions project_id cannot change while children belong to the previous project');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_agent_events_session_project_insert
    BEFORE INSERT ON agent_events
    WHEN NEW.server_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM server_sessions
        WHERE id = NEW.server_session_id AND project_id = NEW.project_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'agent_events server_session_id must belong to project_id');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_agent_events_session_project_update
    BEFORE UPDATE OF project_id, server_session_id ON agent_events
    WHEN NEW.server_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM server_sessions
        WHERE id = NEW.server_session_id AND project_id = NEW.project_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'agent_events server_session_id must belong to project_id');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memory_items_session_project_insert
    BEFORE INSERT ON memory_items
    WHEN NEW.server_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM server_sessions
        WHERE id = NEW.server_session_id AND project_id = NEW.project_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'memory_items server_session_id must belong to project_id');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memory_items_session_project_update
    BEFORE UPDATE OF project_id, server_session_id ON memory_items
    WHEN NEW.server_session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM server_sessions
        WHERE id = NEW.server_session_id AND project_id = NEW.project_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'memory_items server_session_id must belong to project_id');
    END;
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_insert
    AFTER INSERT ON memory_items
    BEGIN
      INSERT INTO memory_items_fts (
        memory_item_id, project_id, title, subtitle, text, narrative, facts, concepts
      )
      VALUES (
        new.id, new.project_id, new.title, new.subtitle, new.text, new.narrative, new.facts, new.concepts
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_update
    AFTER UPDATE ON memory_items
    BEGIN
      DELETE FROM memory_items_fts WHERE memory_item_id = old.id;
      INSERT INTO memory_items_fts (
        memory_item_id, project_id, title, subtitle, text, narrative, facts, concepts
      )
      VALUES (
        new.id, new.project_id, new.title, new.subtitle, new.text, new.narrative, new.facts, new.concepts
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_memory_items_fts_delete
    AFTER DELETE ON memory_items
    BEGIN
      DELETE FROM memory_items_fts WHERE memory_item_id = old.id;
    END;
  `);

  initializedDatabases.add(db);
}
