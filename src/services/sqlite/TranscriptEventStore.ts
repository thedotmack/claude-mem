import { Database } from 'bun:sqlite';
import { getDatabase } from './Database.js';
import {
  TranscriptEventInput,
  TranscriptEventRow,
  normalizeTimestamp
} from './types.js';

/**
 * Data access for transcript_events table
 */
export class TranscriptEventStore {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db || getDatabase();
  }

  /**
   * Insert or update a transcript event
   */
  upsert(event: TranscriptEventInput): TranscriptEventRow {
    const { isoString, epoch } = normalizeTimestamp(event.captured_at);

    const stmt = this.db.query(`
      INSERT INTO transcript_events (
        session_id,
        project,
        event_index,
        event_type,
        raw_json,
        captured_at,
        captured_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, event_index) DO UPDATE SET
        project = excluded.project,
        event_type = excluded.event_type,
        raw_json = excluded.raw_json,
        captured_at = excluded.captured_at,
        captured_at_epoch = excluded.captured_at_epoch
    `);

    stmt.run(
      event.session_id,
      event.project || null,
      event.event_index,
      event.event_type || null,
      event.raw_json,
      isoString,
      epoch
    );

    return this.getBySessionAndIndex(event.session_id, event.event_index)!;
  }

  /**
   * Bulk upsert events in a single transaction
   */
  upsertMany(events: TranscriptEventInput[]): TranscriptEventRow[] {
    const transaction = this.db.transaction((rows: TranscriptEventInput[]) => {
      const results: TranscriptEventRow[] = [];
      for (const row of rows) {
        results.push(this.upsert(row));
      }
      return results;
    });

    return transaction(events);
  }

  /**
   * Get event by session and index
   */
  getBySessionAndIndex(sessionId: string, eventIndex: number): TranscriptEventRow | null {
    const stmt = this.db.query(`
      SELECT * FROM transcript_events
      WHERE session_id = ? AND event_index = ?
    `);
    return stmt.get(sessionId, eventIndex) as TranscriptEventRow | null;
  }

  /**
   * Get highest event_index stored for a session
   */
  getMaxEventIndex(sessionId: string): number {
    const stmt = this.db.query(`
      SELECT MAX(event_index) as max_event_index
      FROM transcript_events
      WHERE session_id = ?
    `);
    const row = stmt.get(sessionId) as { max_event_index: number | null } | undefined;
    return row?.max_event_index ?? -1;
  }

  /**
   * List recent events for a session
   */
  listBySession(sessionId: string, limit = 200, offset = 0): TranscriptEventRow[] {
    const stmt = this.db.query(`
      SELECT * FROM transcript_events
      WHERE session_id = ?
      ORDER BY event_index ASC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sessionId, limit, offset) as TranscriptEventRow[];
  }
}
