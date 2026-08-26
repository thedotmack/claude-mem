/**
 * File-backed "backup add-on required" state (pro-backup plan Phase 4), so a
 * definitive 403 `addon_required` from the sync hub switches cloud uploads
 * off — while LOCAL snapshots keep running — instead of hammering the hub
 * with a doomed upload every cadence cycle.
 *
 * A file — not in-memory state — because the flag is written by the worker's
 * BackupManager and read by short-lived CLI processes (doctor, `backup
 * status`), which never share a process. Same marker pattern as
 * pro-fallback.ts: 0600 JSON file under the data dir.
 *
 * The state carries a 24h TTL evaluated on read (no timers): after expiry,
 * isBackupAddonRequired() self-clears and the next cadence cycle
 * optimistically retries the upload — so the system self-heals within a day
 * of the user buying the add-on, and the next 403 simply re-activates the
 * marker. Entitlement detection stays strictly reactive (server-enforced
 * 403s); nothing here polls the hub.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

export interface BackupAddonState {
  active: boolean;
  /** Hub error code that activated the marker (e.g. 'addon_required'). */
  reason: string;
  /** ISO timestamp of activation — the TTL clock. */
  activatedAt: string;
}

export const BACKUP_ADDON_MARKER_FILENAME = 'backup-addon-required.json';

/** Retry the upload daily: past this age the state self-clears on read. */
export const BACKUP_ADDON_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Mirrors PRO_FALLBACK_PROBE_INTERVAL_MS: a caller that wants to probe more
 * eagerly than the daily TTL may let one request through per interval while
 * the marker is fresher than this. The cadence loop itself runs daily, so
 * BackupManager only consults the TTL — this constant exists for
 * shorter-cycle callers (manual `backup run`, future viewer actions).
 */
export const BACKUP_ADDON_PROBE_INTERVAL_MS = 5 * 60 * 1000;

function defaultMarkerFilePath(): string {
  return join(paths.dataDir(), BACKUP_ADDON_MARKER_FILENAME);
}

export function readBackupAddonState(
  filePath: string = defaultMarkerFilePath(),
): BackupAddonState | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const state = parsed as Partial<BackupAddonState>;
    if (typeof state.active !== 'boolean') return null;
    return {
      active: state.active,
      reason: typeof state.reason === 'string' ? state.reason : '',
      activatedAt: typeof state.activatedAt === 'string' ? state.activatedAt : '',
    };
  } catch (error) {
    logger.warn('BACKUP', 'Failed to read backup add-on marker file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

export function activateBackupAddonRequired(
  reason: string,
  filePath: string = defaultMarkerFilePath(),
  nowMs: number = Date.now(),
): void {
  const state: BackupAddonState = {
    active: true,
    reason,
    activatedAt: new Date(nowMs).toISOString(),
  };
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(filePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    logger.warn('BACKUP', 'Failed to write backup add-on marker file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

export function clearBackupAddonRequired(filePath: string = defaultMarkerFilePath()): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch (error) {
    logger.warn('BACKUP', 'Failed to clear backup add-on marker file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * True while an addon_required marker is fresh (< 24h). An expired marker is
 * deleted on the spot and reads as inactive, so the upload is retried at
 * most a day after the 403 that activated the marker.
 */
export function isBackupAddonRequired(
  filePath: string = defaultMarkerFilePath(),
  nowMs: number = Date.now(),
): boolean {
  const state = readBackupAddonState(filePath);
  if (!state || !state.active) return false;
  const activatedAtMs = Date.parse(state.activatedAt);
  if (!Number.isFinite(activatedAtMs) || nowMs - activatedAtMs > BACKUP_ADDON_TTL_MS) {
    clearBackupAddonRequired(filePath);
    return false;
  }
  return true;
}
