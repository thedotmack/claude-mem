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
