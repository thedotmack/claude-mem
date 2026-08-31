/**
 * Outbound connector that mirrors claude-mem observations into a gbrain brain
 * (https://github.com/garrytan/gbrain) via its CLI. Modeled on ChromaSync.
 *
 * Two write lanes share one renderer (GbrainMarkdown):
 *   1. Live trickle — `gbrain capture --stdin --slug <slug> --type note --json`
 *      per observation, fire-and-forget from the worker's post-store path.
 *   2. Backfill — render unsynced rows to a staging dir, run
 *      `gbrain import <dir> --no-embed --json` per 1000-row chunk, then
 *      `gbrain embed --stale` once at the end.
 *
 * Integration is CLI-only (there is no gbrain npm package). Slugs are
 * deterministic (`<prefix>/<project>/obs-<id>`) and gbrain dedupes on content
 * hash, so both lanes are idempotent. Watermarks (GbrainSyncState) advance
 * ONLY on confirmed success — the ChromaSync correctness rule.
 *
 * Error discipline: nothing thrown from this class may escape into the
 * observation write path — every public method catches, logs, and continues.
 * After 3 consecutive CLI failures the connector disables itself for the rest
 * of the session so a broken install is not fork-bombed.
 */
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, expandTilde } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { GbrainSyncState } from './GbrainSyncState.js';
import {
  GbrainObservationSource,
  observationSlug,
  renderObservationMarkdown,
} from './GbrainMarkdown.js';
import { parseFileList } from '../sqlite/observations/files.js';
// Type-only import: SessionStore's value graph reaches `bun:sqlite`, which
// must stay out of non-worker bundles (same discipline as ChromaSync.ts).
import type { SessionStore as SessionStoreType } from '../sqlite/SessionStore.js';
import type { ObservationRow } from '../sqlite/types.js';

type SessionStore = SessionStoreType;

interface GbrainSyncConfig {
  cliPath: string;
  sourceId: string;
  slugPrefix: string;
  projectsFilter: string[];
}

interface GbrainRunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  failure?: string;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export class GbrainSync {
  private static readonly CAPTURE_TIMEOUT_MS = 15_000;
  private static readonly BULK_TIMEOUT_MS = 600_000;
  private static readonly BACKFILL_CHUNK_SIZE = 1000;
  private static readonly LARGE_BACKFILL_THRESHOLD = 5000;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;

  /** Guard flag to prevent overlapping backfill runs from fire-and-forget callers. */
  private static backfillInProgress = false;
  /** One in-process CLI lane: gbrain's default PGLite brain is single-writer. */
  private static cliQueue: Promise<void> = Promise.resolve();

  private readonly config: GbrainSyncConfig;
  private consecutiveFailures = 0;
  private disabledForSession = false;
  private warnedFailureClasses = new Set<string>();

  constructor(config: GbrainSyncConfig) {
    this.config = config;
  }

  /**
   * Settings gate copied from TelegramNotifier: load the flat settings file,
   * return null unless the connector is explicitly enabled.
   */
  static fromSettings(): GbrainSync | null {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    if (settings.CLAUDE_MEM_GBRAIN_ENABLED !== 'true') {
      return null;
    }

    const cliPathSetting = settings.CLAUDE_MEM_GBRAIN_CLI_PATH.trim();
    return new GbrainSync({
      cliPath: expandTilde(cliPathSetting.length > 0 ? cliPathSetting : 'gbrain'),
      sourceId: settings.CLAUDE_MEM_GBRAIN_SOURCE.trim(),
      slugPrefix: settings.CLAUDE_MEM_GBRAIN_SLUG_PREFIX.trim() || 'claude-mem',
      projectsFilter: splitCsv(settings.CLAUDE_MEM_GBRAIN_PROJECTS),
    });
  }

  /** Empty filter = sync every project; otherwise a comma-separated allowlist. */
  shouldSyncProject(project: string): boolean {
    return this.config.projectsFilter.length === 0
      || this.config.projectsFilter.includes(project);
  }

  isDisabledForSession(): boolean {
    return this.disabledForSession;
  }

  /**
   * Live lane: mirror one just-stored observation into gbrain. Fire-and-forget
   * safe — never throws, never blocks on failure classes beyond the timeout.
   */
  async syncObservation(
    observationId: number,
    project: string,
    obs: ParsedObservation,
    createdAtEpoch: number,
    memorySessionId: string,
  ): Promise<void> {
    if (this.disabledForSession || !this.shouldSyncProject(project)) {
      return;
    }

    try {
      const source: GbrainObservationSource = {
        id: observationId,
        project,
        memorySessionId,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        narrative: obs.narrative,
        facts: obs.facts,
        concepts: obs.concepts,
        filesRead: obs.files_read,
        filesModified: obs.files_modified,
        createdAtEpoch,
      };
      const markdown = renderObservationMarkdown(source);
      const slug = observationSlug(this.config.slugPrefix, project, observationId);

      const args = ['capture', '--stdin', '--slug', slug, '--type', 'note', '--json'];
      if (this.config.sourceId) {
        args.push('--source', this.config.sourceId);
      }

      const result = await this.runGbrain(args, {
        stdinContent: markdown,
        timeoutMs: GbrainSync.CAPTURE_TIMEOUT_MS,
      });

      if (!result.ok) {
        this.warnOnce('capture', 'gbrain capture failed — watermark not advanced', {
          observationId,
          project,
          slug,
          code: result.code,
          failure: result.failure,
          stderr: result.stderr.slice(0, 500),
        });
      }
      // Live captures deliberately do NOT advance the backfill watermark.
      // Observation ids are global (not contiguous per project), captures can
      // complete out of order, and other write lanes may not call this method.
      // Advancing to a later live id would make `id > watermark` permanently
      // skip any earlier hole. The next idempotent bulk backfill is the only
      // authority that advances the contiguous exported prefix.
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('GBRAIN_SYNC', 'syncObservation failed', {
        observationId,
        project,
        memorySessionId,
      }, err);
    }
  }

  /**
   * Backfill lane: export every observation above the project watermark via
   * gbrain's bulk import path. Chunked at 1000 rows; the watermark advances
   * per confirmed chunk only. Never throws.
   */
  async ensureBackfilled(project: string, store: SessionStore): Promise<void> {
    if (this.disabledForSession || !this.shouldSyncProject(project)) {
      return;
    }

    try {
      await this.runBackfill(project, store);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('GBRAIN_SYNC', 'Backfill failed — watermark left where it was', { project }, err);
    }
  }

  /**
   * Backfill every project with observations. Fire-and-forget from worker
   * boot (Phase 2 wiring), mirroring ChromaSync.backfillAllProjects but
   * serial: gbrain's PGLite backend is single-writer, so concurrent CLI
   * processes would contend on the same brain.
   */
  static async backfillAllProjects(store: SessionStore): Promise<void> {
    if (GbrainSync.backfillInProgress) {
      logger.info('GBRAIN_SYNC', 'Backfill already in progress, skipping duplicate run');
      return;
    }

    const sync = GbrainSync.fromSettings();
    if (!sync) {
      return;
    }

    GbrainSync.backfillInProgress = true;
    try {
      const projects = store.db.prepare(
        'SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ?'
      ).all('') as { project: string }[];

      logger.info('GBRAIN_SYNC', `Backfill check for ${projects.length} projects`);

      for (const { project } of projects) {
        if (sync.disabledForSession) {
          logger.warn('GBRAIN_SYNC', 'Connector disabled for session — stopping backfill sweep', { project });
          break;
        }
        await sync.ensureBackfilled(project, store);
      }
    } finally {
      GbrainSync.backfillInProgress = false;
    }
  }

  private async runBackfill(project: string, store: SessionStore): Promise<void> {
    const startingWatermark = GbrainSyncState.get(project).observations;
    const countRow = store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM observations
      WHERE project = ? AND id > ?
    `).get(project, startingWatermark) as { count: number } | null;
    const unsynced = Number(countRow?.count ?? 0);

    if (unsynced === 0) {
      return;
    }

    if (unsynced > GbrainSync.LARGE_BACKFILL_THRESHOLD) {
      logger.info('GBRAIN_SYNC', 'Large backfill — processing in chunks', {
        project,
        unsynced,
        chunkSize: GbrainSync.BACKFILL_CHUNK_SIZE,
      });
    }

    logger.info('GBRAIN_SYNC', 'Backfilling observations', {
      project,
      unsynced,
      watermark: startingWatermark,
    });

    let importedRows = 0;
    while (!this.disabledForSession) {
      const watermark = GbrainSyncState.get(project).observations;
      const chunk = store.db.prepare(`
        SELECT *
        FROM observations
        WHERE project = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?
      `).all(project, watermark, GbrainSync.BACKFILL_CHUNK_SIZE) as ObservationRow[];
      if (chunk.length === 0) {
        break;
      }

      if (this.disabledForSession) {
        break;
      }
      const chunkImported = await this.importChunk(project, chunk);
      if (!chunkImported) {
        logger.warn('GBRAIN_SYNC', 'Chunk import failed — watermark not advanced, stopping backfill for project', {
          project,
          chunkStartId: chunk[0].id,
          chunkSize: chunk.length,
        });
        break;
      }

      // Confirmed success for the whole chunk: advance to its max id.
      GbrainSyncState.bump(project, chunk[chunk.length - 1].id);
      importedRows += chunk.length;
      logger.info('GBRAIN_SYNC', 'Backfill progress', {
        project,
        progress: `${Math.min(importedRows, unsynced)}/${unsynced}`,
        watermark: GbrainSyncState.get(project).observations,
      });
    }

    if (importedRows > 0) {
      // Pages are already durably imported (watermark advanced); embedding is
      // gbrain's own stale-tracked, idempotent pass — a failure here is
      // retried by the next `embed --stale`, ours or the user's.
      const embed = await this.runGbrain(['embed', '--stale'], {
        timeoutMs: GbrainSync.BULK_TIMEOUT_MS,
      });
      if (!embed.ok) {
        this.warnOnce('embed', 'gbrain embed --stale failed after import — embeddings remain stale until the next run', {
          project,
          code: embed.code,
          failure: embed.failure,
          stderr: embed.stderr.slice(0, 500),
        });
      }
    }

    logger.info('GBRAIN_SYNC', 'Backfill complete', {
      project,
      importedRows,
      watermark: GbrainSyncState.get(project).observations,
    });
  }

  /**
   * Stage one chunk of rows as `<staging>/<slugPrefix>/<project>/obs-<id>.md`
   * and run `gbrain import <staging> --no-embed --json`. Import slugs are
   * derived from the path relative to the staging root (gbrain
   * src/core/import-file.ts: `slugifyPath(relativePath)` is authoritative),
   * so staged pages land on exactly the slugs the capture lane uses.
   */
  private async importChunk(project: string, chunk: ObservationRow[]): Promise<boolean> {
    const stagingDir = mkdtempSync(join(tmpdir(), 'claude-mem-gbrain-staging-'));
    try {
      for (const row of chunk) {
        const markdown = renderObservationMarkdown(this.rowToSource(row));
        const slug = observationSlug(this.config.slugPrefix, project, row.id);
        const filePath = join(stagingDir, ...slug.split('/')) + '.md';
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, markdown, 'utf8');
      }

      const args = ['import', stagingDir, '--no-embed', '--json'];
      if (this.config.sourceId) {
        args.push('--source-id', this.config.sourceId);
      }

      const result = await this.runGbrain(args, { timeoutMs: GbrainSync.BULK_TIMEOUT_MS });
      if (!result.ok) {
        this.warnOnce('import', 'gbrain import failed', {
          project,
          stagingDir,
          code: result.code,
          failure: result.failure,
          stderr: result.stderr.slice(0, 500),
        });
        return false;
      }

      // Exit 0 can still carry per-file errors in the --json summary; any
      // errored file means the chunk is not fully synced — do not bump.
      const summaryErrors = this.parseImportErrorCount(result.stdout);
      if (summaryErrors === null) {
        this.warnOnce('import-json', 'gbrain import returned invalid --json output — watermark not advanced for chunk', {
          project,
          stdout: result.stdout.slice(0, 500),
        });
        return false;
      }
      if (summaryErrors > 0) {
        this.warnOnce('import-partial', 'gbrain import reported per-file errors — watermark not advanced for chunk', {
          project,
          errors: summaryErrors,
        });
        return false;
      }

      return true;
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  private parseImportErrorCount(stdout: string): number | null {
    try {
      const parsed = JSON.parse(stdout) as { status?: unknown; errors?: unknown };
      if (parsed.status !== undefined && parsed.status !== 'success') return null;
      return Number.isInteger(parsed.errors) && (parsed.errors as number) >= 0
        ? parsed.errors as number
        : null;
    } catch {
      return null;
    }
  }

  private rowToSource(row: ObservationRow): GbrainObservationSource {
    return {
      id: row.id,
      project: row.project,
      memorySessionId: row.memory_session_id,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      narrative: row.narrative,
      facts: this.parseJsonStringArray(row.facts),
      concepts: this.parseJsonStringArray(row.concepts),
      filesRead: parseFileList(row.files_read),
      filesModified: parseFileList(row.files_modified),
      createdAtEpoch: row.created_at_epoch,
    };
  }

  private parseJsonStringArray(value: string | null): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch (error) {
      logger.warn('GBRAIN_SYNC', 'Failed to parse stored JSON array column, exporting without it', { value }, error as Error);
      return [];
    }
  }

  /**
   * Run the gbrain CLI once. Async `spawn` from child_process — the codebase's
   * async-spawn precedent (ServerService.ts:861, ChromaMcpManager.ts) — never
   * spawnSync, which would block the worker's event loop for the timeout.
   * Resolves (never rejects); failure classes come back in `failure`.
   */
  private async runGbrain(
    args: string[],
    opts: { stdinContent?: string; timeoutMs: number },
  ): Promise<GbrainRunResult> {
    if (this.disabledForSession) {
      return { ok: false, code: null, stdout: '', stderr: '', failure: 'disabled-for-session' };
    }

    const execute = async (): Promise<GbrainRunResult> => {
      // Calls from one observation batch are launched concurrently. Re-check
      // after waiting in the queue so the three-failure circuit breaker stops
      // already-enqueued work instead of allowing the whole batch to spawn.
      if (this.disabledForSession) {
        return { ok: false, code: null, stdout: '', stderr: '', failure: 'disabled-for-session' };
      }

      return new Promise<GbrainRunResult>(resolve => {
        let settled = false;
        const settle = (value: GbrainRunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };

        let stdout = '';
        let stderr = '';

        const child = spawn(this.config.cliPath, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          settle({ ok: false, code: null, stdout, stderr, failure: 'timeout' });
        }, opts.timeoutMs);

        child.on('error', error => {
          // e.g. ENOENT — the CLI is not installed or the configured path is wrong.
          settle({ ok: false, code: null, stdout, stderr, failure: `spawn-error: ${error.message}` });
        });

        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        child.on('close', code => {
          settle(code === 0
            ? { ok: true, code, stdout, stderr }
            : { ok: false, code, stdout, stderr, failure: 'nonzero-exit' });
        });

        if (opts.stdinContent !== undefined) {
          child.stdin.on('error', () => { /* EPIPE when the child dies early — 'close' reports the failure */ });
          child.stdin.write(opts.stdinContent);
        }
        child.stdin.end();
      });
    };

    const queued = GbrainSync.cliQueue.then(execute, execute);
    GbrainSync.cliQueue = queued.then(() => undefined, () => undefined);
    let result: GbrainRunResult;
    try {
      result = await queued;
    } catch (error) {
      // child_process.spawn normally reports ENOENT through `error`, but some
      // malformed executable values throw synchronously. Preserve this
      // method's never-reject contract and count those toward the breaker too.
      const message = error instanceof Error ? error.message : String(error);
      result = { ok: false, code: null, stdout: '', stderr: '', failure: `spawn-error: ${message}` };
    }

    if (result.failure !== 'disabled-for-session') {
      this.trackFailureStreak(result, args[0]);
    }
    return result;
  }

  /** After 3 consecutive CLI failures, stop spawning for the rest of the session. */
  private trackFailureStreak(result: GbrainRunResult, command: string): void {
    if (result.ok) {
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures >= GbrainSync.MAX_CONSECUTIVE_FAILURES && !this.disabledForSession) {
      this.disabledForSession = true;
      logger.warn('GBRAIN_SYNC', 'Disabling gbrain sync for this session after repeated CLI failures', {
        consecutiveFailures: this.consecutiveFailures,
        lastCommand: command,
        lastFailure: result.failure,
        cliPath: this.config.cliPath,
      });
    }
  }

  /** logger.warn once per session per failure class; debug after that. */
  private warnOnce(failureClass: string, message: string, context: Record<string, unknown>): void {
    if (this.warnedFailureClasses.has(failureClass)) {
      logger.debug('GBRAIN_SYNC', message, context);
      return;
    }
    this.warnedFailureClasses.add(failureClass);
    logger.warn('GBRAIN_SYNC', message, context);
  }
}
