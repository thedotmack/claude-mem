import { Database } from 'better-sqlite3';
import { getDatabase } from './Database.js';
import { OverviewRow, OverviewInput, normalizeTimestamp } from './types.js';

/**
 * Data Access Object for overview records
 */
export class OverviewStore {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db || getDatabase();
  }

  /**
   * Create a new overview record
   */
  create(input: OverviewInput): OverviewRow {
    const { isoString, epoch } = normalizeTimestamp(input.created_at);
    
    const stmt = this.db.prepare(`
      INSERT INTO overviews (
        session_id, content, created_at, created_at_epoch, project, origin
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      input.session_id,
      input.content,
      isoString,
      epoch,
      input.project,
      input.origin || 'claude'
    );

    return this.getById(info.lastInsertRowid as number)!;
  }

  /**
   * Create or replace an overview for a session (since one session should have one overview)
   */
  upsert(input: OverviewInput): OverviewRow {
    const existing = this.getBySessionId(input.session_id);
    if (existing) {
      return this.update(existing.id, input);
    }
    return this.create(input);
  }

  /**
   * Get overview by primary key
   */
  getById(id: number): OverviewRow | null {
    const stmt = this.db.prepare('SELECT * FROM overviews WHERE id = ?');
    return stmt.get(id) as OverviewRow || null;
  }

  /**
   * Get overview by session_id
   */
  getBySessionId(sessionId: string): OverviewRow | null {
    const stmt = this.db.prepare('SELECT * FROM overviews WHERE session_id = ?');
    return stmt.get(sessionId) as OverviewRow || null;
  }

  /**
   * Get recent overviews for a project
   */
  getRecentForProject(project: string, limit = 5): OverviewRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM overviews 
      WHERE project = ?
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(project, limit) as OverviewRow[];
  }

  /**
   * Get recent overviews across all projects
   */
  getRecent(limit = 5): OverviewRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM overviews 
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(limit) as OverviewRow[];
  }

  /**
   * Search overviews by content
   */
  searchByContent(query: string, project?: string, limit = 10): OverviewRow[] {
    let sql = 'SELECT * FROM overviews WHERE content LIKE ?';
    const params: any[] = [`%${query}%`];
    
    if (project) {
      sql += ' AND project = ?';
      params.push(project);
    }
    
    sql += ' ORDER BY created_at_epoch DESC LIMIT ?';
    params.push(limit);
    
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as OverviewRow[];
  }

  /**
   * Get overviews by origin type
   */
  getByOrigin(origin: string, limit?: number): OverviewRow[] {
    const query = limit 
      ? 'SELECT * FROM overviews WHERE origin = ? ORDER BY created_at_epoch DESC LIMIT ?'
      : 'SELECT * FROM overviews WHERE origin = ? ORDER BY created_at_epoch DESC';
    
    const stmt = this.db.prepare(query);
    const params = limit ? [origin, limit] : [origin];
    return stmt.all(...params) as OverviewRow[];
  }

  /**
   * Count total overviews
   */
  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM overviews');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Count overviews by project
   */
  countByProject(project: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM overviews WHERE project = ?');
    const result = stmt.get(project) as { count: number };
    return result.count;
  }

  /**
   * Update an overview record
   */
  update(id: number, input: Partial<OverviewInput>): OverviewRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Overview with id ${id} not found`);
    }

    const { isoString, epoch } = normalizeTimestamp(input.created_at || existing.created_at);
    
    const stmt = this.db.prepare(`
      UPDATE overviews SET
        content = ?, created_at = ?, created_at_epoch = ?, project = ?, origin = ?
      WHERE id = ?
    `);

    stmt.run(
      input.content || existing.content,
      isoString,
      epoch,
      input.project || existing.project,
      input.origin || existing.origin,
      id
    );

    return this.getById(id)!;
  }

  /**
   * Delete an overview by ID
   */
  deleteById(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM overviews WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }

  /**
   * Delete overview by session_id
   */
  deleteBySessionId(sessionId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM overviews WHERE session_id = ?');
    const info = stmt.run(sessionId);
    return info.changes > 0;
  }

  /**
   * Get unique projects from overviews
   */
  getUniqueProjects(): string[] {
    const stmt = this.db.prepare('SELECT DISTINCT project FROM overviews ORDER BY project');
    const rows = stmt.all() as { project: string }[];
    return rows.map(row => row.project);
  }
}