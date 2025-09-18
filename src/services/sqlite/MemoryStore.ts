import { Database } from 'better-sqlite3';
import { getDatabase } from './Database.js';
import { MemoryRow, MemoryInput, normalizeTimestamp } from './types.js';

/**
 * Data Access Object for memory records
 */
export class MemoryStore {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db || getDatabase();
  }

  /**
   * Create a new memory record
   */
  create(input: MemoryInput): MemoryRow {
    const { isoString, epoch } = normalizeTimestamp(input.created_at);
    
    const stmt = this.db.prepare(`
      INSERT INTO memories (
        session_id, text, document_id, keywords, created_at, created_at_epoch, 
        project, archive_basename, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      input.session_id,
      input.text,
      input.document_id || null,
      input.keywords || null,
      isoString,
      epoch,
      input.project,
      input.archive_basename || null,
      input.origin || 'transcript'
    );

    return this.getById(info.lastInsertRowid as number)!;
  }

  /**
   * Create multiple memory records in a transaction
   */
  createMany(inputs: MemoryInput[]): MemoryRow[] {
    const transaction = this.db.transaction((memories: MemoryInput[]) => {
      const results: MemoryRow[] = [];
      for (const memory of memories) {
        results.push(this.create(memory));
      }
      return results;
    });

    return transaction(inputs);
  }

  /**
   * Get memory by primary key
   */
  getById(id: number): MemoryRow | null {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    return stmt.get(id) as MemoryRow || null;
  }

  /**
   * Get memory by document_id
   */
  getByDocumentId(documentId: string): MemoryRow | null {
    const stmt = this.db.prepare('SELECT * FROM memories WHERE document_id = ?');
    return stmt.get(documentId) as MemoryRow || null;
  }

  /**
   * Check if a document_id already exists
   */
  hasDocumentId(documentId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM memories WHERE document_id = ? LIMIT 1');
    return Boolean(stmt.get(documentId));
  }

  /**
   * Get memories for a specific session
   */
  getBySessionId(sessionId: string): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE session_id = ? 
      ORDER BY created_at_epoch DESC
    `);
    return stmt.all(sessionId) as MemoryRow[];
  }

  /**
   * Get recent memories for a project
   */
  getRecentForProject(project: string, limit = 10): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      WHERE project = ?
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(project, limit) as MemoryRow[];
  }

  /**
   * Get recent memories across all projects
   */
  getRecent(limit = 10): MemoryRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM memories 
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(limit) as MemoryRow[];
  }

  /**
   * Search memories by text content
   */
  searchByText(query: string, project?: string, limit = 20): MemoryRow[] {
    let sql = 'SELECT * FROM memories WHERE text LIKE ?';
    const params: any[] = [`%${query}%`];
    
    if (project) {
      sql += ' AND project = ?';
      params.push(project);
    }
    
    sql += ' ORDER BY created_at_epoch DESC LIMIT ?';
    params.push(limit);
    
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as MemoryRow[];
  }

  /**
   * Search memories by keywords
   */
  searchByKeywords(keywords: string, project?: string, limit = 20): MemoryRow[] {
    let sql = 'SELECT * FROM memories WHERE keywords LIKE ?';
    const params: any[] = [`%${keywords}%`];
    
    if (project) {
      sql += ' AND project = ?';
      params.push(project);
    }
    
    sql += ' ORDER BY created_at_epoch DESC LIMIT ?';
    params.push(limit);
    
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as MemoryRow[];
  }

  /**
   * Get memories by origin type
   */
  getByOrigin(origin: string, limit?: number): MemoryRow[] {
    const query = limit 
      ? 'SELECT * FROM memories WHERE origin = ? ORDER BY created_at_epoch DESC LIMIT ?'
      : 'SELECT * FROM memories WHERE origin = ? ORDER BY created_at_epoch DESC';
    
    const stmt = this.db.prepare(query);
    const params = limit ? [origin, limit] : [origin];
    return stmt.all(...params) as MemoryRow[];
  }

  /**
   * Count total memories
   */
  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM memories');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Count memories by project
   */
  countByProject(project: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM memories WHERE project = ?');
    const result = stmt.get(project) as { count: number };
    return result.count;
  }

  /**
   * Update a memory record
   */
  update(id: number, input: Partial<MemoryInput>): MemoryRow {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Memory with id ${id} not found`);
    }

    const { isoString, epoch } = normalizeTimestamp(input.created_at || existing.created_at);
    
    const stmt = this.db.prepare(`
      UPDATE memories SET
        text = ?, document_id = ?, keywords = ?, created_at = ?, created_at_epoch = ?,
        project = ?, archive_basename = ?, origin = ?
      WHERE id = ?
    `);

    stmt.run(
      input.text || existing.text,
      input.document_id !== undefined ? input.document_id : existing.document_id,
      input.keywords !== undefined ? input.keywords : existing.keywords,
      isoString,
      epoch,
      input.project || existing.project,
      input.archive_basename !== undefined ? input.archive_basename : existing.archive_basename,
      input.origin || existing.origin,
      id
    );

    return this.getById(id)!;
  }

  /**
   * Delete a memory by ID
   */
  deleteById(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const info = stmt.run(id);
    return info.changes > 0;
  }

  /**
   * Delete memories by session_id
   */
  deleteBySessionId(sessionId: string): number {
    const stmt = this.db.prepare('DELETE FROM memories WHERE session_id = ?');
    const info = stmt.run(sessionId);
    return info.changes;
  }

  /**
   * Get unique projects from memories
   */
  getUniqueProjects(): string[] {
    const stmt = this.db.prepare('SELECT DISTINCT project FROM memories ORDER BY project');
    const rows = stmt.all() as { project: string }[];
    return rows.map(row => row.project);
  }
}