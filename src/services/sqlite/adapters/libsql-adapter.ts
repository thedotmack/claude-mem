/**
 * libSQL adapter implementation
 *
 * Wraps @libsql/client to implement the DbAdapter interface.
 * Supports three modes:
 *   - local:   file:~/.claude-mem/claude-mem.db (identical to current bun:sqlite behavior)
 *   - remote:  libsql://team-server.example.com (shared sqld instance)
 *   - replica: local file + background sync to remote (fast reads, shared state)
 */

import { createClient, type Client, type ResultSet, type InStatement } from '@libsql/client';
import type { DbAdapter, ExecResult } from '../adapter.js';
import { DB_PATH, USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { logger } from '../../../utils/logger.js';

/**
 * PRAGMAs that only apply to local/replica mode (skipped for remote connections)
 */
const LOCAL_ONLY_PRAGMAS = new Set([
  'mmap_size',
  'cache_size',
  'temp_store',
  'journal_mode',
  'synchronous',
]);

/**
 * Check if a SQL statement is a local-only PRAGMA
 */
function isLocalOnlyPragma(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith('pragma')) return false;
  for (const pragma of LOCAL_ONLY_PRAGMAS) {
    if (trimmed.includes(pragma)) return true;
  }
  return false;
}

/**
 * Convert a libSQL ResultSet to our ExecResult format
 */
function toExecResult(rs: ResultSet): ExecResult {
  const rows: Record<string, unknown>[] = [];
  for (const row of rs.rows) {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < rs.columns.length; i++) {
      record[rs.columns[i]] = row[i];
    }
    rows.push(record);
  }
  return {
    rows,
    rowsAffected: rs.rowsAffected,
    lastInsertRowid: Number(rs.lastInsertRowid ?? 0),
  };
}

/**
 * Split a multi-statement SQL string on semicolons.
 * Filters out empty/whitespace-only statements.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

export class LibsqlAdapter implements DbAdapter {
  private isRemote: boolean;

  constructor(
    private client: Client,
    isRemote: boolean = false
  ) {
    this.isRemote = isRemote;
  }

  async execute(sql: string, args?: unknown[]): Promise<ExecResult> {
    // Skip local-only PRAGMAs in remote mode
    if (this.isRemote && isLocalOnlyPragma(sql)) {
      return { rows: [], rowsAffected: 0, lastInsertRowid: 0 };
    }

    const rs = await this.client.execute({
      sql,
      args: (args ?? []) as any,
    });
    return toExecResult(rs);
  }

  async batch(stmts: Array<{ sql: string; args?: unknown[] }>): Promise<ExecResult[]> {
    const libsqlStmts: InStatement[] = stmts.map(s => ({
      sql: s.sql,
      args: (s.args ?? []) as any,
    }));
    const results = await this.client.batch(libsqlStmts, 'write');
    return results.map(toExecResult);
  }

  async executeScript(sql: string): Promise<void> {
    const stmts = splitStatements(sql);
    if (stmts.length === 0) return;

    // Use batch for atomic multi-statement execution
    const libsqlStmts: InStatement[] = stmts
      .filter(s => !(this.isRemote && isLocalOnlyPragma(s)))
      .map(s => ({ sql: s, args: [] }));

    if (libsqlStmts.length > 0) {
      await this.client.batch(libsqlStmts, 'write');
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

/**
 * Create a DbAdapter based on settings.
 *
 * Mode is determined by CLAUDE_MEM_DB_MODE setting:
 *   - 'local' (default): file-based SQLite at dbPath
 *   - 'remote': connects to a libsql:// URL
 *   - 'replica': local file + background sync to remote
 */
export async function createDbAdapter(dbPath: string = DB_PATH): Promise<DbAdapter> {
  const mode = getDbMode();

  if (mode === 'remote') {
    logger.info('Creating remote libSQL adapter');
    const client = createClient({
      url: getDbUrl(),
      authToken: getAuthToken() || undefined,
    });
    return new LibsqlAdapter(client, true);
  }

  if (mode === 'replica') {
    logger.info('Creating replica libSQL adapter', { dbPath });
    const client = createClient({
      url: `file:${dbPath}`,
      syncUrl: getDbUrl(),
      authToken: getAuthToken() || undefined,
    });
    return new LibsqlAdapter(client, false);
  }

  // Default: local
  logger.debug('Creating local libSQL adapter', { dbPath });
  const client = createClient({
    url: `file:${dbPath}`,
  });
  return new LibsqlAdapter(client, false);
}

// ─── Settings helpers ──────────────────────────────────────

function getSettings() {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
}

function getDbMode(): string {
  return getSettings().CLAUDE_MEM_DB_MODE;
}

function getDbUrl(): string {
  const url = getSettings().CLAUDE_MEM_DB_URL;
  if (!url) {
    throw new Error('CLAUDE_MEM_DB_URL must be set for remote/replica database mode');
  }
  return url;
}

function getAuthToken(): string {
  return getSettings().CLAUDE_MEM_DB_AUTH_TOKEN;
}
