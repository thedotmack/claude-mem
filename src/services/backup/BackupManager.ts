
import { join, dirname } from 'path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, statfsSync, unlinkSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DB_PATH, paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

/** Settings keys BackupManager reads (subset of SettingsDefaults). */
export interface BackupSettingKeys {
  CLAUDE_MEM_BACKUP_INTERVAL_HOURS?: string;
  CLAUDE_MEM_BACKUP_RETAIN_COUNT?: string;
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
}

/**
 * Automatic snapshots are named claude-mem-<sanitized ISO ts>.db. The
 * fallback-copy sidecars end in `.db-wal`/`.db-shm`, so the trailing `.db`
 * anchor keeps them out of the snapshot listing (they are pruned alongside
 * their parent file).
 */
const SNAPSHOT_FILE_PATTERN = /^claude-mem-.*\.db$/;

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

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  /** Single-flight: true while a snapshot cycle is in progress. */
  private running = false;

  private lastSnapshotAt: number | null = null;
  private lastSnapshotBytes: number | null = null;
  private lastError: string | null = null;
  private nextRunAt: number | null = null;

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
   * One snapshot + retention cycle. Single-flight; failures are recorded in
   * lastError and logged, never thrown — the cadence loop must survive a bad
   * cycle and try again next interval.
   */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.createSnapshot();
      await this.applyRetention();
      logger.info('BACKUP', 'Snapshot cycle complete', { path: result.path, bytes: result.bytes, method: result.method });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.lastError = normalized.message;
      logger.error('BACKUP', 'Snapshot cycle failed', {}, normalized);
    } finally {
      this.running = false;
    }
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
