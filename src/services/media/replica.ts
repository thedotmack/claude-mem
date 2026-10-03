import type { Database } from 'bun:sqlite';
import { MEDIA_METADATA_NAMESPACE, MediaError, validateMediaManifest, type MediaAttachmentRef } from '../../shared/media-contract.js';
import { logger } from '../../utils/logger.js';
import { parseObservationMetadata } from './linkage.js';

/**
 * Second-device media (plan Phase 5 item 4, copying SyncApply's replica
 * behavior). An unresolved replica placeholder is stored as origin='replica',
 * state='failed', failure_code=NULL, variants=NULL (the v61 state CHECK has no
 * spare value). It is never a failure: MediaStore.getMetadata projects it as
 * the distinct state 'unresolved_replica', and every count of failed media
 * must filter origin='native'. A replica observation keeps the canonical media IDs from its
 * synced `metadata.cmem_media_v1` verbatim. Each referenced ID gets a local
 * placeholder attachment row (origin='replica', upload_state='cancelled', so it
 * is never uploaded) plus a junction row mirroring the manifest. Bytes are
 * resolved lazily from the owner's cloud media plane on the first viewer read
 * (MediaCloudReplicaResolver); nothing is fetched here.
 *
 * The junction rows give replica media the same lifecycle as native media:
 * deleting the replica observation (an incoming tombstone) fires the existing
 * observation-delete trigger, which cleans unreferenced files. A stale op never
 * reaches this function (SyncApply returns 'stale' first), so a stale payload
 * cannot add or remove media.
 */

const REPLICA_EVENT_KEY = 'replica';

function replicaManifestRefs(observationId: number, metadataJson: string | null): MediaAttachmentRef[] {
  try {
    const metadata = parseObservationMetadata(metadataJson);
    if (!Object.prototype.hasOwnProperty.call(metadata, MEDIA_METADATA_NAMESPACE)) return [];
    return validateMediaManifest(metadata[MEDIA_METADATA_NAMESPACE]).attachments;
  } catch (error) {
    // Canonical decoding already validated hub bodies; only legacy fixtures get
    // here. Fail closed: no links, and only the bounded code is logged.
    if (!(error instanceof MediaError)) throw error;
    logger.warn('SYNC_APPLY', 'Replica media manifest ignored', { observationId, code: error.code });
    return [];
  }
}

export function syncReplicaMediaLinks(db: Database, observationId: number, metadataJson: string | null, nowMs = Date.now()): void {
  const manifestRefs = replicaManifestRefs(observationId, metadataJson);
  const manifestIds = new Set(manifestRefs.map(ref => ref.id));
  const previousIds = (db.prepare('SELECT attachment_id FROM observation_media_links WHERE observation_id=?')
    .all(observationId) as Array<{ attachment_id: string }>).map(row => row.attachment_id);

  const ensurePlaceholder = db.prepare(`
    INSERT INTO media_attachments
      (id, replay_key, provenance, recipe, state, failure_code, upload_state, origin, created_at)
    VALUES ($id, 'replica:' || $id, '{"origin":"replica"}', 'screenshot-v1', 'failed', NULL, 'cancelled', 'replica', $now)
    ON CONFLICT(id) DO UPDATE SET state='failed', failure_code=NULL, variants=NULL, encoder_version=NULL
      WHERE media_attachments.origin='replica' AND media_attachments.state='deleted'
        AND NOT EXISTS (SELECT 1 FROM media_cleanup_jobs j WHERE j.attachment_id=media_attachments.id)`);
  const upsertLink = db.prepare(`
    INSERT INTO observation_media_links (observation_id, attachment_id, event_key, label, inspection)
    VALUES (?, ?, '${REPLICA_EVENT_KEY}', ?, ?)
    ON CONFLICT(observation_id, attachment_id) DO UPDATE SET label=excluded.label, inspection=excluded.inspection`);
  for (const ref of manifestRefs) {
    ensurePlaceholder.run({ $id: ref.id, $now: nowMs });
    upsertLink.run(observationId, ref.id, ref.label, ref.inspection);
  }

  // Refs a newer accepted revision dropped are unlinked and their local
  // replica cache is cleaned. Nothing is deleted in the cloud from here: the
  // owner's media plane reconciles the same accepted revision itself (Pro
  // projection unlinks dropped refs and its unreferenced-media retention
  // removes them), so a replica device never deletes the owner's cloud copy.
  const removedIds = previousIds.filter(id => !manifestIds.has(id));
  const deleteLink = db.prepare('DELETE FROM observation_media_links WHERE observation_id=? AND attachment_id=?');
  const unreferenced = `id=$id AND state!='deleted'
      AND NOT EXISTS (SELECT 1 FROM media_event_refs r WHERE r.attachment_id=$id)
      AND NOT EXISTS (SELECT 1 FROM observation_media_links l WHERE l.attachment_id=$id)`;
  const queueCleanup = db.prepare(`INSERT OR IGNORE INTO media_cleanup_jobs (attachment_id, directory, queued_at)
    SELECT id, id, $now FROM media_attachments WHERE ${unreferenced}`);
  const tombstone = db.prepare(`UPDATE media_attachments SET state='deleted', upload_state='cancelled' WHERE ${unreferenced}`);
  for (const attachmentId of removedIds) {
    deleteLink.run(observationId, attachmentId);
    queueCleanup.run({ $id: attachmentId, $now: nowMs });
    tombstone.run({ $id: attachmentId });
  }
}
