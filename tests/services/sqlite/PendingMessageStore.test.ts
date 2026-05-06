import { describe, test, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';

function getColumnNames(db: Database, table: string): string[] {
  const quotedTable = `"${table.replace(/"/g, '""')}"`;
  return (db.prepare(`PRAGMA table_info(${quotedTable})`).all() as { name: string }[])
    .map(column => column.name);
}

function getIndexNames(db: Database, table: string): string[] {
  const quotedTable = `"${table.replace(/"/g, '""')}"`;
  return (db.prepare(`PRAGMA index_list(${quotedTable})`).all() as { name: string }[])
    .map(index => index.name);
}

function rebuildPendingMessagesWithoutToolUseId(db: Database): void {
  db.run('DROP INDEX IF EXISTS ux_pending_session_tool');
  db.run('DROP INDEX IF EXISTS idx_pending_messages_worker_pid');
  db.run('DROP TABLE IF EXISTS pending_messages_without_tool_use_id');
  db.run(`
    CREATE TABLE pending_messages_without_tool_use_id (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
      created_at_epoch INTEGER NOT NULL,
      agent_type TEXT,
      agent_id TEXT,
      FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    INSERT INTO pending_messages_without_tool_use_id (
      id, session_db_id, content_session_id, message_type, tool_name,
      tool_input, tool_response, cwd, last_user_message,
      last_assistant_message, prompt_number, status, created_at_epoch,
      agent_type, agent_id
    )
    SELECT
      id, session_db_id, content_session_id, message_type, tool_name,
      tool_input, tool_response, cwd, last_user_message,
      last_assistant_message, prompt_number, status, created_at_epoch,
      agent_type, agent_id
    FROM pending_messages
  `);
  db.run('DROP TABLE pending_messages');
  db.run('ALTER TABLE pending_messages_without_tool_use_id RENAME TO pending_messages');
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');
}

function rebuildLegacyPendingMessagesWithDeadColumns(db: Database): void {
  db.run('DROP INDEX IF EXISTS ux_pending_session_tool');
  db.run('DROP INDEX IF EXISTS idx_pending_messages_worker_pid');
  db.run('DROP TABLE pending_messages');
  db.run(`
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      failed_at_epoch INTEGER,
      completed_at_epoch INTEGER,
      created_at_epoch INTEGER NOT NULL,
      agent_type TEXT,
      agent_id TEXT,
      tool_use_id TEXT,
      worker_pid INTEGER,
      FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_pending_messages_worker_pid ON pending_messages(worker_pid)');
}

function createPendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    type: 'observation',
    tool_name: 'TestTool',
    tool_input: { test: 'input' },
    tool_response: { test: 'response' },
    prompt_number: 1,
    ...overrides,
  };
}

describe('PendingMessageStore current schema guardrails', () => {
  test('SessionStore repairs missing tool_use_id even when schema_versions says pending migrations already ran', () => {
    const initialStore = new SessionStore(':memory:');
    const db = initialStore.db;
    rebuildPendingMessagesWithoutToolUseId(db);

    const repairedStore = new SessionStore(db);
    try {
      const columns = getColumnNames(db, 'pending_messages');
      expect(columns).toContain('tool_use_id');
      expect(columns).not.toContain('worker_pid');

      const sessionDbId = repairedStore.createSDKSession('content-shape-repair', 'test-project', 'initial prompt');
      const pendingStore = new PendingMessageStore(db, () => {});

      pendingStore.enqueue(sessionDbId, 'content-shape-repair', createPendingMessage({ toolUseId: 'tool-1' }));
      pendingStore.enqueue(sessionDbId, 'content-shape-repair', createPendingMessage({ toolUseId: 'tool-1' }));

      const count = db.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_messages
        WHERE content_session_id = ?
      `).get('content-shape-repair') as { count: number };
      expect(count.count).toBe(1);
    } finally {
      repairedStore.close();
    }
  });

  test('SessionStore removes stale duplicate rows before creating the tool_use_id unique index', () => {
    const initialStore = new SessionStore(':memory:');
    const db = initialStore.db;
    const sessionDbId = initialStore.createSDKSession('content-stale-dedupe', 'test-project', 'initial prompt');
    rebuildLegacyPendingMessagesWithDeadColumns(db);
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(32, new Date().toISOString());
    db.prepare(`
      INSERT INTO pending_messages (
        id, session_db_id, content_session_id, message_type, status,
        created_at_epoch, tool_use_id, completed_at_epoch
      )
      VALUES (?, ?, ?, 'observation', ?, ?, ?, ?)
    `).run(1, sessionDbId, 'content-stale-dedupe', 'completed', 1000, 'tool-stale', 1100);
    db.prepare(`
      INSERT INTO pending_messages (
        id, session_db_id, content_session_id, message_type, status,
        created_at_epoch, tool_use_id
      )
      VALUES (?, ?, ?, 'observation', ?, ?, ?)
    `).run(2, sessionDbId, 'content-stale-dedupe', 'pending', 1200, 'tool-stale');

    const repairedStore = new SessionStore(db);
    try {
      const rows = db.prepare(`
        SELECT id, status, tool_use_id
        FROM pending_messages
        WHERE content_session_id = ?
      `).all('content-stale-dedupe') as { id: number; status: string; tool_use_id: string }[];

      expect(rows).toEqual([{ id: 2, status: 'pending', tool_use_id: 'tool-stale' }]);
      expect(getColumnNames(db, 'pending_messages')).not.toContain('completed_at_epoch');
      expect(getColumnNames(db, 'pending_messages')).not.toContain('worker_pid');
      expect(getIndexNames(db, 'pending_messages')).toContain('ux_pending_session_tool');
    } finally {
      repairedStore.close();
    }
  });

  test('SessionStore preserves processing duplicate rows during tool_use_id dedupe', () => {
    const initialStore = new SessionStore(':memory:');
    const db = initialStore.db;
    const sessionDbId = initialStore.createSDKSession('content-processing-dedupe', 'test-project', 'initial prompt');
    rebuildLegacyPendingMessagesWithDeadColumns(db);
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(31, new Date().toISOString());
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(32, new Date().toISOString());
    db.prepare(`
      INSERT INTO pending_messages (
        id, session_db_id, content_session_id, message_type, status,
        created_at_epoch, tool_use_id
      )
      VALUES (?, ?, ?, 'observation', ?, ?, ?)
    `).run(1, sessionDbId, 'content-processing-dedupe', 'pending', 1000, 'tool-in-flight');
    db.prepare(`
      INSERT INTO pending_messages (
        id, session_db_id, content_session_id, message_type, status,
        created_at_epoch, tool_use_id
      )
      VALUES (?, ?, ?, 'observation', ?, ?, ?)
    `).run(2, sessionDbId, 'content-processing-dedupe', 'processing', 1100, 'tool-in-flight');

    const repairedStore = new SessionStore(db);
    try {
      const rows = db.prepare(`
        SELECT id, status, tool_use_id
        FROM pending_messages
        WHERE content_session_id = ?
      `).all('content-processing-dedupe') as { id: number; status: string; tool_use_id: string }[];

      expect(rows).toEqual([{ id: 2, status: 'processing', tool_use_id: 'tool-in-flight' }]);
    } finally {
      repairedStore.close();
    }
  });

  test('SessionStore does not stamp dead-column cleanup when a drop fails', () => {
    const initialStore = new SessionStore(':memory:');
    const db = initialStore.db;
    const sessionDbId = initialStore.createSDKSession('content-drop-failure', 'test-project', 'initial prompt');
    rebuildLegacyPendingMessagesWithDeadColumns(db);
    db.prepare('DELETE FROM schema_versions WHERE version IN (31, 32)').run();
    db.prepare(`
      INSERT INTO pending_messages (
        id, session_db_id, content_session_id, message_type, status,
        created_at_epoch, tool_use_id, completed_at_epoch
      )
      VALUES (?, ?, ?, 'observation', 'completed', ?, ?, ?)
    `).run(1, sessionDbId, 'content-drop-failure', 1000, 'tool-completed', 1100);

    const originalRun = db.run.bind(db);
    (db as any).run = (query: string, ...bindings: unknown[]) => {
      if (query.includes('ALTER TABLE pending_messages DROP COLUMN completed_at_epoch')) {
        throw new Error('simulated drop failure');
      }
      return originalRun(query, ...bindings);
    };

    const repairedStore = new SessionStore(db);
    try {
      const version31 = db
        .prepare('SELECT version FROM schema_versions WHERE version = ?')
        .get(31);

      expect(version31).toBeNull();
      expect(getColumnNames(db, 'pending_messages')).toContain('completed_at_epoch');
      const rowCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_messages
        WHERE content_session_id = ? AND status = 'completed'
      `).get('content-drop-failure') as { count: number };
      expect(rowCount.count).toBe(1);
    } finally {
      (db as any).run = originalRun;
      repairedStore.close();
    }
  });

  test('SessionStore keeps null tool_use_id rows because summaries and legacy rows may not have tool ids', () => {
    const store = new SessionStore(':memory:');
    const db = store.db;
    const sessionDbId = store.createSDKSession('content-null-tool', 'test-project', 'initial prompt');

    try {
      db.prepare(`
        INSERT INTO pending_messages (
          session_db_id, content_session_id, message_type, status, created_at_epoch, tool_use_id
        )
        VALUES (?, ?, 'summarize', 'pending', ?, NULL)
      `).run(sessionDbId, 'content-null-tool', 1000);

      db.prepare(`
        INSERT INTO pending_messages (
          session_db_id, content_session_id, message_type, status, created_at_epoch, tool_use_id
        )
        VALUES (?, ?, 'summarize', 'pending', ?, NULL)
      `).run(sessionDbId, 'content-null-tool', 1001);

      const rows = db.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_messages
        WHERE content_session_id = ? AND tool_use_id IS NULL
      `).get('content-null-tool') as { count: number };

      expect(rows.count).toBe(2);
    } finally {
      store.close();
    }
  });

  test('fresh SessionStore pending_messages shape does not require worker_pid for enqueue and claim', () => {
    const store = new SessionStore(':memory:');
    try {
      const db = store.db;
      const columns = getColumnNames(db, 'pending_messages');
      const indexes = getIndexNames(db, 'pending_messages');

      expect(columns).toContain('tool_use_id');
      expect(columns).not.toContain('worker_pid');
      expect(indexes).not.toContain('idx_pending_messages_worker_pid');

      const sessionDbId = store.createSDKSession('content-claim-current', 'test-project', 'initial prompt');
      const pendingStore = new PendingMessageStore(db, () => {});
      const messageId = pendingStore.enqueue(
        sessionDbId,
        'content-claim-current',
        createPendingMessage({ toolUseId: 'tool-claim' })
      );

      const claimed = pendingStore.claimNextMessage(sessionDbId) as ({ id: number; tool_use_id: string | null } | null);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(messageId);
      expect(claimed!.tool_use_id).toBe('tool-claim');
    } finally {
      store.close();
    }
  });
});
