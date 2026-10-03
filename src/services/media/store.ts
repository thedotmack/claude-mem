import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MEDIA_LIMITS, MediaError, validateMediaProvenance, type MediaAttachmentRef, type MediaErrorCode, type MediaProvenance } from '../../shared/media-contract.js';
import { convertMedia, type ConvertedMedia } from './converter.js';
import { assertNoSymlinks, readContainedFile } from './files.js';
import { queueCleanupForDeletedEvent } from '../sqlite/media.js';
import { logger } from '../../utils/logger.js';

export type MediaVariantName = 'viewer' | 'llm';
export const MEDIA_CLEANUP_MAX_ATTEMPTS = 8;
const CLEANUP_RETRY_BASE_MS = 30_000;
const CLEANUP_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
export function assertMediaId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new MediaError('invalid_manifest');
  return value;
}
export interface VariantMetadata { sha256: string; width: number; height: number; byteLength: number; mimeType: 'image/webp' }
export interface MediaMetadata {
  /** 'unresolved_replica': a second-device placeholder whose bytes were not fetched yet (never a failure). */
  id: string; state: 'converting' | 'ready' | 'failed' | 'deleted' | 'unresolved_replica'; recipe: MediaProvenance['recipe'];
  encoderVersion: string | null; viewer: VariantMetadata | null; llm: VariantMetadata | null; failureCode: MediaErrorCode | null;
}
interface AttachmentRow { id: string; state: Exclude<MediaMetadata['state'], 'unresolved_replica'>; provenance: string; recipe: MediaMetadata['recipe']; encoder_version: string | null; variants: string | null; failure_code: MediaErrorCode | null; lease_until: number; origin: 'native' | 'replica' }

/** Verified cloud bytes for one replica attachment (see publishReplica). */
export interface ReplicaVariants {
  recipe: MediaProvenance['recipe'];
  encoderVersion: string;
  viewer: VariantMetadata & { bytes: Buffer };
  llm: VariantMetadata & { bytes: Buffer };
}

export function mediaReplayKey(provenance: MediaProvenance): string {
  return createHash('sha256').update(JSON.stringify([1,provenance.platform,provenance.event_identity,provenance.source_pointer,provenance.source_sha256,provenance.recipe])).digest('hex');
}
export function mediaEventKey(platform: MediaProvenance['platform'], identity: MediaProvenance['event_identity']): string {
  return createHash('sha256').update(JSON.stringify([1,platform,identity])).digest('hex');
}

/** Owns files and asset references, with no generator/retry responsibilities. */
export class MediaStore {
  readonly root: string;
  constructor(readonly db: Database, dataDir: string, private readonly converter = convertMedia) {
    this.root = resolve(dataDir, 'media-v1');
  }
  private prepareRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new MediaError('storage_unavailable');
    // Pin the physical configured storage boundary, then reject all symlinks
    // below it. No arbitrary route path is ever used for storage access.
    if (realpathSync(this.root) !== this.root) throw new MediaError('storage_unavailable');
    const temporary = join(this.root, '.tmp');
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    assertNoSymlinks(this.root, temporary);
  }
  private row(id: string): AttachmentRow {
    assertMediaId(id);
    const row = this.db.prepare('SELECT * FROM media_attachments WHERE id=?').get(id) as AttachmentRow | null;
    if (!row || row.state === 'deleted') throw new MediaError('media_not_found');
    return row;
  }
  getMetadata(id: string): MediaMetadata {
    const row = this.row(id);
    const variants = row.variants ? JSON.parse(row.variants) as Record<MediaVariantName,VariantMetadata> : null;
    const unresolvedReplica = row.origin === 'replica' && row.state === 'failed';
    return { id, state: unresolvedReplica ? 'unresolved_replica' : row.state, recipe: row.recipe, encoderVersion: row.encoder_version,
      viewer: variants?.viewer ?? null, llm: variants?.llm ?? null, failureCode: row.failure_code };
  }
  async readVariant(id: string, variant: MediaVariantName): Promise<Buffer> {
    if (variant !== 'viewer' && variant !== 'llm') throw new MediaError('invalid_manifest');
    const row = this.row(id);
    if (row.state !== 'ready') throw new MediaError('media_not_ready');
    const metadata = this.getMetadata(id)[variant];
    if (!metadata) throw new MediaError('media_not_ready');
    try {
      const bytes = readContainedFile(this.root, join(this.root, id, variant + '.webp'), variant === 'viewer' ? MEDIA_LIMITS.maxCanonicalBytes : MEDIA_LIMITS.maxDerivativeBytes);
      if (bytes.length !== metadata.byteLength || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new MediaError('checksum_mismatch');
      return bytes;
    } catch (error) { if (error instanceof MediaError) throw error; throw new MediaError('storage_unavailable'); }
  }
  eventRefs(eventKey: string): MediaAttachmentRef[] {
    return this.db.prepare(`SELECT attachment_id AS id,label,'uninspected' AS inspection FROM media_event_refs WHERE event_key=? ORDER BY label`).all(eventKey) as MediaAttachmentRef[];
  }
  findEventSource(eventKey:string,pointer:string): {ref:MediaAttachmentRef;state:MediaMetadata['state'];provenance:MediaProvenance}|null {
    const rows=this.db.prepare(`SELECT a.*,r.label FROM media_event_refs r JOIN media_attachments a ON a.id=r.attachment_id JOIN media_events e ON e.event_key=r.event_key WHERE r.event_key=? AND e.state='retained' LIMIT 4`).all(eventKey) as (AttachmentRow&{label:string})[];
    for(const row of rows) {
      const provenance=validateMediaProvenance(JSON.parse(row.provenance));
      if(provenance.source_pointer===pointer)return {ref:{id:row.id,label:row.label,inspection:'uninspected'},state:row.state,provenance};
    }
    return null;
  }

  async capture(input: { sessionDbId: number; provenance: Omit<MediaProvenance,'attachment_id'>; label: string; bytes: Buffer; mimeType: string }): Promise<MediaAttachmentRef> {
    const key = mediaReplayKey({ ...input.provenance, attachment_id: '00000000-0000-4000-8000-000000000000' });
    const eventKey = mediaEventKey(input.provenance.platform,input.provenance.event_identity);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.label)) throw new MediaError('invalid_manifest');
    if (createHash('sha256').update(input.bytes).digest('hex') !== input.provenance.source_sha256) throw new MediaError('checksum_mismatch');
    this.prepareRoot();
    // Reconciliation stays off this hot ingest path: DatabaseManager runs it on
    // a 30 s unref'd timer (and once at startup).
    const now = Date.now();
    const claimed = this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM sdk_sessions WHERE id=?').get(input.sessionDbId)) throw new MediaError('media_not_found');
      this.db.prepare(`INSERT OR IGNORE INTO media_events(event_key,session_db_id,platform,event_identity,created_at) VALUES(?,?,?,?,?)`)
        .run(eventKey,input.sessionDbId,input.provenance.platform,JSON.stringify(input.provenance.event_identity),now);
      const event = this.db.prepare('SELECT state,session_db_id FROM media_events WHERE event_key=?').get(eventKey) as {state:string;session_db_id:number};
      if (event.state !== 'retained' || event.session_db_id !== input.sessionDbId) throw new MediaError('media_not_found');
      let row = this.db.prepare('SELECT * FROM media_attachments WHERE replay_key=?').get(key) as AttachmentRow | null;
      if (!row) {
        const id = randomUUID();
        const provenance = validateMediaProvenance({ ...input.provenance, attachment_id:id });
        this.db.prepare(`INSERT INTO media_attachments(id,replay_key,provenance,recipe,state,lease_until,created_at) VALUES(?,?,?,?,'converting',?,?)`)
          .run(id,key,JSON.stringify(provenance),provenance.recipe,now+30_000,now);
        row = this.row(id);
      } else if (row.state === 'deleted') throw new MediaError('media_not_found');
      else if (row.state === 'converting') throw new MediaError('conversion_busy');
      else if (row.state === 'failed') {
        if (this.db.prepare('SELECT 1 FROM media_cleanup_jobs WHERE attachment_id=?').get(row.id)) throw new MediaError('media_not_ready');
        this.db.prepare(`UPDATE media_attachments SET state='converting',failure_code=NULL,lease_until=? WHERE id=?`).run(now+30_000,row.id);
      }
      this.db.prepare('INSERT OR IGNORE INTO media_event_refs(event_key,attachment_id,label) VALUES(?,?,?)').run(eventKey,row.id,input.label);
      return {id:row.id,ready:row.state==='ready'};
    })();
    const ref: MediaAttachmentRef = { id:claimed.id, label:input.label, inspection:'uninspected' };
    if (claimed.ready) return ref;
    let stage: string | undefined;
    let published = false;
    try {
      const converted = await this.converter(input.bytes,input.mimeType,input.provenance.recipe);
      // A session/event may have been deleted while native encoding ran.
      const retained = this.db.prepare(`SELECT 1 FROM media_event_refs r JOIN media_events e ON e.event_key=r.event_key WHERE r.attachment_id=? AND e.state='retained'`).get(claimed.id);
      if (!retained || this.row(claimed.id).state !== 'converting') throw new MediaError('media_not_found');
      stage = join(this.root,'.tmp',claimed.id+'-'+randomUUID());
      mkdirSync(stage,{mode:0o700});
      assertNoSymlinks(this.root,stage);
      for (const variant of ['viewer','llm'] as const) {
        const fd = openSync(join(stage,variant+'.webp'),'wx',0o600);
        try { writeFileSync(fd,converted[variant].bytes); fsyncSync(fd); } finally {closeSync(fd);}
      }
      // Atomic directory publication prevents readers seeing just one variant.
      // https://nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath
      renameSync(stage,join(this.root,claimed.id));
      published = true;
      stage = undefined;
      const metadata = (variant:ConvertedMedia['viewer']):VariantMetadata => ({sha256:variant.sha256,width:variant.width,height:variant.height,byteLength:variant.byteLength,mimeType:variant.mimeType});
      this.db.transaction(() => {
        const stillRetained = this.db.prepare(`SELECT 1 FROM media_event_refs WHERE attachment_id=?`).get(claimed.id);
        if (!stillRetained || this.row(claimed.id).state !== 'converting') throw new MediaError('media_not_found');
        this.db.prepare(`UPDATE media_attachments SET state='ready',encoder_version=?,variants=?,lease_until=0 WHERE id=?`)
          .run(converted.encoderVersion,JSON.stringify({viewer:metadata(converted.viewer),llm:metadata(converted.llm)}),claimed.id);
      })();
      return ref;
    } catch (error) {
      if (stage) rmSync(stage,{recursive:true,force:true});
      const code = error instanceof MediaError ? error.code : 'storage_unavailable';
      // Only the bounded code: converter and storage errors can carry paths.
      logger.warn('DB', 'Media conversion failed', { code });
      this.db.transaction(() => {
        this.db.prepare(`UPDATE media_attachments SET state='failed',failure_code=?,lease_until=0 WHERE id=? AND state='converting'`).run(code,claimed.id);
        if (published) this.db.prepare('INSERT OR IGNORE INTO media_cleanup_jobs(attachment_id,directory,queued_at) VALUES(?,?,?)').run(claimed.id,claimed.id,Date.now());
      })();
      throw new MediaError(code);
    }
  }

  /** True for a second-device placeholder whose bytes were not resolved yet. */
  isUnresolvedReplica(id: string): boolean {
    assertMediaId(id);
    const row = this.db.prepare(`SELECT state, origin FROM media_attachments WHERE id=?`).get(id) as Pick<AttachmentRow,'state'|'origin'> | null;
    return row !== null && row.origin === 'replica' && row.state === 'failed';
  }

  /**
   * Publish verified cloud bytes for a replica placeholder with the same staged
   * atomic directory rename as a native conversion. The row stays
   * origin='replica' and upload_state='cancelled', so it is never uploaded. A
   * placeholder deleted while the download ran is not resurrected: its staged
   * files are removed and media_not_found is thrown.
   */
  publishReplica(id: string, replica: ReplicaVariants): void {
    assertMediaId(id);
    this.prepareRoot();
    const target = join(this.root, id);
    if (existsSync(target)) {
      if (!this.isUnresolvedReplica(id)) throw new MediaError('media_not_found');
      // A crash after an earlier rename but before its row update.
      assertNoSymlinks(this.root, target);
      rmSync(target, { recursive: true, force: true });
    }
    let stage: string | undefined = join(this.root, '.tmp', id + '-' + randomUUID());
    try {
      mkdirSync(stage, { mode: 0o700 });
      assertNoSymlinks(this.root, stage);
      for (const variant of ['viewer', 'llm'] as const) {
        const fd = openSync(join(stage, variant + '.webp'), 'wx', 0o600);
        try { writeFileSync(fd, replica[variant].bytes); fsyncSync(fd); } finally { closeSync(fd); }
      }
      renameSync(stage, target);
      stage = undefined;
      const describe = (variant: VariantMetadata): VariantMetadata => ({ sha256: variant.sha256, width: variant.width, height: variant.height, byteLength: variant.byteLength, mimeType: variant.mimeType });
      const published = this.db.prepare(`UPDATE media_attachments SET state='ready', failure_code=NULL, recipe=?, encoder_version=?, variants=?
        WHERE id=? AND origin='replica' AND state='failed'`)
        .run(replica.recipe, replica.encoderVersion, JSON.stringify({ viewer: describe(replica.viewer), llm: describe(replica.llm) }), id);
      if (published.changes === 0) {
        this.db.prepare('INSERT OR IGNORE INTO media_cleanup_jobs(attachment_id,directory,queued_at) VALUES(?,?,?)').run(id, id, Date.now());
        throw new MediaError('media_not_found');
      }
    } finally {
      if (stage) rmSync(stage, { recursive: true, force: true });
    }
  }

  linkObservation(observationId: number, eventKey: string, refs: MediaAttachmentRef[]): void {
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM observations WHERE id=?').get(observationId)) throw new MediaError('media_not_found');
      for (const ref of refs) {
        this.row(ref.id);
        if (!this.db.prepare('SELECT 1 FROM media_event_refs WHERE event_key=? AND attachment_id=? AND label=?').get(eventKey,ref.id,ref.label)) throw new MediaError('invalid_manifest');
        this.db.prepare(`INSERT OR IGNORE INTO observation_media_links(observation_id,attachment_id,event_key,label,inspection) VALUES(?,?,?,?,?)`).run(observationId,ref.id,eventKey,ref.label,ref.inspection);
      }
    })();
  }
  deleteEvent(eventKey: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE media_events SET state='deleted' WHERE event_key=?`).run(eventKey);
      queueCleanupForDeletedEvent(this.db, eventKey);
      this.db.prepare('DELETE FROM media_event_refs WHERE event_key=?').run(eventKey);
      this.db.prepare('DELETE FROM media_event_results WHERE event_key=?').run(eventKey);
    })();
  }
  /**
   * Exponential backoff from 30 s, capped at one hour. After
   * MEDIA_CLEANUP_MAX_ATTEMPTS the job is parked (retry_at never reached,
   * last_error='retry_limit') and stays as the durable record of files that
   * still need manual removal; it never blocks other jobs.
   */
  private recordCleanupFailure(job: { attachment_id: string; attempts: number }, now: number, code: MediaErrorCode): void {
    const attempts = job.attempts + 1;
    const exhausted = attempts >= MEDIA_CLEANUP_MAX_ATTEMPTS;
    const retryAt = exhausted ? Number.MAX_SAFE_INTEGER : now + Math.min(CLEANUP_RETRY_BASE_MS * 2 ** job.attempts, CLEANUP_RETRY_MAX_DELAY_MS);
    this.db.prepare(`UPDATE media_cleanup_jobs SET attempts=?,retry_at=?,last_error=? WHERE attachment_id=?`)
      .run(attempts, retryAt, exhausted ? 'retry_limit' : 'storage_unavailable', job.attachment_id);
    logger.warn('DB', exhausted ? 'Media cleanup gave up after the retry limit' : 'Media cleanup will retry', { code, attempts });
  }

  /** Bounded durable cleanup and abandoned conversion reconciliation. */
  reconcile(now=Date.now()): void {
    this.db.transaction(() => {
      const abandoned = this.db.prepare(`SELECT id FROM media_attachments WHERE state='converting' AND lease_until<? LIMIT 32`).all(now) as {id:string}[];
      for (const {id} of abandoned) {
        this.db.prepare(`UPDATE media_attachments SET state='failed',failure_code='conversion_timeout',lease_until=0 WHERE id=?`).run(id);
        this.db.prepare(`INSERT OR IGNORE INTO media_cleanup_jobs(attachment_id,directory,queued_at) VALUES(?,?,?)`).run(id,id,now);
      }
    })();
    if (!existsSync(this.root)) return;
    this.prepareRoot();
    const jobs = this.db.prepare('SELECT attachment_id,directory,attempts FROM media_cleanup_jobs WHERE retry_at<=? LIMIT 32').all(now) as {attachment_id:string;directory:string;attempts:number}[];
    for (const job of jobs) {
      try {
        assertMediaId(job.directory);
        const target = join(this.root,job.directory);
        if (existsSync(target)) { assertNoSymlinks(this.root,target); rmSync(target,{recursive:true,force:true}); }
        for (const name of readdirSync(join(this.root,'.tmp')).slice(0,128)) {
          if (name.startsWith(job.attachment_id+'-')) {
            const temp = join(this.root,'.tmp',name);
            assertNoSymlinks(this.root,temp); rmSync(temp,{recursive:true,force:true});
          }
        }
        this.db.prepare('DELETE FROM media_cleanup_jobs WHERE attachment_id=?').run(job.attachment_id);
      } catch (error) {
        this.recordCleanupFailure(job, now, error instanceof MediaError ? error.code : 'storage_unavailable');
      }
    }
  }
}
