import type { Database } from 'bun:sqlite';

// Separate from observer processing: these rows retain assets and clean files,
// never replay the former pending_messages generation queue. The cleanup job
// is queued before the tombstone in the same statement batch/transaction, so
// metadata never disappears without durable file cleanup. Only unreferenced
// rows are tombstoned: a still-referenced failed conversion whose temporary
// files are being cleaned remains retryable.
//
// Every caller scopes the work to the attachments the deleted row actually
// referenced (indexed lookups), instead of scanning every attachment. The
// queue runs before the caller removes those references, so each caller names
// the references it is about to remove and they are ignored here.
interface UnreferencedAttachmentScope {
  /** Subquery selecting the attachment IDs the deleted row referenced. */
  candidateAttachmentIdsSql: string;
  /** Condition on `r` (media_event_refs) matching refs being removed in the same batch. */
  eventRefsBeingRemovedSql: string;
  /** Condition on `l` (observation_media_links) matching links being removed in the same batch. */
  observationLinksBeingRemovedSql: string;
}

function queueCleanupForUnreferencedAttachmentsSql(scope: UnreferencedAttachmentScope): string[] {
  const unreferencedCandidate = `a.id IN (${scope.candidateAttachmentIdsSql})
      AND a.state!='deleted'
      AND NOT EXISTS (SELECT 1 FROM media_event_refs r
        WHERE r.attachment_id=a.id AND NOT (${scope.eventRefsBeingRemovedSql}))
      AND NOT EXISTS (SELECT 1 FROM observation_media_links l
        WHERE l.attachment_id=a.id AND NOT (${scope.observationLinksBeingRemovedSql}))`;
  return [
    `INSERT OR IGNORE INTO media_cleanup_jobs (attachment_id, directory, queued_at)
      SELECT a.id, a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${unreferencedCandidate}`,
    // v63: an attachment that already reached the owner's cloud media plane
    // gets a durable cloud deletion. Any attempted native upload counts too,
    // whatever its current state (pending, failed): its response may have been
    // lost after the cloud committed it. Queued before
    // upload_state is overwritten below; replica rows are never attempted or
    // 'uploaded', so a replica deletion never deletes the owner's cloud copy.
    `INSERT OR IGNORE INTO media_cloud_deletions (attachment_id, queued_at)
      SELECT a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${unreferencedCandidate}
        AND a.origin='native' AND (a.upload_state='uploaded' OR a.upload_attempts>0)`,
    `UPDATE media_attachments SET state='deleted', upload_state='cancelled'
      WHERE id IN (SELECT a.id FROM media_attachments a WHERE ${unreferencedCandidate})`,
  ];
}

const SESSION_EVENT_KEYS_SQL = 'SELECT event_key FROM media_events WHERE session_db_id=OLD.id';

const QUEUE_CLEANUP_FOR_DELETED_OBSERVATION = queueCleanupForUnreferencedAttachmentsSql({
  candidateAttachmentIdsSql: 'SELECT attachment_id FROM observation_media_links WHERE observation_id=OLD.id',
  eventRefsBeingRemovedSql: '0',
  observationLinksBeingRemovedSql: 'l.observation_id=OLD.id',
});

const QUEUE_CLEANUP_FOR_DELETED_SESSION = queueCleanupForUnreferencedAttachmentsSql({
  candidateAttachmentIdsSql: `SELECT attachment_id FROM media_event_refs WHERE event_key IN (${SESSION_EVENT_KEYS_SQL})`,
  eventRefsBeingRemovedSql: `r.event_key IN (${SESSION_EVENT_KEYS_SQL})`,
  observationLinksBeingRemovedSql: '0',
});

const QUEUE_CLEANUP_FOR_DELETED_EVENT = queueCleanupForUnreferencedAttachmentsSql({
  candidateAttachmentIdsSql: 'SELECT attachment_id FROM media_event_refs WHERE event_key=$eventKey',
  eventRefsBeingRemovedSql: 'r.event_key=$eventKey',
  observationLinksBeingRemovedSql: '0',
});

export function ensureMediaSchema(db: Database): void {
  // Same transactional version bookkeeping as SessionStore v60.
  // https://bun.com/docs/runtime/sqlite#transactions
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_events (
        event_key TEXT PRIMARY KEY, session_db_id INTEGER NOT NULL,
        platform TEXT NOT NULL, event_identity TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'retained' CHECK(state IN ('retained','deleted')),
        result_state TEXT NOT NULL DEFAULT 'unprocessed' CHECK(result_state IN ('unprocessed','stored','skipped')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_events_session ON media_events(session_db_id);
      CREATE TABLE IF NOT EXISTS media_attachments (
        id TEXT PRIMARY KEY, replay_key TEXT NOT NULL UNIQUE, provenance TEXT NOT NULL,
        recipe TEXT NOT NULL CHECK(recipe IN ('screenshot-v1','photo-v1')),
        state TEXT NOT NULL CHECK(state IN ('converting','ready','failed','deleted')),
        failure_code TEXT, encoder_version TEXT, variants TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        upload_state TEXT NOT NULL DEFAULT 'pending' CHECK(upload_state IN ('pending','uploaded','failed','cancelled')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_event_refs (
        event_key TEXT NOT NULL, attachment_id TEXT NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY(event_key,attachment_id), UNIQUE(event_key,label),
        FOREIGN KEY(event_key) REFERENCES media_events(event_key),
        FOREIGN KEY(attachment_id) REFERENCES media_attachments(id)
      );
      CREATE TABLE IF NOT EXISTS observation_media_links (
        observation_id INTEGER NOT NULL, attachment_id TEXT NOT NULL, event_key TEXT NOT NULL,
        label TEXT NOT NULL, inspection TEXT NOT NULL DEFAULT 'uninspected'
          CHECK(inspection IN ('inspected','uninspected')),
        PRIMARY KEY(observation_id,attachment_id),
        FOREIGN KEY(attachment_id) REFERENCES media_attachments(id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_links_attachment ON observation_media_links(attachment_id);
      CREATE TABLE IF NOT EXISTS media_cleanup_jobs (
        attachment_id TEXT PRIMARY KEY, directory TEXT NOT NULL,
        queued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_media_event_refs_attachment ON media_event_refs(attachment_id);
      -- v62: durable source-event -> observation result mapping, written in the
      -- storeObservations transaction so a replayed event recovers its committed
      -- result without another model call.
      CREATE TABLE IF NOT EXISTS media_event_results (
        event_key TEXT NOT NULL, observation_id INTEGER NOT NULL,
        PRIMARY KEY(event_key, observation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_event_results_observation ON media_event_results(observation_id);
      -- v63: durable cloud media deletions (offline-safe). Drained by
      -- MediaCloudSync; a row survives restarts and reconnects.
      CREATE TABLE IF NOT EXISTS media_cloud_deletions (
        attachment_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `);
    // v63 columns, added in place (ADD COLUMN keeps the v61 CHECKs intact):
    // origin separates native captures from lazily resolved replicas (which
    // are never uploaded), and the upload retry state is independent of the
    // native text sync outbox.
    addMediaAttachmentColumn(db, 'origin', `TEXT NOT NULL DEFAULT 'native'`);
    addMediaAttachmentColumn(db, 'upload_attempts', 'INTEGER NOT NULL DEFAULT 0');
    addMediaAttachmentColumn(db, 'upload_retry_at', 'INTEGER NOT NULL DEFAULT 0');
    addMediaAttachmentColumn(db, 'upload_error', 'TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_media_attachments_upload ON media_attachments(upload_state, upload_retry_at)`);
    // Triggers come after the v63 columns they reference.
    db.exec(`
      -- Recreated every startup so an older trigger definition never lingers.
      DROP TRIGGER IF EXISTS media_observation_delete;
      CREATE TRIGGER media_observation_delete AFTER DELETE ON observations BEGIN
        ${QUEUE_CLEANUP_FOR_DELETED_OBSERVATION.join(';\n        ')};
        DELETE FROM observation_media_links WHERE observation_id=OLD.id;
        DELETE FROM media_event_results WHERE observation_id=OLD.id;
      END;
      DROP TRIGGER IF EXISTS media_session_delete;
      CREATE TRIGGER media_session_delete BEFORE DELETE ON sdk_sessions BEGIN
        ${QUEUE_CLEANUP_FOR_DELETED_SESSION.join(';\n        ')};
        DELETE FROM media_event_refs WHERE event_key IN (${SESSION_EVENT_KEYS_SQL});
        DELETE FROM media_event_results WHERE event_key IN (${SESSION_EVENT_KEYS_SQL});
        UPDATE media_events SET state='deleted' WHERE session_db_id=OLD.id;
      END;
    `);
    const appliedAt = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(61, appliedAt);
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(62, appliedAt);
    db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)').run(63, appliedAt);
  })();
}

function addMediaAttachmentColumn(db: Database, columnName: string, columnDefinition: string): void {
  const columns = db.prepare('PRAGMA table_info(media_attachments)').all() as Array<{ name: string }>;
  if (columns.some(column => column.name === columnName)) return;
  db.exec(`ALTER TABLE media_attachments ADD COLUMN ${columnName} ${columnDefinition}`);
}

/** Run inside the caller's transaction, before the event's refs are deleted. */
export function queueCleanupForDeletedEvent(db: Database, eventKey: string): void {
  for (const statement of QUEUE_CLEANUP_FOR_DELETED_EVENT) db.prepare(statement).run({ $eventKey: eventKey });
}
