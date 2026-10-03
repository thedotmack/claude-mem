import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  MEDIA_LIMITS,
  MEDIA_RECIPES,
  MediaError,
  isMediaErrorCode,
  validateMediaProvenance,
  type MediaErrorCode,
  type MediaProvenance,
} from '../../shared/media-contract.js';
import { logger } from '../../utils/logger.js';
import type { MediaStore, VariantMetadata } from './store.js';
import { isCloudSyncConfigured } from '../sync/CloudSync.js';

/**
 * Owner cloud media plane client and the local upload/deletion/replica jobs
 * (plan Phase 5 items 3, 4 and 7). Independent of native text sync: CloudSync
 * never waits for media, text syncs with a stable pending attachment ID, and
 * upload completion only changes media_attachments.upload_state — it never
 * re-observes, re-queues or changes observation text, metadata or sync_rev.
 *
 * Transport copies CloudSync: the same `CLAUDE_MEM_CLOUD_SYNC_TOKEN` bearer
 * (a `cm_pro_` setup token, which Pro's `authenticateHookBearer` accepts),
 * injectable fetch, and a bounded per-request timeout. The route and multipart
 * shape are copied from Pro `src/lib/media/cloud-routes.ts` /
 * `cloud-contract.ts` (Phase 3): `POST /api/observation-media` with exactly two
 * fields, `manifest` (JSON {version,id,provenance,canonical,encoder}) and
 * `canonical` (image/webp). The server re-derives both variants itself.
 */

/** Bounded concurrent replica downloads; further reads fail fast as pending. */
export const MEDIA_REPLICA_MAX_CONCURRENT_DOWNLOADS = 4;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_INTERVAL_MS = 30_000;
const UPLOAD_BATCH = 8;
const DELETE_BATCH = 32;
const DESCRIPTOR_MAX_BYTES = 8192;
const ERROR_BODY_MAX_BYTES = 4096;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENCODER = /^sharp-[0-9.]+\/vips-[0-9.]+$/;

export interface MediaCloudSettings {
  CLAUDE_MEM_CLOUD_SYNC_TOKEN: string;
  CLAUDE_MEM_CLOUD_SYNC_USER_ID: string;
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL: string;
  CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: string;
}

/** Uploads run only with capture on AND cloud sync configured (CloudSync's exact predicate). */
export function mediaCloudUploadsEnabled(settings: MediaCloudSettings): boolean {
  return settings.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED === 'true' && isCloudSyncConfigured(settings);
}

/** Replica reads and queued deletions need only the cloud sync credentials. */
export { isCloudSyncConfigured as cloudSyncConfigured };

export interface CloudUploadManifest {
  version: 1;
  id: string;
  provenance: MediaProvenance;
  canonical: { sha256: string; width: number; height: number; byteLength: number };
  encoder: string;
}

export interface CloudMediaDescriptor {
  id: string;
  state: 'ready';
  recipe: MediaProvenance['recipe'];
  encoder: string;
  viewer: VariantMetadata;
  llm: VariantMetadata;
}

/**
 * `retry`: transient (network, timeout, 401/402/403, 429, 5xx, not-ready,
 * quota, busy). These never consume an attempt budget: they back off (capped
 * at one hour) for as long as it takes, so an outage or a lapsed subscription
 * never strands an upload or deletion. `final`: a deterministic 4xx (manifest,
 * format, checksum, tombstone) that can never succeed by retrying.
 */
export type CloudCallOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'retry'; code: MediaErrorCode }
  | { kind: 'final'; code: MediaErrorCode };

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new MediaError('source_too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MediaError('source_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function errorCodeOf(response: Response): Promise<MediaErrorCode | null> {
  try {
    const parsed = JSON.parse((await readBoundedBody(response, ERROR_BODY_MAX_BYTES)).toString('utf8')) as { error?: unknown };
    return isMediaErrorCode(parsed?.error) ? parsed.error : null;
  } catch {
    // An unparseable error body has no safe detail; the status decides.
    return null;
  }
}

function classifyFailure<T>(status: number, code: MediaErrorCode | null): CloudCallOutcome<T> {
  if (status === 401 || status === 402 || status === 403) return { kind: 'retry', code: code ?? 'unauthorized_owner' };
  if (status === 429 || status >= 500) return { kind: 'retry', code: code ?? 'storage_unavailable' };
  if (code === 'media_not_ready' || code === 'quota_exceeded' || code === 'conversion_busy') return { kind: 'retry', code };
  return { kind: 'final', code: code ?? 'invalid_manifest' };
}

function variantDescriptor(value: unknown, maximumBytes: number): VariantMetadata {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.sha256 !== 'string' || !SHA256_HEX.test(record.sha256)
    || !Number.isSafeInteger(record.width) || (record.width as number) <= 0 || (record.width as number) > MEDIA_LIMITS.maxDimension
    || !Number.isSafeInteger(record.height) || (record.height as number) <= 0 || (record.height as number) > MEDIA_LIMITS.maxDimension
    || !Number.isSafeInteger(record.byteLength) || (record.byteLength as number) <= 0 || (record.byteLength as number) > maximumBytes
    || record.mimeType !== 'image/webp') throw new MediaError('invalid_manifest');
  return { sha256: record.sha256, width: record.width as number, height: record.height as number, byteLength: record.byteLength as number, mimeType: 'image/webp' };
}

/** Strict parse of Pro's CloudMediaDescriptor; anything else fails closed. */
export function parseCloudDescriptor(value: unknown, expectedId: string): CloudMediaDescriptor {
  const record = value as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.id !== expectedId || record.state !== 'ready'
    || typeof record.recipe !== 'string' || !(MEDIA_RECIPES as readonly string[]).includes(record.recipe)
    || typeof record.encoder !== 'string' || record.encoder.length > 80 || !ENCODER.test(record.encoder)) {
    throw new MediaError('invalid_manifest');
  }
  return {
    id: expectedId,
    state: 'ready',
    recipe: record.recipe as MediaProvenance['recipe'],
    encoder: record.encoder,
    viewer: variantDescriptor(record.viewer, MEDIA_LIMITS.maxCanonicalBytes),
    llm: variantDescriptor(record.llm, MEDIA_LIMITS.maxDerivativeBytes),
  };
}

export interface MediaCloudClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class MediaCloudClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: MediaCloudClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async request(path: string, init: RequestInit): Promise<Response | null> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/api/observation-media${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      // Network failure or timeout: no response, no detail worth logging.
      return null;
    }
  }

  async upload(manifest: CloudUploadManifest, canonicalBytes: Buffer): Promise<CloudCallOutcome<CloudMediaDescriptor>> {
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('canonical', new Blob([new Uint8Array(canonicalBytes)], { type: 'image/webp' }), 'canonical.webp');
    const response = await this.request('', { method: 'POST', body: form });
    if (!response) return { kind: 'retry', code: 'storage_unavailable' };
    if (!response.ok) return classifyFailure(response.status, await errorCodeOf(response));
    try {
      const body = JSON.parse((await readBoundedBody(response, DESCRIPTOR_MAX_BYTES)).toString('utf8'));
      return { kind: 'ok', value: parseCloudDescriptor(body, manifest.id) };
    } catch {
      // A 2xx with a malformed descriptor: retry; the server replays by key.
      return { kind: 'retry', code: 'invalid_manifest' };
    }
  }

  /** 204 and 404 both mean "gone": a foreign or absent id is indistinguishable. */
  async deleteAttachment(attachmentId: string): Promise<CloudCallOutcome<null>> {
    const response = await this.request(`/${attachmentId}`, { method: 'DELETE' });
    if (!response) return { kind: 'retry', code: 'storage_unavailable' };
    if (response.ok || response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'ok', value: null };
    }
    const code = await errorCodeOf(response);
    // Deletion must eventually win: every other failure is retried.
    return { kind: 'retry', code: code ?? 'storage_unavailable' };
  }

  async describe(attachmentId: string): Promise<CloudCallOutcome<CloudMediaDescriptor>> {
    const response = await this.request(`/${attachmentId}`, { method: 'GET' });
    if (!response) return { kind: 'retry', code: 'storage_unavailable' };
    if (!response.ok) return classifyFailure(response.status, await errorCodeOf(response));
    try {
      return { kind: 'ok', value: parseCloudDescriptor(JSON.parse((await readBoundedBody(response, DESCRIPTOR_MAX_BYTES)).toString('utf8')), attachmentId) };
    } catch {
      return { kind: 'final', code: 'invalid_manifest' };
    }
  }

  async readVariant(attachmentId: string, variant: 'viewer' | 'llm', expected: VariantMetadata): Promise<CloudCallOutcome<Buffer>> {
    const response = await this.request(`/${attachmentId}/${variant}`, { method: 'GET' });
    if (!response) return { kind: 'retry', code: 'storage_unavailable' };
    if (!response.ok) return classifyFailure(response.status, await errorCodeOf(response));
    let bytes: Buffer;
    try {
      bytes = await readBoundedBody(response, variant === 'viewer' ? MEDIA_LIMITS.maxCanonicalBytes : MEDIA_LIMITS.maxDerivativeBytes);
    } catch (error) {
      return { kind: 'final', code: error instanceof MediaError ? error.code : 'storage_unavailable' };
    }
    if (bytes.length !== expected.byteLength || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      return { kind: 'final', code: 'checksum_mismatch' };
    }
    return { kind: 'ok', value: bytes };
  }
}

function retryDelayMs(attemptsSoFar: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attemptsSoFar - 1), RETRY_MAX_DELAY_MS);
}

interface UploadCandidate {
  id: string;
  provenance: string;
  encoder_version: string | null;
  variants: string | null;
  upload_attempts: number;
}

export interface MediaCloudDrainResult {
  uploaded: number;
  uploadRetries: number;
  uploadFailures: number;
  deleted: number;
  deleteRetries: number;
}

export interface MediaCloudSyncOptions {
  uploadsEnabled: boolean;
  now?: () => number;
  drainIntervalMs?: number;
}

/**
 * Durable media upload and cloud-deletion worker. The database is the queue:
 * native ready attachments with upload_state='pending' are uploaded, and
 * media_cloud_deletions rows are deleted, each with exponential backoff that
 * survives restarts and offline periods. Deletions drain before uploads so a
 * higher-revision deletion wins over a stale upload. Single-flight in-process.
 */
export class MediaCloudSync {
  private readonly now: () => number;
  private readonly drainIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<MediaCloudDrainResult> | null = null;

  constructor(
    private readonly db: Database,
    private readonly store: Pick<MediaStore, 'readVariant'>,
    private readonly client: MediaCloudClient,
    private readonly options: MediaCloudSyncOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.drainIntervalMs = options.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => { void this.drain().catch(error => logger.warn('CLOUD_SYNC', 'Media cloud drain failed', { code: error instanceof MediaError ? error.code : 'storage_unavailable' })); };
    tick();
    this.timer = setInterval(tick, this.drainIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  drain(): Promise<MediaCloudDrainResult> {
    if (this.draining) return this.draining;
    this.draining = this.drainOnce().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drainOnce(): Promise<MediaCloudDrainResult> {
    const result: MediaCloudDrainResult = { uploaded: 0, uploadRetries: 0, uploadFailures: 0, deleted: 0, deleteRetries: 0 };
    await this.drainDeletions(result);
    if (this.options.uploadsEnabled) await this.drainUploads(result);
    return result;
  }

  private async drainDeletions(result: MediaCloudDrainResult): Promise<void> {
    const jobs = this.db.prepare(`SELECT attachment_id, attempts FROM media_cloud_deletions
      WHERE retry_at<=? ORDER BY queued_at LIMIT ${DELETE_BATCH}`).all(this.now()) as Array<{ attachment_id: string; attempts: number }>;
    for (const job of jobs) {
      const outcome = await this.client.deleteAttachment(job.attachment_id);
      if (outcome.kind === 'ok') {
        this.db.prepare('DELETE FROM media_cloud_deletions WHERE attachment_id=?').run(job.attachment_id);
        result.deleted++;
        continue;
      }
      const attempts = job.attempts + 1;
      // Deletion must eventually win: every failure only backs off, capped at
      // one hour, and the row is never parked or dropped.
      this.db.prepare('UPDATE media_cloud_deletions SET attempts=?, retry_at=?, last_error=? WHERE attachment_id=?')
        .run(attempts, this.now() + retryDelayMs(attempts), outcome.code, job.attachment_id);
      result.deleteRetries++;
      logger.warn('CLOUD_SYNC', 'Media cloud deletion will retry', { code: outcome.code, attempts });
    }
  }

  private async drainUploads(result: MediaCloudDrainResult): Promise<void> {
    const candidates = this.db.prepare(`SELECT id, provenance, encoder_version, variants, upload_attempts FROM media_attachments
      WHERE origin='native' AND state='ready' AND upload_state='pending' AND upload_retry_at<=?
      ORDER BY created_at LIMIT ${UPLOAD_BATCH}`).all(this.now()) as UploadCandidate[];
    for (const candidate of candidates) await this.uploadOne(candidate, result);
  }

  private buildManifest(candidate: UploadCandidate): CloudUploadManifest {
    const provenance = validateMediaProvenance(JSON.parse(candidate.provenance));
    // The owner-only local locator never leaves this device.
    const { source_locator: _ownerOnlyLocator, ...cloudProvenance } = provenance;
    const variants = candidate.variants ? JSON.parse(candidate.variants) as { viewer?: VariantMetadata } : {};
    if (!variants.viewer || !candidate.encoder_version || provenance.attachment_id !== candidate.id) throw new MediaError('invalid_manifest');
    return {
      version: 1,
      id: candidate.id,
      provenance: cloudProvenance,
      canonical: { sha256: variants.viewer.sha256, width: variants.viewer.width, height: variants.viewer.height, byteLength: variants.viewer.byteLength },
      encoder: candidate.encoder_version,
    };
  }

  private async uploadOne(candidate: UploadCandidate, result: MediaCloudDrainResult): Promise<void> {
    // Count the attempt durably BEFORE the request: a response lost after the
    // cloud committed it still makes a later local deletion queue a cloud one.
    const claimed = this.db.prepare(`UPDATE media_attachments SET upload_attempts=upload_attempts+1
      WHERE id=? AND origin='native' AND state='ready' AND upload_state='pending'`).run(candidate.id);
    if (claimed.changes === 0) return;
    const attempted = { ...candidate, upload_attempts: candidate.upload_attempts + 1 };
    let manifest: CloudUploadManifest;
    let canonicalBytes: Buffer;
    try {
      manifest = this.buildManifest(candidate);
      canonicalBytes = await this.store.readVariant(candidate.id, 'viewer');
    } catch (error) {
      const code = error instanceof MediaError ? error.code : 'invalid_manifest';
      // A deletion that won during the read is not an upload failure.
      if (code === 'media_not_found') return;
      this.recordUploadFailure(attempted, { kind: code === 'storage_unavailable' ? 'retry' : 'final', code }, result);
      return;
    }
    const outcome = await this.client.upload(manifest, canonicalBytes);
    if (outcome.kind !== 'ok') {
      this.recordUploadFailure(attempted, outcome, result);
      return;
    }
    this.db.transaction(() => {
      const marked = this.db.prepare(`UPDATE media_attachments SET upload_state='uploaded', upload_error=NULL
        WHERE id=? AND state='ready' AND upload_state='pending'`).run(candidate.id);
      if (marked.changes === 0) {
        // Deleted (or cancelled) while the request was in flight: the
        // deletion wins, so the just-landed cloud copy is removed too.
        this.db.prepare('INSERT OR IGNORE INTO media_cloud_deletions(attachment_id, queued_at) VALUES(?,?)').run(candidate.id, this.now());
      }
    })();
    result.uploaded++;
  }

  private recordUploadFailure(candidate: UploadCandidate, outcome: { kind: 'retry' | 'final'; code: MediaErrorCode }, result: MediaCloudDrainResult): void {
    // Only a deterministic failure is terminal; transport/auth/5xx back off.
    const exhausted = outcome.kind === 'final';
    if (exhausted) {
      this.db.prepare(`UPDATE media_attachments SET upload_state='failed', upload_error=?
        WHERE id=? AND upload_state='pending'`).run(outcome.code, candidate.id);
      result.uploadFailures++;
    } else {
      this.db.prepare(`UPDATE media_attachments SET upload_retry_at=?, upload_error=?
        WHERE id=? AND upload_state='pending'`).run(this.now() + retryDelayMs(candidate.upload_attempts), outcome.code, candidate.id);
      result.uploadRetries++;
    }
    logger.warn('CLOUD_SYNC', exhausted ? 'Media upload failed' : 'Media upload will retry', { code: outcome.code, attempts: candidate.upload_attempts });
  }
}

/**
 * Cloud outcome → local read error. The cloud answers 404 both for an image the
 * owning device has not uploaded yet and for one that is gone (no existence
 * oracle), so while a live replica row still references the ID, 404 and every
 * transient failure (offline, auth) read as pending: the placeholder stays and
 * the next read retries. Removal arrives as the text tombstone, which deletes
 * the replica row and its media. Integrity failures keep their bounded code.
 */
function replicaReadError(outcome: { kind: 'retry' | 'final'; code: MediaErrorCode }): MediaError {
  if (outcome.kind === 'retry' || outcome.code === 'media_not_found' || outcome.code === 'media_not_ready') return new MediaError('media_not_ready');
  return new MediaError(outcome.code === 'checksum_mismatch' ? 'checksum_mismatch' : 'storage_unavailable');
}

/**
 * Lazy second-device resolution: on the first viewer read of a replica
 * placeholder, fetch the authorized descriptor and both variants from the
 * owner's cloud media plane, verify byte length and SHA-256 against the
 * descriptor, then publish them locally. Single-flight per attachment ID.
 */
export class MediaCloudReplicaResolver {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Pick<MediaStore, 'isUnresolvedReplica' | 'publishReplica'>,
    private readonly client: MediaCloudClient | null,
  ) {}

  resolve(attachmentId: string): Promise<void> {
    if (!this.store.isUnresolvedReplica(attachmentId)) return Promise.resolve();
    const existing = this.inFlight.get(attachmentId);
    if (existing) return existing;
    // Bounded: a gallery of unresolved replicas never opens unbounded
    // downloads; the excess reads as pending and the viewer retries.
    if (this.inFlight.size >= MEDIA_REPLICA_MAX_CONCURRENT_DOWNLOADS) return Promise.reject(new MediaError('media_not_ready'));
    const pending = this.resolveOnce(attachmentId).finally(() => this.inFlight.delete(attachmentId));
    this.inFlight.set(attachmentId, pending);
    return pending;
  }

  private async resolveOnce(attachmentId: string): Promise<void> {
    if (!UUID_V4.test(attachmentId)) throw new MediaError('invalid_manifest');
    // Without cloud credentials the image stays pending, never an error page.
    if (!this.client) throw new MediaError('media_not_ready');
    const described = await this.client.describe(attachmentId);
    if (described.kind !== 'ok') throw replicaReadError(described);
    const descriptor = described.value;
    const viewer = await this.client.readVariant(attachmentId, 'viewer', descriptor.viewer);
    if (viewer.kind !== 'ok') throw replicaReadError(viewer);
    const llm = await this.client.readVariant(attachmentId, 'llm', descriptor.llm);
    if (llm.kind !== 'ok') throw replicaReadError(llm);
    this.store.publishReplica(attachmentId, {
      recipe: descriptor.recipe,
      encoderVersion: descriptor.encoder,
      viewer: { ...descriptor.viewer, bytes: viewer.value },
      llm: { ...descriptor.llm, bytes: llm.value },
    });
  }
}
