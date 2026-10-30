import { MEDIA_METADATA_NAMESPACE, MediaError, validateMediaManifest, type MediaManifest } from '../../shared/media-contract.js';
import { logger } from '../../utils/logger.js';

/**
 * Generic-feed media refs for one observation: the validated
 * `metadata.cmem_media_v1` manifest, or undefined when the row has no refs.
 *
 * Every local observation feed (paged, by-id, batch and SSE) serializes media
 * through this one function so the refs are identical across them. It carries
 * only attachment IDs, request labels, inspection state and the overflow flag.
 * Readiness, dimensions and source availability are resolved per attachment
 * through the controlled `/api/media/:id` routes, never frozen into the feed.
 * Provenance, locators, object keys and event identity never appear here.
 *
 * An invalid namespace fails closed: the row renders exactly like an
 * image-free observation instead of exposing unvalidated metadata.
 */
export function observationMediaFromMetadata(metadataJson: unknown): MediaManifest | undefined {
  if (typeof metadataJson !== 'string' || metadataJson.length === 0) return undefined;
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    // Unparseable metadata carries no refs; the row renders image-free.
    logger.warn('DB', 'Observation metadata unreadable; media refs omitted from feed', { code: 'invalid_manifest' });
    return undefined;
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(metadata, MEDIA_METADATA_NAMESPACE)) return undefined;
  try {
    const manifest = validateMediaManifest((metadata as Record<string, unknown>)[MEDIA_METADATA_NAMESPACE]);
    return manifest.attachments.length > 0 ? manifest : undefined;
  } catch (error) {
    // Fail closed. Bounded code only: no IDs, labels or metadata text.
    logger.warn('DB', 'Observation media manifest invalid; media refs omitted from feed', {
      code: error instanceof MediaError ? error.code : 'invalid_manifest',
    });
    return undefined;
  }
}

/**
 * Attach `media` to a feed row read with its `metadata` column. When
 * `keepMetadataColumn` is false the raw column is removed so the row keeps
 * the exact pre-media feed shape; image-free rows gain no key at all.
 */
export function withObservationMedia<Row extends object>(
  row: Row,
  keepMetadataColumn: boolean,
): Omit<Row, 'metadata'> & { metadata?: unknown; media?: MediaManifest } {
  // `SELECT *` rows carry the column without declaring it in their type.
  const { metadata, ...rest } = row as Row & { metadata?: unknown };
  const media = observationMediaFromMetadata(metadata);
  const base = keepMetadataColumn ? { ...rest, metadata } : rest;
  return media ? { ...base, media } : base;
}
