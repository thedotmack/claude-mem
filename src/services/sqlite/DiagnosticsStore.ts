import { Database } from 'better-sqlite3';
import { getDatabase } from './Database.js';
import { DiagnosticRow, DiagnosticInput, normalizeTimestamp } from './types.js';

/**
 * Data Access Object for diagnostic records
 */
export class DiagnosticsStore {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db || getDatabase();
  }

  /**
   * Create a new diagnostic record
   */
  create(input: DiagnosticInput): DiagnosticRow {
    const { isoString, epoch } = normalizeTimestamp(input.created_at);
    
    const stmt = this.db.prepare(`
      INSERT INTO diagnostics (
        session_id, message, severity, created_at, created_at_epoch, project, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      input.session_id || null,
      input.message,
      input.severity || 'warn',
      isoString,
      epoch,
      input.project,
      input.origin || 'compressor'
    );

    return this.getById(info.lastInsertRowid as number)!;
  }

  /**
   * Get diagnostic by primary key
   */
  getById(id: number): DiagnosticRow | null {
    const stmt = this.db.prepare('SELECT * FROM diagnostics WHERE id = ?');
    return stmt.get(id) as DiagnosticRow || null;
  }

  /**
   * Get diagnostics for a specific session
   */
  getBySessionId(sessionId: string): DiagnosticRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM diagnostics 
      WHERE session_id = ? 
      ORDER BY created_at_epoch DESC
    `);
    return stmt.all(sessionId) as DiagnosticRow[];
  }

  /**
   * Get recent diagnostics for a project
   */
  getRecentForProject(project: string, limit = 10): DiagnosticRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM diagnostics 
      WHERE project = ?
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(project, limit) as DiagnosticRow[];
  }

  /**
   * Get recent diagnostics across all projects
   */
  getRecent(limit = 10): DiagnosticRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM diagnostics 
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(limit) as DiagnosticRow[];
  }

  /**
   * Get diagnostics by severity level
   */
  getBySeverity(severity: 'info' | 'warn' | 'error', limit?: number): DiagnosticRow[] {
    const query = limit 
      ? 'SELECT * FROM diagnostics WHERE severity = ? ORDER BY created_at_epoch DESC LIMIT ?'
      : 'SELECT * FROM diagnostics WHERE severity = ? ORDER BY created_at_epoch DESC';
    
    const stmt = this.db.prepare(query);
    const params = limit ? [severity, limit] : [severity];
    return stmt.all(...params) as DiagnosticRow[];
  }

  /**
   * Get diagnostics by origin
   */
  getByOrigin(origin: string, limit?: number): DiagnosticRow[] {
    const query = limit 
      ? 'SELECT * FROM diagnostics WHERE origin = ? ORDER BY created_at_epoch DESC LIMIT ?'
      : 'SELECT * FROM diagnostics WHERE origin = ? ORDER BY created_at_epoch DESC';
    
    const stmt = this.db.prepare(query);
    const params = limit ? [origin, limit] : [origin];
    return stmt.all(...params) as DiagnosticRow[];
  }

  /**
   * Search diagnostics by message content
   */
  searchByMessage(query: string, project?: string, limit = 20): DiagnosticRow[] {
    let sql = 'SELECT * FROM diagnostics WHERE message LIKE ?';
    const params: any[] = [`%${query}%`];
    
    if (project) {
      sql += ' AND project = ?';
      params.push(project);
    }
    
    sql += ' ORDER BY created_at_epoch DESC LIMIT ?';
    params.push(limit);
    
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as DiagnosticRow[];
  }

  /**
   * Count total diagnostics
   */
  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM diagnostics');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Count diagnostics by project
   */
  countByProject(project: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM diagnostics WHERE project = ?');
    const result = stmt.get(project) as { count: number };
    return result.count;
  }

  /**
   * Count diagnostics by severity
   */
  countBySeverity(severity: 'info' | 'warn' | 'error'): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM diagnostics WHERE severity = ?');
    const result = stmt.get(severity) as { count: number };
    return result.count;
  }

  /**
   * Update a diagnostic record
   */
  update(id: number, input: Partial<DiagnosticInput>): DiagnosticRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Diagnostic with id ${id} not found`);
    }

    const { isoString, epoch } = normalizeTimestamp(input.created_at || existing.created_at);
    
    const stmt = this.db.prepare(`
      UPDATE diagnostics SET
        message = ?, severity = ?, created_at = ?, created_at_epoch = ?, project = ?, origin = ?
      WHERE id = ?
    `);

    stmt.run(
      input.message || existing.message,
      input.severity || existing.severity,
      isoString,
      epoch,
      input.project || existing.project,
      input.origin || existing.origin,
      id
    );

    return this.getById(id)!;
  }

  /**
   * Delete a diagnostic by ID
   */
  deleteById(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM diagnostics WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }

  /**
   * Delete diagnostics by session_id
   */
  deleteBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM diagnostics WHERE session_id = ?');
    const info = stmt.run(sessionId);
    return info.changes;
  }

  /**
   * Get unique projects from diagnostics
   */
  getUniqueProjects(): string[] {
    const stmt = this.db.prepare('SELECT DISTINCT project FROM diagnostics ORDER BY project');
    const rows = stmt.all() as { project: string }[];
    return rows.map(row => row.project);
  }

  /**
   * Get diagnostic summary stats
   */
  getStats(): { total: number; info: number; warn: number; error: number } {
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN severity = 'info' THEN 1 END) as info,
        COUNT(CASE WHEN severity = 'warn' THEN 1 END) as warn,
        COUNT(CASE WHEN severity = 'error' THEN 1 END) as error
      FROM diagnostics
    `);
    
    return stmt.get() as { total: number; info: number; warn: number; error: number };
  }
}