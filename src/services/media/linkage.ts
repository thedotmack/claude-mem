import type { Database } from 'bun:sqlite';
import {
  MEDIA_LIMITS,
  MEDIA_MANIFEST_VERSION,
  MEDIA_METADATA_NAMESPACE,
  MediaError,
  validateMediaManifest,
  type MediaAttachmentRef,
  type MediaManifest,
} from '../../shared/media-contract.js';
import { incrementCanonicalDecimal } from '../sync/CanonicalContent.js';
import { logger } from '../../utils/logger.js';

/**
 * metadata.cmem_media_v1 merge and the observation → image link writes
 * (docs/media-contract-v1.md, "Inspection state and manifest updates";
 * fixture manifest-merge.json). Everything here runs inside the caller's
 * storeObservations transaction, before the RAM batch is confirmed.
 */

export interface ManifestMergeResult {
  metadata: Record<string, unknown>;
  manifest: MediaManifest;
  changed: boolean;
  /** Refs that did not fit in the row; they stay on their source event. */
  eventLevel: MediaAttachmentRef[];
}

/** Parse a row's metadata column into an object; anything else fails closed. */
export function parseObservationMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MediaError('invalid_manifest');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MediaError('invalid_manifest');
  return parsed as Record<string, unknown>;
}

/**
 * Union new refs into a row's manifest: existing order first, new refs
 * appended in the given order, inspection is the OR of both sides, at most 32
 * refs; refs that do not fit set overflow:true and stay event-level. An invalid
 * existing namespace throws invalid_manifest and is never overwritten. Every
 * other metadata key is preserved.
 */
export function mergeMediaManifest(existingMetadata: Record<string, unknown>, newRefs: readonly MediaAttachmentRef[]): ManifestMergeResult {
  const existingNamespace = existingMetadata[MEDIA_METADATA_NAMESPACE];
  const existing: MediaManifest = existingNamespace === undefined
    ? { version: MEDIA_MANIFEST_VERSION, attachments: [] }
    : validateMediaManifest(existingNamespace);

  const attachments = existing.attachments.map(ref => ({ ...ref }));
  const eventLevel: MediaAttachmentRef[] = [];
  let changed = existingNamespace === undefined && newRefs.length > 0;
  let overflow = existing.overflow === true;

  for (const ref of newRefs) {
    const present = attachments.find(candidate => candidate.id === ref.id);
    if (present) {
      if (ref.inspection === 'inspected' && present.inspection !== 'inspected') {
        present.inspection = 'inspected';
        changed = true;
      }
      continue;
    }
    if (attachments.length >= MEDIA_LIMITS.maxObservationRefs) {
      eventLevel.push({ ...ref });
      if (!overflow) changed = true;
      overflow = true;
      continue;
    }
    attachments.push({ ...ref });
    changed = true;
  }

  const manifest: MediaManifest = { version: MEDIA_MANIFEST_VERSION, attachments };
  if (overflow || existing.overflow !== undefined) manifest.overflow = overflow;
  // Bound the encoded manifest exactly as the validator does.
  validateMediaManifest(manifest);
  return {
    metadata: changed ? { ...existingMetadata, [MEDIA_METADATA_NAMESPACE]: manifest } : existingMetadata,
    manifest,
    changed,
    eventLevel,
  };
}

/** One observation row's links from one accepted response. */
export interface ObservationLinkWrite {
  observationId: number;
  /** True when this call's storeObservations inserted the row (it has never synced). */
  insertedThisTurn: boolean;
  refs: Array<MediaAttachmentRef & { eventKey: string }>;
}

export interface MediaLinkageWriteResult {
  /** Native rows whose manifest changed; the caller notifies sync after commit. */
  changedNativeRows: number[];
  /** Refs kept at event level because a row was full (overflow) or is a replica. */
  eventLevelRefs: number;
}

interface ObservationRowState {
  metadata: string | null;
  origin_device_id: string | null;
  sync_rev: string;
}

/**
 * Write manifests, junction rows and the durable event result for one turn.
 * Must run inside the transaction that stored the observations. Junction rows
 * exist exactly for the refs in each manifest. Replica rows (origin_device_id
 * set) are never mutated: their refs stay event-level. A native row whose
 * manifest changes gets a higher decimal sync_rev and a cleared synced_at,
 * unless this same transaction inserted it (it has no emitted revision yet).
 */
export function writeObservationMediaLinks(
  db: Database,
  writes: readonly ObservationLinkWrite[],
): MediaLinkageWriteResult {
  const result: MediaLinkageWriteResult = { changedNativeRows: [], eventLevelRefs: 0 };
  const rowStatement = db.prepare('SELECT metadata, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev FROM observations WHERE id = ?');
  const eventRefStatement = db.prepare(`SELECT 1 FROM media_event_refs r JOIN media_events e ON e.event_key = r.event_key
    WHERE r.event_key = ? AND r.attachment_id = ? AND r.label = ? AND e.state = 'retained'`);
  const linkStatement = db.prepare(`INSERT INTO observation_media_links (observation_id, attachment_id, event_key, label, inspection)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(observation_id, attachment_id) DO UPDATE SET
      inspection = CASE WHEN excluded.inspection = 'inspected' THEN 'inspected' ELSE observation_media_links.inspection END`);

  for (const write of writes) {
    const row = rowStatement.get(write.observationId) as ObservationRowState | null;
    if (!row) continue;
    // Only refs still retained on their source event can be linked.
    const refs = write.refs.filter(ref => eventRefStatement.get(ref.eventKey, ref.id, ref.label));
    if (refs.length < write.refs.length) {
      logger.debug('DB', 'Observation media refs dropped: source event no longer retains them', { code: 'media_not_found', dropped: write.refs.length - refs.length });
    }
    if (refs.length === 0) continue;
    if (row.origin_device_id !== null) {
      logger.debug('DB', 'Replica observation row left unchanged; its media refs stay event-level', { code: 'unauthorized_owner', refs: refs.length });
      result.eventLevelRefs += refs.length;
      continue;
    }

    let merged: ManifestMergeResult;
    try {
      merged = mergeMediaManifest(parseObservationMetadata(row.metadata), refs.map(({ id, label, inspection }) => ({ id, label, inspection })));
    } catch (error) {
      const code = error instanceof MediaError ? error.code : 'invalid_manifest';
      logger.warn('DB', 'Observation media manifest left unchanged', { code, observationId: write.observationId });
      continue;
    }
    result.eventLevelRefs += merged.eventLevel.length;

    if (merged.changed) {
      if (write.insertedThisTurn) {
        db.prepare('UPDATE observations SET metadata = ? WHERE id = ? AND origin_device_id IS NULL')
          .run(JSON.stringify(merged.metadata), write.observationId);
      } else {
        db.prepare('UPDATE observations SET metadata = ?, sync_rev = ?, synced_at = NULL WHERE id = ? AND origin_device_id IS NULL')
          .run(JSON.stringify(merged.metadata), incrementCanonicalDecimal(row.sync_rev), write.observationId);
      }
      result.changedNativeRows.push(write.observationId);
    }

    const inManifest = new Map(merged.manifest.attachments.map(ref => [ref.id, ref]));
    for (const ref of refs) {
      const manifestRef = inManifest.get(ref.id);
      if (!manifestRef) continue;
      linkStatement.run(write.observationId, ref.id, ref.eventKey, manifestRef.label, manifestRef.inspection);
    }
  }
  return result;
}

/**
 * docs/media-contract-v1.md, "Capture-only linkage": when the accepted request
 * carried none of the turn's images, every observation stored from the turn
 * links every retained image of the turn's source events as `uninspected`.
 * Refs come from the durable event refs (never the RAM buffer), in event order
 * then label order, one per attachment ID. A failed or deleted conversion is
 * not linked; a converting one is, so it shows as pending until it is ready.
 */
export function captureOnlyLinkWrites(
  db: Database,
  eventKeys: readonly string[],
  observationIds: readonly number[],
  insertedObservationIds: readonly number[],
): ObservationLinkWrite[] {
  const refsStatement = db.prepare(`SELECT r.attachment_id AS id, r.label, r.event_key AS eventKey
    FROM media_event_refs r
    JOIN media_events e ON e.event_key = r.event_key
    JOIN media_attachments a ON a.id = r.attachment_id
    WHERE r.event_key = ? AND e.state = 'retained' AND a.state IN ('converting', 'ready')
    ORDER BY r.label`);
  const refs: Array<MediaAttachmentRef & { eventKey: string }> = [];
  for (const eventKey of new Set(eventKeys)) {
    for (const row of refsStatement.all(eventKey) as Array<{ id: string; label: string; eventKey: string }>) {
      if (refs.some(ref => ref.id === row.id)) continue;
      refs.push({ id: row.id, label: row.label, inspection: 'uninspected', eventKey: row.eventKey });
    }
  }
  if (refs.length === 0) return [];
  const inserted = new Set(insertedObservationIds);
  return [...new Set(observationIds)].map(observationId => ({
    observationId,
    insertedThisTurn: inserted.has(observationId),
    refs: refs.map(ref => ({ ...ref })),
  }));
}

/**
 * docs/media-contract-v1.md, "Capture-only linkage", a turn that attributed
 * image events and stored no observation: its events' retained images link as
 * `uninspected` to the most recent observation already stored for the same
 * session and prompt. With none yet, the events wait (carry_prompt_number) for
 * the next turn of that session and prompt that stores any. Runs inside the
 * caller's savepoint, so a failed write leaves nothing waiting.
 */
export function skippedTurnCaptureOnlyLinkWrites(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
  eventKeys: readonly string[],
): ObservationLinkWrite[] {
  // storeObservations saves prompt number 0 as NULL: such a turn has no prompt to hand its images to.
  if (eventKeys.length === 0 || !promptNumber) return [];
  // Highest id = last stored. The join resolves the session's registered
  // memory session id, the one its observation rows carry.
  const latest = db.prepare(`SELECT o.id FROM observations o
    JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
    WHERE s.id = ? AND o.prompt_number = ?
    ORDER BY o.id DESC LIMIT 1`).get(sessionDbId, promptNumber) as { id: number } | null;
  if (latest) return captureOnlyLinkWrites(db, eventKeys, [latest.id], []);
  const waitStatement = db.prepare(`UPDATE media_events SET carry_prompt_number = ?
    WHERE event_key = ? AND session_db_id = ? AND state = 'retained'`);
  for (const eventKey of new Set(eventKeys)) waitStatement.run(promptNumber, eventKey, sessionDbId);
  return [];
}

/**
 * The storing-turn half of the rule above: events of this session and prompt
 * that are waiting link to every observation this turn stored, ahead of the
 * turn's own refs (event order, then label order), and stop waiting. A
 * returned row of another prompt or session gets none. Returns the turn's
 * writes unchanged when nothing waits or no stored row is of this prompt. Runs inside the caller's
 * savepoint, so a failed write leaves the events waiting.
 */
export function withWaitingCaptureOnlyLinkWrites(
  db: Database,
  sessionDbId: number,
  promptNumber: number,
  observationIds: readonly number[],
  insertedObservationIds: readonly number[],
  turnWrites: readonly ObservationLinkWrite[],
): ObservationLinkWrite[] {
  if (observationIds.length === 0 || !promptNumber) return [...turnWrites];
  const waiting = (db.prepare(`SELECT event_key FROM media_events
    WHERE session_db_id = ? AND carry_prompt_number = ? AND state = 'retained'
    ORDER BY created_at, rowid`).all(sessionDbId, promptNumber) as Array<{ event_key: string }>).map(row => row.event_key);
  if (waiting.length === 0) return [...turnWrites];
  // storeObservations can return an existing row (an exact duplicate or a
  // title match) from another prompt or session; only this session's and
  // prompt's rows receive the waiting images. With none, they keep waiting.
  const ofThisPrompt = db.prepare(`SELECT 1 FROM observations o
    JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
    WHERE o.id = ? AND s.id = ? AND o.prompt_number = ?`);
  const targets = [...new Set(observationIds)].filter(id => ofThisPrompt.get(id, sessionDbId, promptNumber) !== null);
  if (targets.length === 0) return [...turnWrites];
  db.prepare('UPDATE media_events SET carry_prompt_number = NULL WHERE session_db_id = ? AND carry_prompt_number = ?')
    .run(sessionDbId, promptNumber);

  const writes = new Map<number, ObservationLinkWrite>();
  for (const write of captureOnlyLinkWrites(db, waiting, targets, insertedObservationIds)) writes.set(write.observationId, write);
  for (const write of turnWrites) {
    const earlier = writes.get(write.observationId);
    writes.set(write.observationId, earlier ? { ...earlier, refs: [...earlier.refs, ...write.refs] } : write);
  }
  return [...writes.values()];
}

/** True when a session and prompt has image events waiting for its next storing turn. */
export function hasWaitingCaptureOnlyEvents(db: Database, sessionDbId: number, promptNumber: number): boolean {
  if (!promptNumber) return false;
  return db.prepare(`SELECT 1 FROM media_events
    WHERE session_db_id = ? AND carry_prompt_number = ? AND state = 'retained' LIMIT 1`).get(sessionDbId, promptNumber) !== null;
}

/**
 * Record each source event's text outcome and its observation rows. A stored
 * result is never downgraded to skipped. Runs in the same transaction as the
 * observation write, before the RAM batch is confirmed.
 */
export function writeMediaEventResults(
  db: Database,
  eventKeys: readonly string[],
  outcome: 'stored' | 'skipped',
  observationIds: readonly number[],
): void {
  const updateStatement = db.prepare(`UPDATE media_events SET result_state = ?
    WHERE event_key = ? AND state = 'retained' AND (result_state = 'unprocessed' OR ? = 'stored')`);
  const resultStatement = db.prepare('INSERT OR IGNORE INTO media_event_results (event_key, observation_id) VALUES (?, ?)');
  for (const eventKey of eventKeys) {
    updateStatement.run(outcome, eventKey, outcome);
    for (const observationId of new Set(observationIds)) resultStatement.run(eventKey, observationId);
  }
}

/** A committed text outcome for a source event, or null when it has none yet. */
export function committedMediaEventResult(db: Database, eventKey: string): { resultState: 'stored' | 'skipped'; observationIds: number[] } | null {
  const event = db.prepare(`SELECT result_state FROM media_events WHERE event_key = ?`).get(eventKey) as { result_state: string } | null;
  if (!event || (event.result_state !== 'stored' && event.result_state !== 'skipped')) return null;
  const rows = db.prepare('SELECT observation_id FROM media_event_results WHERE event_key = ? ORDER BY observation_id').all(eventKey) as { observation_id: number }[];
  return { resultState: event.result_state, observationIds: rows.map(row => row.observation_id) };
}
