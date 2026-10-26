import { join, dirname } from 'path';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync } from 'fs';
import { DB_PATH, paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { runSqliteFileJob } from './sqlite-file-job.js';
import { SNAPSHOT_FILE_PATTERN } from './snapshot-files.js';

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
  /** Delay before the first scheduled run after start(). */
  initialDelayMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface BackupSnapshotResult {
  path: string;
  bytes: number;
  createdAt: number;
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
 * The first scheduled snapshot waits this long after worker start, so it
 * never competes with boot work (migrations, backfills, the spool drain) for
 * the database.
 */
const DEFAULT_INITIAL_DELAY_MS = 5 * 60_000;

/** A snapshot still being written, or left behind by a crash mid-write. */
const PARTIAL_SNAPSHOT_PATTERN = /\.db\.partial(-wal|-shm|-journal)?$/;

/**
 * Automatic local SQLite snapshots with retention.
 *
 * Snapshot engine extracted from the one-time v12.4.3 cleanup backup
 * (CleanupV12_4_3.ts): disk pre-flight, then `VACUUM INTO`, in a child
 * process so the worker keeps serving requests during a multi-GB snapshot.
 * Unlike that one-time backup there is no raw-copy fallback: copying a live
 * db and its WAL separately can pair two different states. Every snapshot ends as one standalone,
 * quick_check-verified file in rollback-journal mode, so a snapshot never
 * depends on a sidecar. The schedule loop is SyncClient's self-rescheduling
 * unref'd setTimeout chain (the worker has no setInterval of its own) with a
 * single-flight guard, so a slow snapshot can never stack a second cycle.
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
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  /** Arm the cadence loop; the first run lands initialDelayMs after start. */
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

  /**
   * Snapshot facts come from the files on disk, so they survive the worker
   * restarts that enabling backups and restoring both go through.
   */
  status(): BackupStatus {
    const names = this.listSnapshotNames();
    const newest = names[0] ? statSync(join(this.backupsDir, names[0])) : null;
    return {
      configured: true,
      lastSnapshotAt: newest ? newest.mtimeMs : null,
      lastSnapshotBytes: newest ? newest.size : null,
      snapshotCount: names.length,
      lastError: this.lastError,
      nextRunAt: this.nextRunAt,
    };
  }

  /**
   * One consistent, standalone snapshot of the live DB. Disk pre-flight, then
   * (in a child process, see sqlite-file-job.ts) `VACUUM INTO` on a readonly
   * connection, made standalone and quick_check-verified. Throws when no
   * verified snapshot could be produced, and leaves no partial file behind.
   */
  async createSnapshot(): Promise<BackupSnapshotResult> {
    const dbSize = statSync(this.dbPath).size;
    this.assertDiskSpace(dbSize);

    mkdirSync(this.backupsDir, { recursive: true });
    const createdAt = this.now();
    const ts = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
    const backupPath = join(this.backupsDir, `claude-mem-${ts}.db`);

    // Written under a .partial name (outside SNAPSHOT_FILE_PATTERN) and
    // renamed only once verified, so status, list, retention and restore
    // never see an unfinished snapshot.
    const partialPath = `${backupPath}.partial`;
    this.removePartialSnapshots();
    try {
      await runSqliteFileJob({ kind: 'snapshot', source: this.dbPath, target: partialPath });
      renameSync(partialPath, backupPath);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const leftover of [partialPath, `${partialPath}-wal`, `${partialPath}-shm`]) {
        if (existsSync(leftover)) unlinkSync(leftover);
      }
      logger.error('BACKUP', 'Snapshot failed; no snapshot was kept', { backupPath }, error);
      throw error;
    }

    const bytes = statSync(backupPath).size;
    logger.info('BACKUP', 'Snapshot created', { backupPath, dbSize, bytes });
    this.lastError = null;
    return { path: backupPath, bytes, createdAt };
  }

  /**
   * Keep the retainCount most-recent snapshots; delete the rest. Sanitized
   * ISO filenames sort lexicographically, so name order is timestamp order.
   */
  async applyRetention(): Promise<void> {
    const names = this.listSnapshotNames();
    const excess = names.slice(this.retainCount);
    for (const name of excess) {
      const snapshotPath = join(this.backupsDir, name);
      unlinkSync(snapshotPath);
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
   * Cadence-loop wrapper around runNow(): failures are logged, never thrown,
   * so the loop survives a bad cycle and tries again next interval.
   */
  async runOnce(): Promise<void> {
    try {
      await this.runNow();
    } catch (error) {
      logger.error('BACKUP', 'Snapshot cycle failed', {}, error instanceof Error ? error : new Error(String(error)));
    }
  }

  // Loop internals (shape copied from SyncClient.schedule()/tick())

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
   * space is credibly below 1.2x the DB size + 100 MiB (VACUUM INTO writes a
   * full copy, plus headroom so a snapshot never fills the disk the live DB
   * needs). statfs failures and non-credible readings (Bun <= 1.3.14
   * darwin-x64 returns a misaligned struct with bsize = 0,
   * https://github.com/oven-sh/bun/issues/31133) skip the gate rather than
   * block: a real out-of-space condition still surfaces from the write.
   */
  private assertDiskSpace(dbSize: number): void {
    const required = Math.ceil(dbSize * 1.2) + 100 * 1024 * 1024;

    let fsStats: ReturnType<typeof statfsSync> | undefined;
    try {
      fsStats = statfsSync(this.preflightDir);
    } catch (err: unknown) {
      logger.warn('BACKUP', 'statfsSync failed; proceeding without disk-space pre-flight', {}, err instanceof Error ? err : new Error(String(err)));
    }
    if (!fsStats) return;

    const bsize = Number(fsStats.bsize);
    const bavail = Number(fsStats.bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail) || bsize <= 0) {
      logger.warn('BACKUP', 'statfsSync returned non-credible values; proceeding without disk-space pre-flight', {
        bsize,
        bavail,
        runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : 'node',
        platform: `${process.platform}-${process.arch}`,
      });
      return;
    }

    const free = bavail * bsize;
    if (free < required) {
      throw new Error(`Insufficient disk for backup snapshot (free=${free}, required=${required})`);
    }
  }

  /** Leftovers of a snapshot interrupted by a crash or kill. */
  private removePartialSnapshots(): void {
    for (const name of readdirSync(this.backupsDir)) {
      if (PARTIAL_SNAPSHOT_PATTERN.test(name)) unlinkSync(join(this.backupsDir, name));
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
