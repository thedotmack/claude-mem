
// Pro-backup plan Phase 4: the file-backed addon_required marker
// (backup-addon-marker.ts, pro-fallback.ts pattern). Written by the worker's
// BackupManager on a hub 403 addon_required, read by short-lived CLI
// processes (doctor, `backup status`) — 0600 on disk, 24h TTL self-clearing
// on read so uploads are retried at most daily.

import { describe, it, expect, afterEach, beforeEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BACKUP_ADDON_PROBE_INTERVAL_MS,
  BACKUP_ADDON_TTL_MS,
  activateBackupAddonRequired,
  clearBackupAddonRequired,
  isBackupAddonRequired,
  readBackupAddonState,
} from '../../src/shared/backup-addon-marker.js';
import { logger } from '../../src/utils/logger.js';

let tempRoot: string;
let markerPath: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-addon-marker-'));
  markerPath = join(tempRoot, 'backup-addon-required.json');
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

describe('backup add-on marker', () => {
  it('activate → read round trip with the {active, reason, activatedAt} shape', () => {
    const nowMs = Date.parse('2026-08-26T12:00:00.000Z');
    activateBackupAddonRequired('addon_required', markerPath, nowMs);

    const state = readBackupAddonState(markerPath);
    expect(state).toEqual({
      active: true,
      reason: 'addon_required',
      activatedAt: '2026-08-26T12:00:00.000Z',
    });
    expect(isBackupAddonRequired(markerPath, nowMs)).toBe(true);

    // The raw file is plain JSON with exactly that shape.
    const raw = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(raw).toEqual(state);
  });

  it('writes the marker file with mode 0600', () => {
    activateBackupAddonRequired('addon_required', markerPath);
    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
  });

  it('clear removes the file; reads become null/inactive', () => {
    activateBackupAddonRequired('addon_required', markerPath);
    expect(existsSync(markerPath)).toBe(true);

    clearBackupAddonRequired(markerPath);
    expect(existsSync(markerPath)).toBe(false);
    expect(readBackupAddonState(markerPath)).toBeNull();
    expect(isBackupAddonRequired(markerPath)).toBe(false);

    // Clearing an already-absent marker is a no-op, not an error.
    clearBackupAddonRequired(markerPath);
  });

  it('self-clears on read once the 24h TTL has elapsed', () => {
    const activatedMs = Date.parse('2026-08-26T12:00:00.000Z');
    activateBackupAddonRequired('addon_required', markerPath, activatedMs);

    // Still active right up to the TTL boundary...
    expect(isBackupAddonRequired(markerPath, activatedMs + BACKUP_ADDON_TTL_MS)).toBe(true);
    expect(existsSync(markerPath)).toBe(true);

    // ...and one ms past it the read reports inactive AND deletes the file,
    // so the next upload cycle optimistically retries.
    expect(isBackupAddonRequired(markerPath, activatedMs + BACKUP_ADDON_TTL_MS + 1)).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('treats a malformed marker file as inactive', () => {
    writeFileSync(markerPath, 'not json at all');
    expect(readBackupAddonState(markerPath)).toBeNull();
    expect(isBackupAddonRequired(markerPath)).toBe(false);

    writeFileSync(markerPath, JSON.stringify({ reason: 'missing-active-flag' }));
    expect(readBackupAddonState(markerPath)).toBeNull();
    expect(isBackupAddonRequired(markerPath)).toBe(false);
  });

  it('a marker with an unparseable activatedAt self-clears rather than pinning forever', () => {
    writeFileSync(markerPath, JSON.stringify({ active: true, reason: 'addon_required', activatedAt: 'never' }));
    expect(isBackupAddonRequired(markerPath)).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('exposes the daily TTL and 5-minute probe interval constants', () => {
    expect(BACKUP_ADDON_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(BACKUP_ADDON_PROBE_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
