/**
 * Version-one observation media contracts. This file and Pro's
 * src/lib/media/contract.ts must remain byte-identical. Safe manifests belong
 * in canonical metadata; provenance belongs only in the owner media plane.
 * See docs/media-contract-v1.md for capture and rollout evidence gates.
 */
export const MEDIA_MANIFEST_VERSION = 1 as const;
export const MEDIA_METADATA_NAMESPACE = 'cmem_media_v1' as const;

/**
 * Frozen v1 bounds (docs/media-contract-v1.md). Each one's reason is next to it.
 * "Abuse protection" means the bound keeps one request or one owner from using
 * unbounded memory, CPU, storage or bandwidth. Pro's upload route rejects an
 * image that hits any bound with its MediaError code. The local worker instead
 * fits a canonical or derivative over its pixel, dimension or byte bound
 * (docs/media-contract-v1.md, "Where the size bounds apply"). Nothing is
 * truncated.
 */
export const MEDIA_LIMITS = Object.freeze({
  // Abuse protection: caps one event at 4 stored images (about 13 MiB) and one
  // observer turn at 4 derivatives (maxGatewayImageBytes).
  maxImagesPerEvent: 4,
  // Provider maximum: Vercel Functions take request bodies up to 4.5 MB; this
  // plus maxUploadBodyBytes' multipart overhead (3.06 MiB, 3.2 MB) fits.
  maxSourceBytes: 3 * 1024 * 1024,
  // Same bound for the stored full-size copy: a lossless re-encode of an accepted
  // source must still fit, and a stored copy is served back in one Vercel
  // response, also limited to 4.5 MB.
  maxCanonicalBytes: 3 * 1024 * 1024,
  // Owner's rule, 2026-11-05/06: no stored copy is multiple megabytes, and every
  // copy is lossy WebP. Both converters fit each canonical they encode into this.
  // maxCanonicalBytes stays the bound for an accepted upload and for reading a
  // copy stored before this rule (lossless, up to 3 MiB). Measured 2026-11-06 at
  // quality 80: the largest of 29 real screenshots is 406 KiB, and a 2800x23880
  // full-page screenshot fitted to 8192 px is 528 KiB, so all keep full
  // resolution with about 2 times headroom.
  maxEncodedCanonicalBytes: 1024 * 1024,
  // Abuse protection (decompression bombs): a decode holds about 4 bytes per
  // pixel, so at most about 96 MB. A 6016x3384 display (20.4 million px) fits.
  maxPixels: 24_000_000,
  // Abuse protection: bounds long thin images that pass maxPixels. An 8K
  // display (7680 px wide) fits.
  maxDimension: 8192,
  // Abuse protection: one conversion holds a shared instance's CPU. The upload
  // route's 59 s maxDuration fits this plus two 20 s Storage writes.
  conversionTimeoutSeconds: 5,
  // Abuse protection: instances serve concurrent requests, so one decode of up
  // to about 96 MB runs at a time; others fail fast as conversion_busy and retry.
  maxConcurrentConversions: 1,
  // Abuse protection on what a model is sent: 4 of these make the 1 MiB
  // maxGatewayImageBytes.
  maxDerivativeBytes: 256 * 1024,
  // Provider maximum: Anthropic downscales images whose long edge is above
  // 1,568 px (standard tier, platform.claude.com/docs/en/build-with-claude/vision),
  // so pixels beyond that cost tokens and add nothing.
  maxDerivativeDimension: 1536,
  // One largest source as base64 (3 MiB x 4/3 = 4 MiB), so the local event JSON
  // stays under its existing 5 MB cap.
  maxInlineEncodedBytes: 4 * 1024 * 1024,
  // Abuse protection: metadata.cmem_media_v1 syncs to every device; 32 refs of
  // about 120 bytes each stay inside maxManifestBytes.
  maxObservationRefs: 32,
  // Abuse protection: labels are generated (event1_image1); 64 leaves room and
  // keeps a ref small.
  maxLabelChars: 64,
  // Abuse protection: bounds one manifest; 32 refs need about 4 KiB.
  maxManifestBytes: 8192,
  // Abuse protection: bounds the private provenance row; its largest part is
  // the 4096-character locator.
  maxProvenanceBytes: 8192,
  // Operating-system maximum: PATH_MAX is 4096 on Linux (1024 on macOS).
  maxSourceLocatorChars: 4096,
  // maxImagesPerEvent x maxDerivativeBytes: the most one observer turn can send.
  maxGatewayImageBytes: 4 * 256 * 1024,
  // maxSourceBytes plus 64 KiB for the manifest (8 KiB at most) and multipart
  // headers; still under Vercel's 4.5 MB request body maximum.
  maxUploadBodyBytes: 3 * 1024 * 1024 + 64 * 1024,
  // Abuse protection, sized so a paying user's images are not refused (owner,
  // 2026-11-05: "dont throw away images, on cloud they'll be PAYING me").
  // Measured 2026-11-05: the median converted pair (canonical plus derivative)
  // of 27 real screenshots is 321 KiB, so 100 screenshots a day is about
  // 11.2 GiB a year. Past the Pro plan's 100 GB, Supabase Storage costs $0.0213
  // per GB a month (supabase.com/docs/guides/platform/manage-your-usage/
  // storage-size, read 2026-11-05), so a full owner (26.8 GB) costs about $0.57
  // a month. Pro enforces it: uploads past it answer 413 quota_exceeded and the
  // image stays on the computer.
  ownerQuotaBytes: 25 * 1024 * 1024 * 1024,
} as const);

export const MEDIA_RECIPES = ['screenshot-v1', 'photo-v1'] as const;
export type MediaRecipe = typeof MEDIA_RECIPES[number];
export const MEDIA_SOURCE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type MediaSourceMime = typeof MEDIA_SOURCE_MIMES[number];

export const MEDIA_ERROR_CODES = [
  'converter_disabled', 'decoder_unavailable', 'conversion_busy',
  'conversion_timeout', 'source_too_large', 'unsupported_format',
  'mime_mismatch', 'invalid_image', 'animated_image', 'pixel_limit',
  'dimension_limit', 'canonical_too_large', 'derivative_too_large',
  'unsupported_source', 'invalid_manifest', 'manifest_too_large',
  'invalid_provenance', 'quota_exceeded', 'account_frozen',
  'unauthorized_owner', 'media_not_found', 'media_not_ready',
  'checksum_mismatch', 'storage_unavailable', 'upload_body_too_large',
  'unknown_cost', 'spend_limit', 'retry_limit',
] as const;
export type MediaErrorCode = typeof MEDIA_ERROR_CODES[number];

/** Only the code is safe to expose. Do not serialize arbitrary decoder errors. */
export class MediaError extends Error {
  constructor(public readonly code: MediaErrorCode, message: string = code) {
    super(message);
    this.name = 'MediaError';
  }
}

export interface MediaAttachmentRef {
  id: string;
  label: string;
  inspection: 'inspected' | 'uninspected';
}

/** Readiness is resolved at read time and must never be frozen into this value. */
export interface MediaManifest {
  version: typeof MEDIA_MANIFEST_VERSION;
  attachments: MediaAttachmentRef[];
  /** True means additional refs remain on the event because the row is full. */
  overflow?: boolean;
}

export type MediaEventIdentity =
  | { kind: 'platform_event'; id: string }
  | { kind: 'transcript_event'; transcript_id: string; record_index: number; record_sha256: string };

export const MEDIA_SOURCE_SHAPES = [
  'anthropic_base64', 'claude_read_base64', 'mcp_base64',
  'openai_data_url', 'trusted_tool_file',
] as const;
export type MediaSourceShape = typeof MEDIA_SOURCE_SHAPES[number];

/** Never add this to generic content feeds, prompts, logs, or sync metadata. */
export interface MediaProvenance {
  version: typeof MEDIA_MANIFEST_VERSION;
  attachment_id: string;
  platform: 'claude-code' | 'codex' | 'cowork' | 'transcript';
  event_identity: MediaEventIdentity;
  source_shape: MediaSourceShape;
  source_pointer: string;
  source_index: number;
  source_sha256: string;
  recipe: MediaRecipe;
  source_locator?: { kind: 'local_file'; path: string };
}

export interface MediaFailureDescriptor {
  version: typeof MEDIA_MANIFEST_VERSION;
  state: 'disabled' | 'rejected' | 'failed';
  code: MediaErrorCode;
  inspection: 'uninspected';
  label?: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const JSON_POINTER = /^(?:\/(?:[A-Za-z0-9_.-]|~[01]){1,64}){1,12}$/;

function object(value: unknown, keys: readonly string[], code: MediaErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MediaError(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new MediaError(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new MediaError(code);
  return record;
}

function boundedString(value: unknown, pattern: RegExp, max: number, code: MediaErrorCode): string {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) throw new MediaError(code);
  return value;
}

function boundedInteger(value: unknown, max: number, code: MediaErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new MediaError(code);
  return value as number;
}

export function isMediaRecipe(value: unknown): value is MediaRecipe {
  return typeof value === 'string' && (MEDIA_RECIPES as readonly string[]).includes(value);
}

export function isMediaErrorCode(value: unknown): value is MediaErrorCode {
  return typeof value === 'string' && (MEDIA_ERROR_CODES as readonly string[]).includes(value);
}

export function validateMediaManifest(value: unknown): MediaManifest {
  const record = object(value, ['version', 'attachments', 'overflow'], 'invalid_manifest');
  if (record.version !== MEDIA_MANIFEST_VERSION || !Array.isArray(record.attachments)) throw new MediaError('invalid_manifest');
  if (record.attachments.length > MEDIA_LIMITS.maxObservationRefs) throw new MediaError('manifest_too_large');
  if (record.overflow !== undefined && typeof record.overflow !== 'boolean') throw new MediaError('invalid_manifest');
  const ids = new Set<string>();
  // Array.from visits holes too, so a sparse array fails the object check
  // below instead of being skipped by map and serialized as null.
  const attachments = Array.from(record.attachments as unknown[], value => {
    const ref = object(value, ['id', 'label', 'inspection'], 'invalid_manifest');
    const id = boundedString(ref.id, UUID_V4, 36, 'invalid_manifest');
    const label = boundedString(ref.label, LABEL, MEDIA_LIMITS.maxLabelChars, 'invalid_manifest');
    if (ids.has(id) || (ref.inspection !== 'inspected' && ref.inspection !== 'uninspected')) throw new MediaError('invalid_manifest');
    ids.add(id);
    return { id, label, inspection: ref.inspection } as MediaAttachmentRef;
  });
  const result: MediaManifest = { version: MEDIA_MANIFEST_VERSION, attachments };
  if (record.overflow !== undefined) result.overflow = record.overflow;
  if (new TextEncoder().encode(JSON.stringify(result)).length > MEDIA_LIMITS.maxManifestBytes) throw new MediaError('manifest_too_large');
  return result;
}

export function validateMediaEventIdentity(value: unknown): MediaEventIdentity {
  const code = 'invalid_provenance';
  const record = object(value, ['kind', 'id', 'transcript_id', 'record_index', 'record_sha256'], code);
  if (record.kind === 'platform_event') {
    object(value, ['kind', 'id'], code);
    return { kind: record.kind, id: boundedString(record.id, OPAQUE_ID, 160, code) };
  }
  if (record.kind === 'transcript_event') {
    object(value, ['kind', 'transcript_id', 'record_index', 'record_sha256'], code);
    return {
      kind: record.kind,
      transcript_id: boundedString(record.transcript_id, OPAQUE_ID, 160, code),
      record_index: boundedInteger(record.record_index, Number.MAX_SAFE_INTEGER, code),
      record_sha256: boundedString(record.record_sha256, SHA256, 64, code),
    };
  }
  throw new MediaError(code);
}

export function validateMediaProvenance(value: unknown): MediaProvenance {
  const code = 'invalid_provenance';
  const record = object(value, ['version', 'attachment_id', 'platform', 'event_identity', 'source_shape', 'source_pointer', 'source_index', 'source_sha256', 'recipe', 'source_locator'], code);
  if (record.version !== MEDIA_MANIFEST_VERSION || !['claude-code', 'codex', 'cowork', 'transcript'].includes(record.platform as string)) throw new MediaError(code);
  if (!(MEDIA_SOURCE_SHAPES as readonly unknown[]).includes(record.source_shape) || !isMediaRecipe(record.recipe)) throw new MediaError(code);
  const result: MediaProvenance = {
    version: MEDIA_MANIFEST_VERSION,
    attachment_id: boundedString(record.attachment_id, UUID_V4, 36, code),
    platform: record.platform as MediaProvenance['platform'],
    event_identity: validateMediaEventIdentity(record.event_identity),
    source_shape: record.source_shape as MediaSourceShape,
    source_pointer: boundedString(record.source_pointer, JSON_POINTER, 780, code),
    source_index: boundedInteger(record.source_index, MEDIA_LIMITS.maxImagesPerEvent - 1, code),
    source_sha256: boundedString(record.source_sha256, SHA256, 64, code),
    recipe: record.recipe,
  };
  if (record.source_locator !== undefined) {
    const locator = object(record.source_locator, ['kind', 'path'], code);
    if (locator.kind !== 'local_file' || record.source_shape !== 'trusted_tool_file' || typeof locator.path !== 'string' || locator.path.length > MEDIA_LIMITS.maxSourceLocatorChars || /[\x00-\x1f\x7f]/.test(locator.path) || !/^(?:\/|[A-Za-z]:[\\/])/.test(locator.path)) throw new MediaError(code);
    result.source_locator = { kind: 'local_file', path: locator.path };
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > MEDIA_LIMITS.maxProvenanceBytes) throw new MediaError(code);
  return result;
}

export function validateMediaFailure(value: unknown): MediaFailureDescriptor {
  const record = object(value, ['version', 'state', 'code', 'inspection', 'label'], 'invalid_manifest');
  if (record.version !== MEDIA_MANIFEST_VERSION || !['disabled', 'rejected', 'failed'].includes(record.state as string) || !isMediaErrorCode(record.code) || record.inspection !== 'uninspected') throw new MediaError('invalid_manifest');
  const result: MediaFailureDescriptor = {
    version: MEDIA_MANIFEST_VERSION,
    state: record.state as MediaFailureDescriptor['state'],
    code: record.code,
    inspection: 'uninspected',
  };
  if (record.label !== undefined) result.label = boundedString(record.label, LABEL, MEDIA_LIMITS.maxLabelChars, 'invalid_manifest');
  return result;
}
