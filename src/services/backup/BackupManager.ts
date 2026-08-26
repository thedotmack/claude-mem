
import { join, dirname, basename } from 'path';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync, unlinkSync } from 'fs';
import { Readable } from 'stream';
import { Database } from 'bun:sqlite';
import { DB_PATH, USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { buildSyncAuthHeaders } from '../sync/sync-auth-headers.js';
import {
  activateBackupAddonRequired,
  clearBackupAddonRequired,
  isBackupAddonRequired,
} from '../../shared/backup-addon-marker.js';
import { backupAddonLine } from '../../shared/pro-promo.js';
import { encryptFile, mintEncryptionKeyBase64 } from './backup-crypto.js';

/** Settings keys BackupManager reads (subset of SettingsDefaults). */
export interface BackupSettingKeys {
  CLAUDE_MEM_BACKUP_INTERVAL_HOURS?: string;
  CLAUDE_MEM_BACKUP_RETAIN_COUNT?: string;
  /** 'true' = encrypt + upload each snapshot to the sync hub (Phase 3). */
  CLAUDE_MEM_BACKUP_CLOUD?: string;
  /** base64 AES-256 key; minted + persisted on first cloud-enabled snapshot. */
  CLAUDE_MEM_BACKUP_ENCRYPTION_KEY?: string;
  // Cloud-sync credentials (same gating predicate as CloudSync.isConfigured).
  CLAUDE_MEM_CLOUD_SYNC_TOKEN?: string;
  CLAUDE_MEM_CLOUD_SYNC_USER_ID?: string;
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL?: string;
  CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID?: string;
  CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME?: string;
}

export interface BackupManagerOptions {
  /** Live database to snapshot (defaults to the shared claude-mem.db). */
  dbPath?: string;
  /** Snapshot target directory (defaults to paths.backups()). */
  backupsDir?: string;
  /** Directory probed for free disk space (defaults to the db's directory). */
  preflightDir?: string;
  /** Delay before the first scheduled run after start(); default ~5 minutes. */
  initialDelayMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable for tests; defaults to globalThis.fetch (CloudSync pattern). */
  fetchImpl?: typeof fetch;
  /** settings.json path where a freshly minted encryption key is persisted. */
  settingsPath?: string;
  /** Timeout for the upload-url request; default 30s. */
  requestTimeoutMs?: number;
  /** Timeout for the streamed snapshot PUT; default 10 min (600MB+ files). */
  uploadTimeoutMs?: number;
  /** Marker file for the hub's addon_required state (tests; defaults to
   * {dataDir}/backup-addon-required.json via backup-addon-marker.ts). */
  addonMarkerPath?: string;
}

export interface BackupSnapshotResult {
  path: string;
  bytes: number;
  createdAt: number;
  method: 'vacuum-into' | 'copy';
}

export interface BackupStatus {
  configured: boolean;
  lastSnapshotAt: number | null;
  lastSnapshotBytes: number | null;
  snapshotCount: number;
  lastError: string | null;
  nextRunAt: number | null;
  /** CLAUDE_MEM_BACKUP_CLOUD === 'true' AND cloud-sync credentials present. */
  cloudEnabled: boolean;
  lastUploadAt: number | null;
  lastUploadKey: string | null;
  /**
   * The hub answered 403 addon_required within the marker's 24h TTL: cloud
   * uploads are paused (local snapshots continue) until the user buys the
   * backup add-on or the marker expires and the daily cycle retries.
   */
  addonRequired: boolean;
}

/**
 * Thrown by the upload step when the hub 403s with `error.code:
 * "addon_required"` — the verified user lacks the paid backup add-on. Mapped
 * to the file-backed marker (backup-addon-marker.ts) rather than retried:
 * this failure is definitive until the user subscribes.
 */
class BackupAddonRequiredError extends Error {
  constructor() {
    super('cloud backups require the cmem Pro backup add-on (addon_required)');
    this.name = 'BackupAddonRequiredError';
  }
}

/** Does this non-2xx response body carry the hub's addon_required taxonomy? */
function isAddonRequiredBody(status: number, bodyText: string): boolean {
  if (status !== 403) return false;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: unknown } } | null;
    return parsed?.error?.code === 'addon_required';
  } catch {
    return false;
  }
}

/**
 * Automatic snapshots are named claude-mem-<sanitized ISO ts>.db. The
 * fallback-copy sidecars end in `.db-wal`/`.db-shm`, so the trailing `.db`
 * anchor keeps them out of the snapshot listing (they are pruned alongside
 * their parent file).
 */
export const SNAPSHOT_FILE_PATTERN = /^claude-mem-.*\.db$/;

/**
 * Automatic local SQLite snapshots with retention (pro-backup plan Phase 1).
 *
 * Snapshot engine extracted from the one-time v12.4.3 cleanup backup
 * (CleanupV12_4_3.ts): disk pre-flight → `VACUUM INTO` → copyFileSync +
 * -wal/-shm sidecar fallback. The schedule loop copies SyncClient's
 * self-rescheduling unref'd setTimeout chain — the worker deliberately has
 * no setInterval of its own — with a single-flight guard so a slow snapshot
 * can never stack a second cycle.
 *
 * Construction is gated by DatabaseManager on CLAUDE_MEM_BACKUP_ENABLED, so
 * an instance existing means backups are configured.
 */
export class BackupManager {
  private readonly dbPath: string;
  private readonly backupsDir: string;
  private readonly preflightDir: string;
  private readonly intervalMs: number;
  private readonly retainCount: number;
  private readonly initialDelayMs: number;
  private readonly now: () => number;

  // Cloud upload (Phase 3). The token is held in memory only — NEVER logged.
  private readonly cloudSetting: string;
  private readonly token: string;
  private readonly userId: string;
  private readonly hubUrl: string;
  private readonly deviceName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly settingsPath: string;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  /** undefined = the module default ({dataDir}/backup-addon-required.json). */
  private readonly addonMarkerPath: string | undefined;
  private deviceId: string;
  private encryptionKey: string;
  /** Fail closed: minted-key persistence failed — no uploads this session. */
  private cloudDisabledForSession = false;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  /** Single-flight: true while a snapshot cycle is in progress. */
  private running = false;

  private lastSnapshotAt: number | null = null;
  private lastSnapshotBytes: number | null = null;
  private lastError: string | null = null;
  private nextRunAt: number | null = null;
  private lastUploadAt: number | null = null;
  private lastUploadKey: string | null = null;

  constructor(settings: BackupSettingKeys, options: BackupManagerOptions = {}) {
    const intervalHours = Number.parseFloat(settings.CLAUDE_MEM_BACKUP_INTERVAL_HOURS ?? '');
    this.intervalMs = (Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 24) * 3_600_000;
    const retain = Number.parseInt(settings.CLAUDE_MEM_BACKUP_RETAIN_COUNT ?? '', 10);
    this.retainCount = Number.isFinite(retain) && retain > 0 ? retain : 7;
    this.dbPath = options.dbPath ?? DB_PATH;
    this.backupsDir = options.backupsDir ?? paths.backups();
    this.preflightDir = options.preflightDir ?? dirname(this.dbPath);
    this.initialDelayMs = options.initialDelayMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;

    this.cloudSetting = settings.CLAUDE_MEM_BACKUP_CLOUD ?? '';
    this.token = settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN ?? '';
    this.userId = settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID ?? '';
    // Same normalization as CloudSync: empty means sync (and uploads) are off.
    this.hubUrl = (settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL ?? '').trim().replace(/\/+$/, '');
    this.deviceId = (settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? '').trim();
    this.deviceName = (settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME ?? '').slice(0, 80);
    this.encryptionKey = settings.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY ?? '';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 600_000;
    this.addonMarkerPath = options.addonMarkerPath;
  }

  /**
   * Cloud upload is on ⇔ CLAUDE_MEM_BACKUP_CLOUD === 'true' AND the
   * cloud-sync credentials are configured — the same token+userId+hubUrl
   * all-non-empty predicate as CloudSync.isConfigured().
   */
  private cloudConfigured(): boolean {
    return this.cloudSetting === 'true' && this.token !== '' && this.userId !== '' && this.hubUrl !== '';
  }

  /** Arm the cadence loop; the first run lands ~5 minutes after worker start. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(this.initialDelayMs);
    logger.info('BACKUP', 'Backup schedule started', {
      backupsDir: this.backupsDir,
      intervalMs: this.intervalMs,
      retainCount: this.retainCount,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  status(): BackupStatus {
    return {
      configured: true,
      lastSnapshotAt: this.lastSnapshotAt,
      lastSnapshotBytes: this.lastSnapshotBytes,
      snapshotCount: this.listSnapshotNames().length,
      lastError: this.lastError,
      nextRunAt: this.nextRunAt,
      cloudEnabled: this.cloudConfigured(),
      lastUploadAt: this.lastUploadAt,
      lastUploadKey: this.lastUploadKey,
      addonRequired: isBackupAddonRequired(this.addonMarkerPath),
    };
  }

  /**
   * One consistent snapshot of the live DB. Disk pre-flight, then
   * `VACUUM INTO` on a readonly connection (compacted, WAL folded in);
   * if that fails, a raw copyFileSync of the DB plus -wal/-shm sidecars.
   * Throws when no snapshot could be produced.
   */
  async createSnapshot(): Promise<BackupSnapshotResult> {
    const dbSize = statSync(this.dbPath).size;
    this.assertDiskSpace(dbSize);

    mkdirSync(this.backupsDir, { recursive: true });
    const createdAt = this.now();
    const ts = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
    const backupPath = join(this.backupsDir, `claude-mem-${ts}.db`);

    const backupDb = new Database(this.dbPath, { readonly: true });
    let vacuumFailed = false;
    try {
      backupDb.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      logger.info('BACKUP', 'Snapshot created via VACUUM INTO', { backupPath, dbSize });
    } catch (err: unknown) {
      vacuumFailed = true;
      const vacuumError = err instanceof Error ? err : new Error(String(err));
      logger.warn('BACKUP', 'VACUUM INTO failed, falling back to copyFileSync', {}, vacuumError);
    }
    backupDb.close();

    if (vacuumFailed) {
      try {
        copyFileSync(this.dbPath, backupPath);
        const walPath = `${this.dbPath}-wal`;
        const shmPath = `${this.dbPath}-shm`;
        if (existsSync(walPath)) copyFileSync(walPath, `${backupPath}-wal`);
        if (existsSync(shmPath)) copyFileSync(shmPath, `${backupPath}-shm`);
        logger.info('BACKUP', 'Snapshot created via copyFileSync (incl. -wal/-shm if present)', { backupPath, dbSize });
      } catch (copyErr: unknown) {
        const copyError = copyErr instanceof Error ? copyErr : new Error(String(copyErr));
        logger.error('BACKUP', 'Snapshot failed via both VACUUM INTO and copyFileSync', { backupPath }, copyError);
        throw copyError;
      }
    }

    const bytes = statSync(backupPath).size;
    this.lastSnapshotAt = createdAt;
    this.lastSnapshotBytes = bytes;
    this.lastError = null;
    return { path: backupPath, bytes, createdAt, method: vacuumFailed ? 'copy' : 'vacuum-into' };
  }

  /**
   * Keep the retainCount most-recent snapshots; delete the rest. Pure fs —
   * sanitized ISO filenames sort lexicographically, so name order is
   * timestamp order.
   */
  async applyRetention(): Promise<void> {
    const names = this.listSnapshotNames();
    const excess = names.slice(this.retainCount);
    for (const name of excess) {
      const snapshotPath = join(this.backupsDir, name);
      unlinkSync(snapshotPath);
      // Fallback copies carry -wal/-shm sidecars alongside the .db file.
      for (const sidecar of [`${snapshotPath}-wal`, `${snapshotPath}-shm`]) {
        if (existsSync(sidecar)) unlinkSync(sidecar);
      }
    }
    if (excess.length > 0) {
      logger.info('BACKUP', 'Retention pruned old snapshots', {
        deleted: excess.length,
        retained: names.length - excess.length,
      });
    }
  }

  /**
   * One snapshot + retention cycle on demand (POST /api/backup/run).
   * Single-flight: returns `null` without doing anything when a cycle is
   * already in progress (the route maps that to 409). Failures are recorded
   * in lastError and rethrown so the caller can surface them.
   */
  async runNow(): Promise<BackupSnapshotResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const result = await this.createSnapshot();
      await this.applyRetention();
      // Cloud upload never fails the local cycle: an upload error is recorded
      // in lastError and retried on the NEXT cadence cycle (no tight loop).
      await this.maybeUploadToCloud(result);
      logger.info('BACKUP', 'Snapshot cycle complete', { path: result.path, bytes: result.bytes, method: result.method });
      return result;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.lastError = normalized.message;
      throw normalized;
    } finally {
      this.running = false;
    }
  }

  /**
   * Cadence-loop wrapper around runNow(): failures are logged, never thrown —
   * the loop must survive a bad cycle and try again next interval.
   */
  async runOnce(): Promise<void> {
    try {
      await this.runNow();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.error('BACKUP', 'Snapshot cycle failed', {}, normalized);
    }
  }

  // -------------------------------------------------------------------------
  // Cloud upload (pro-backup plan Phase 3)
  // -------------------------------------------------------------------------

  /**
   * Encrypt the fresh snapshot and stream it to the sync hub. Skipped when
   * CLAUDE_MEM_BACKUP_CLOUD !== 'true' or the cloud-sync credentials are
   * incomplete. Never throws: failures are logged (token NEVER logged —
   * tokenLength only), recorded in lastError, and retried on the next
   * cadence cycle.
   */
  private async maybeUploadToCloud(snapshot: BackupSnapshotResult): Promise<void> {
    if (!this.cloudConfigured()) {
      if (this.cloudSetting === 'true') {
        logger.debug('BACKUP', 'Cloud upload skipped: cloud-sync credentials are not configured', {
          tokenLength: this.token.length,
          hasUserId: this.userId !== '',
          hasHubUrl: this.hubUrl !== '',
        });
      }
      return;
    }
    if (this.cloudDisabledForSession) {
      logger.debug('BACKUP', 'Cloud upload disabled for this session (encryption key persistence failed earlier)');
      return;
    }
    // Reactive entitlement (Phase 4): while the hub's addon_required marker is
    // fresh (< 24h TTL) skip the doomed upload entirely — no retry storm. The
    // TTL self-clears on read, so the daily cadence retries at most once a day.
    if (isBackupAddonRequired(this.addonMarkerPath)) {
      logger.debug('BACKUP', 'Cloud upload skipped: backup add-on required (marker active; retried after its 24h TTL)');
      return;
    }

    const encryptionKey = this.resolveEncryptionKey();
    if (encryptionKey === null) return; // failed closed; already logged

    const deviceId = this.resolveUploadDeviceId();
    if (deviceId === '') {
      logger.warn('BACKUP', 'Cloud upload skipped: no cloud-sync device id yet (CloudSync mints it); will retry next cycle');
      return;
    }

    const encPath = `${snapshot.path}.enc`;
    try {
      await encryptFile(snapshot.path, encPath, encryptionKey);
      const encBytes = statSync(encPath).size;
      const key = await this.uploadEncryptedSnapshot(encPath, encBytes, deviceId, basename(snapshot.path));
      this.lastUploadAt = this.now();
      this.lastUploadKey = key;
      this.lastError = null;
      // A successful upload proves the entitlement: drop any stale marker so
      // status()/doctor stop showing the upsell the moment the add-on works.
      clearBackupAddonRequired(this.addonMarkerPath);
      logger.info('BACKUP', 'Snapshot uploaded to cloud', { key, encBytes, tokenLength: this.token.length });
    } catch (error) {
      if (error instanceof BackupAddonRequiredError) {
        // Definitive, not transient: park uploads behind the 24h marker and
        // surface the upsell instead of retrying every cycle.
        activateBackupAddonRequired('addon_required', this.addonMarkerPath);
        this.lastError = error.message;
        logger.warn('BACKUP', 'Cloud upload requires the cmem Pro backup add-on; local snapshots continue', {
          upsell: backupAddonLine('worker'),
        });
      } else {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.lastError = normalized.message;
        logger.error('BACKUP', 'Cloud upload failed; will retry next cycle', { tokenLength: this.token.length }, normalized);
      }
    } finally {
      try {
        if (existsSync(encPath)) unlinkSync(encPath);
      } catch (cleanupError) {
        const normalized = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        logger.warn('BACKUP', 'Could not delete temporary encrypted snapshot', { encPath }, normalized);
      }
    }
  }

  /**
   * POST /v1/backup/upload-url for {key, url}, then stream the encrypted
   * file to the returned url with a PUT. Returns the object key.
   */
  private async uploadEncryptedSnapshot(encPath: string, encBytes: number, deviceId: string, name: string): Promise<string> {
    const authHeaders = buildSyncAuthHeaders({
      token: this.token,
      userId: this.userId,
      deviceId,
      deviceName: this.deviceName,
    });

    const urlRes = await this.fetchImpl(`${this.hubUrl}/v1/backup/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ name, bytes: encBytes }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!urlRes.ok) {
      const body = await urlRes.text().catch(() => '');
      if (isAddonRequiredBody(urlRes.status, body)) throw new BackupAddonRequiredError();
      throw new Error(`backup upload-url ${urlRes.status}: ${body.slice(0, 200)}`);
    }
    const parsed = (await urlRes.json().catch(() => null)) as { key?: unknown; url?: unknown } | null;
    if (!parsed || typeof parsed.key !== 'string' || typeof parsed.url !== 'string') {
      throw new Error('backup upload-url: response missing {key, url}');
    }

    // Stream the file — never buffer 600MB+ snapshots into memory.
    const body = Readable.toWeb(createReadStream(encPath)) as unknown as ReadableStream;
    const putRes = await this.fetchImpl(parsed.url, {
      method: 'PUT',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(encBytes),
      },
      body,
      // Node/Bun fetch requires half-duplex for streamed request bodies.
      duplex: 'half',
      signal: AbortSignal.timeout(this.uploadTimeoutMs),
    } as RequestInit);
    if (!putRes.ok) {
      const putBody = await putRes.text().catch(() => '');
      if (isAddonRequiredBody(putRes.status, putBody)) throw new BackupAddonRequiredError();
      throw new Error(`backup upload PUT ${putRes.status}: ${putBody.slice(0, 200)}`);
    }
    return parsed.key;
  }

  /**
   * Resolve the AES key: use the configured one, else mint 32 random bytes
   * and persist them to settings.json first (device-id persistence pattern,
   * CloudSync.resolveDeviceId). Fail closed: when persistence fails the key
   * is discarded and cloud upload stays disabled for this session — an
   * upload under an unpersisted key would be undecryptable after restart.
   */
  private resolveEncryptionKey(): string | null {
    if (this.encryptionKey !== '') return this.encryptionKey;

    const minted = mintEncryptionKeyBase64();
    try {
      this.persistSettingsKey('CLAUDE_MEM_BACKUP_ENCRYPTION_KEY', minted);
    } catch (error) {
      this.cloudDisabledForSession = true;
      this.lastError = 'failed to persist minted backup encryption key — cloud upload disabled this session';
      logger.error('BACKUP', 'Could not persist a freshly minted encryption key; disabling cloud upload rather than uploading a backup that could never be decrypted', {
        settingsPath: this.settingsPath,
      }, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
    this.encryptionKey = minted;
    logger.info('BACKUP', 'Minted new backup encryption key (stored in settings.json; it never leaves this machine)');
    return minted;
  }

  /**
   * The upload key embeds the cloud-sync device id. CloudSync mints and
   * persists it on its own first configured start, which can land after this
   * manager was constructed — so an empty id is re-read from settings.json
   * once per cycle rather than minted here (a second minter would fork
   * device identity).
   */
  private resolveUploadDeviceId(): string {
    if (this.deviceId !== '') return this.deviceId;
    try {
      if (existsSync(this.settingsPath)) {
        const settings = parseJsonWithBom<Record<string, unknown>>(readFileSync(this.settingsPath, 'utf-8'));
        const source = settings.env && typeof settings.env === 'object'
          ? settings.env as Record<string, unknown>
          : settings;
        const fromFile = source.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID;
        if (typeof fromFile === 'string' && fromFile.trim() !== '') {
          this.deviceId = fromFile.trim();
        }
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      logger.warn('BACKUP', 'Could not re-read settings for the cloud-sync device id', { settingsPath: this.settingsPath }, normalized);
    }
    return this.deviceId;
  }

  // Same read-mutate-write pattern as CloudSync.persistDeviceId: tolerate the
  // legacy nested {env:{...}} shape rather than writing a mixed schema.
  private persistSettingsKey(key: string, value: string): void {
    let settings: Record<string, unknown>;
    if (existsSync(this.settingsPath)) {
      settings = parseJsonWithBom<Record<string, unknown>>(readFileSync(this.settingsPath, 'utf-8'));
    } else {
      settings = { ...SettingsDefaultsManager.getAllDefaults() };
    }
    const target = settings.env && typeof settings.env === 'object'
      ? settings.env as Record<string, unknown>
      : settings;
    target[key] = value;
    writeJsonFileAtomic(this.settingsPath, settings);
  }

  // -------------------------------------------------------------------------
  // Loop internals (shape copied from SyncClient.schedule()/tick())
  // -------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    (timer as { unref?: () => void }).unref?.(); // never hold the process open
    this.timer = timer;
    this.nextRunAt = this.now() + delayMs;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.runOnce();
    if (this.stopped) return;
    this.schedule(this.intervalMs);
  }

  /**
   * Disk pre-flight copied from CleanupV12_4_3: refuse to snapshot when free
   * space is credibly below 1.2× the DB size + 100 MiB. statfs failures and
   * non-credible readings (Bun <= 1.3.14 darwin-x64 returns a misaligned
   * struct with bsize = 0 — https://github.com/oven-sh/bun/issues/31133)
   * skip the gate rather than block: a real out-of-space condition still
   * surfaces from the subsequent VACUUM INTO / copyFileSync.
   */
  private assertDiskSpace(dbSize: number): void {
    const required = Math.ceil(dbSize * 1.2) + 100 * 1024 * 1024;

    let fsStats: ReturnType<typeof statfsSync> | undefined;
    try {
      fsStats = statfsSync(this.preflightDir);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn('BACKUP', 'statfsSync failed; proceeding without disk-space pre-flight', {}, error);
    }
    if (!fsStats) return;

    const bsize = Number(fsStats.bsize);
    const bavail = Number(fsStats.bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail) || bsize <= 0) {
      logger.warn(
        'BACKUP',
        'statfsSync returned non-credible values; proceeding without disk-space pre-flight',
        {
          bsize,
          bavail,
          runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : 'node',
          platform: `${process.platform}-${process.arch}`,
          hint: 'see https://github.com/oven-sh/bun/issues/31133 for the darwin-x64 case',
        },
      );
      return;
    }

    const free = bavail * bsize;
    if (free < required) {
      throw new Error(`Insufficient disk for backup snapshot (free=${free}, required=${required})`);
    }
  }

  /** Snapshot basenames, newest first. */
  private listSnapshotNames(): string[] {
    if (!existsSync(this.backupsDir)) return [];
    return readdirSync(this.backupsDir)
      .filter(name => SNAPSHOT_FILE_PATTERN.test(name))
      .sort()
      .reverse();
  }
}
