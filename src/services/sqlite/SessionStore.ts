import { Database } from 'better-sqlite3';
import { getDatabase } from './Database.js';
import { SessionRow, SessionInput, normalizeTimestamp } from './types.js';

/**
 * Data Access Object for session records
 */
export class SessionStore {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db || getDatabase();
  }

  /**
   * Create a new session record
   */
  create(input: SessionInput): SessionRow {
    const { isoString, epoch } = normalizeTimestamp(input.created_at);
    
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        session_id, project, created_at, created_at_epoch, source,
        archive_path, archive_bytes, archive_checksum, archived_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      input.session_id,
      input.project,
      isoString,
      epoch,
      input.source || 'compress',
      input.archive_path || null,
      input.archive_bytes || null,
      input.archive_checksum || null,
      input.archived_at || null,
      input.metadata_json || null
    );

    return this.getById(info.lastInsertRowid as number)!;
  }

  /**
   * Upsert a session record (insert or update if session_id exists)
   */
  upsert(input: SessionInput): SessionRow {
    const existing = this.getBySessionId(input.session_id);
    if (existing) {
      return this.update(existing.id, input);
    }
    return this.create(input);
  }

  /**
   * Update an existing session record
   */
  update(id: number, input: Partial<SessionInput>): SessionRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Session with id ${id} not found`);
    }

    const { isoString, epoch } = normalizeTimestamp(input.created_at || existing.created_at);
    
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        project = ?, created_at = ?, created_at_epoch = ?, source = ?,
        archive_path = ?, archive_bytes = ?, archive_checksum = ?, archived_at = ?, metadata_json = ?
      WHERE id = ?
    `);

    stmt.run(
      input.project || existing.project,
      isoString,
      epoch,
      input.source || existing.source,
      input.archive_path !== undefined ? input.archive_path : existing.archive_path,
      input.archive_bytes !== undefined ? input.archive_bytes : existing.archive_bytes,
      input.archive_checksum !== undefined ? input.archive_checksum : existing.archive_checksum,
      input.archived_at !== undefined ? input.archived_at : existing.archived_at,
      input.metadata_json !== undefined ? input.metadata_json : existing.metadata_json,
      id
    );

    return this.getById(id)!;
  }

  /**
   * Get session by primary key
   */
  getById(id: number): SessionRow | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(id) as SessionRow || null;
  }

  /**
   * Get session by session_id
   */
  getBySessionId(sessionId: string): SessionRow | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    return stmt.get(sessionId) as SessionRow || null;
  }

  /**
   * Check if a session exists by session_id
   */
  has(sessionId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1');
    return Boolean(stmt.get(sessionId));
  }

  /**
   * Get all session_ids as a Set (useful for import-history)
   */
  getAllSessionIds(): Set<string> {
    const stmt = this.db.prepare('SELECT session_id FROM sessions');
    const rows = stmt.all() as { session_id: string }[];
    return new Set(rows.map(row => row.session_id));
  }

  /**
   * Get recent sessions for a project
   */
  getRecentForProject(project: string, limit = 5): SessionRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions 
      WHERE project = ?
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(project, limit) as SessionRow[];
  }

  /**
   * Get recent sessions across all projects
   */
  getRecent(limit = 5): SessionRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM sessions 
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(limit) as SessionRow[];
  }

  /**
   * Get sessions by source type
   */
  getBySource(source: 'compress' | 'save' | 'legacy-jsonl', limit?: number): SessionRow[] {
    const query = limit 
      ? 'SELECT * FROM sessions WHERE source = ? ORDER BY created_at_epoch DESC LIMIT ?'
      : 'SELECT * FROM sessions WHERE source = ? ORDER BY created_at_epoch DESC';
    
    const stmt = this.db.prepare(query);
    const params = limit ? [source, limit] : [source];
    return stmt.all(...params) as SessionRow[];
  }

  /**
   * Count total sessions
   */
  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM sessions');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Count sessions by project
   */
  countByProject(project: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE project = ?');
    const result = stmt.get(project) as { count: number };
    return result.count;
  }

  /**
   * Delete a session by ID (cascades to related records)
   */
  deleteById(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }

  /**
   * Delete a session by session_id (cascades to related records)
   */
  deleteBySessionId(sessionId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE session_id = ?');
    const info = stmt.run(sessionId);
    return info.changes > 0;
  }
}