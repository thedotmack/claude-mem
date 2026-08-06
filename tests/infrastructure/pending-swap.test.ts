import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claude-mem-pending-swap-test-'));
const PREVIOUS_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

const { stagePendingSwap, applyPendingSwaps } = await import('../../src/services/infrastructure/PendingSwap.js');
const { paths } = await import('../../src/shared/paths.js');

const DATA_DIR = paths.dataDir();

/**
 * NOTE ON ISOLATION: the mkdtemp + CLAUDE_MEM_DATA_DIR override above is INERT
 * whenever another test file already imported src/shared/paths.js first —
 * paths.ts freezes DATA_DIR at first module evaluation and bun runs the whole
 * suite in one process. So DATA_DIR here is usually the run-wide dir from
 * tests/preload.ts, SHARED with every other test file. This file therefore
 * must never assume it owns the directory: it resets only the basenames it
 * itself touches before each test, and never asserts "nothing else is here".
 */
const OWNED_BASENAMES = [
  'claude-mem.db',
  'claude-mem.db-wal',
  'claude-mem.db-shm',
  'settings.json',
  '.env',
];

function resetOwnedFiles(): void {
  if (!existsSync(DATA_DIR)) return;
  for (const basename of OWNED_BASENAMES) {
    rmSync(path.join(DATA_DIR, basename), { force: true });
    rmSync(path.join(DATA_DIR, `${basename}.importing`), { force: true });
  }
}

const p = (basename: string) => path.join(DATA_DIR, basename);

describe('PendingSwap', () => {
  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    resetOwnedFiles();
  });

  afterAll(() => {
    if (PREVIOUS_DATA_DIR === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = PREVIOUS_DATA_DIR;
    }
    // Clean up only what this file created — DATA_DIR may be the shared
    // run-wide dir, so a blanket wipe would rip files out from under other
    // test files.
    resetOwnedFiles();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('stages a file under <name>.importing without touching the real target', () => {
    stagePendingSwap('settings.json', Buffer.from('{"staged":true}'));

    expect(existsSync(p('settings.json.importing'))).toBe(true);
    // Safe to assert absence: beforeEach removed this exact basename, and no
    // other test file runs concurrently with this one.
    expect(existsSync(p('settings.json'))).toBe(false);
  });

  it('applyPendingSwaps renames staged files over their targets and returns the swapped basenames', () => {
    writeFileSync(p('claude-mem.db'), 'old-db-content');
    stagePendingSwap('claude-mem.db', Buffer.from('new-db-content'));
    stagePendingSwap('settings.json', Buffer.from('{"new":true}'));

    const swapped = applyPendingSwaps();

    expect(swapped.sort()).toEqual(['claude-mem.db', 'settings.json']);
    expect(readFileSync(p('claude-mem.db'), 'utf-8')).toBe('new-db-content');
    expect(readFileSync(p('settings.json'), 'utf-8')).toBe('{"new":true}');
    expect(existsSync(p('claude-mem.db.importing'))).toBe(false);
    expect(existsSync(p('settings.json.importing'))).toBe(false);
  });

  it('applyPendingSwaps returns an empty array when nothing is staged', () => {
    expect(applyPendingSwaps()).toEqual([]);
  });

  describe('orphaned sqlite sidecars', () => {
    it('deletes a pre-existing -wal/-shm when the db is restored without them', () => {
      writeFileSync(p('claude-mem.db'), 'old-db-content');
      writeFileSync(p('claude-mem.db-wal'), 'stale-wal-frames');
      writeFileSync(p('claude-mem.db-shm'), 'stale-shm');

      stagePendingSwap('claude-mem.db', Buffer.from('restored-db-content'));

      const swapped = applyPendingSwaps();

      expect(swapped).toEqual(['claude-mem.db']);
      expect(readFileSync(p('claude-mem.db'), 'utf-8')).toBe('restored-db-content');
      // The stale WAL belongs to the PREVIOUS database. Leaving it behind lets
      // SQLite replay foreign frames into the fresh db on next open.
      expect(existsSync(p('claude-mem.db-wal'))).toBe(false);
      expect(existsSync(p('claude-mem.db-shm'))).toBe(false);
    });

    it('keeps a -wal/-shm that was restored in the same swap batch', () => {
      writeFileSync(p('claude-mem.db'), 'old-db-content');
      writeFileSync(p('claude-mem.db-wal'), 'stale-wal-frames');

      stagePendingSwap('claude-mem.db', Buffer.from('restored-db-content'));
      stagePendingSwap('claude-mem.db-wal', Buffer.from('restored-wal-frames'));
      stagePendingSwap('claude-mem.db-shm', Buffer.from('restored-shm'));

      const swapped = applyPendingSwaps();

      expect(swapped.sort()).toEqual(['claude-mem.db', 'claude-mem.db-shm', 'claude-mem.db-wal']);
      expect(readFileSync(p('claude-mem.db-wal'), 'utf-8')).toBe('restored-wal-frames');
      expect(readFileSync(p('claude-mem.db-shm'), 'utf-8')).toBe('restored-shm');
    });

    it('leaves an existing -wal alone when the db is not part of the swap batch', () => {
      writeFileSync(p('claude-mem.db'), 'live-db-content');
      writeFileSync(p('claude-mem.db-wal'), 'live-wal-frames');

      stagePendingSwap('settings.json', Buffer.from('{"only":"settings"}'));

      const swapped = applyPendingSwaps();

      expect(swapped).toEqual(['settings.json']);
      expect(readFileSync(p('claude-mem.db-wal'), 'utf-8')).toBe('live-wal-frames');
    });
  });

  describe('.env permissions', () => {
    // POSIX-only: Windows has no mode bits beyond the read-only flag, so
    // statSync().mode is meaningless there.
    const posixOnly = it.skipIf(process.platform === 'win32');

    it('stages and applies .env without error on every platform', () => {
      // Runs on Windows too: chmodSync there only toggles the read-only bit,
      // and this asserts the extra call cannot break the swap.
      stagePendingSwap('.env', Buffer.from('ANTHROPIC_API_KEY=secret\n'));
      const swapped = applyPendingSwaps();

      expect(swapped).toEqual(['.env']);
      expect(readFileSync(p('.env'), 'utf-8')).toBe('ANTHROPIC_API_KEY=secret\n');
    });

    posixOnly('stages .env as 0600 so the rename cannot downgrade the target', () => {
      stagePendingSwap('.env', Buffer.from('ANTHROPIC_API_KEY=secret\n'));

      expect(statSync(p('.env.importing')).mode & 0o777).toBe(0o600);
    });

    posixOnly('leaves the applied .env at 0600, matching EnvManager', () => {
      stagePendingSwap('.env', Buffer.from('ANTHROPIC_API_KEY=secret\n'));
      applyPendingSwaps();

      expect(readFileSync(p('.env'), 'utf-8')).toBe('ANTHROPIC_API_KEY=secret\n');
      expect(statSync(p('.env')).mode & 0o777).toBe(0o600);
    });

    posixOnly('re-chmods when restaging over an existing world-readable .env.importing', () => {
      // writeFileSync's `mode` option is ignored when the file already exists,
      // so a leftover 0644 staging file would otherwise survive the restage.
      writeFileSync(p('.env.importing'), 'OLD=1\n', { mode: 0o644 });

      stagePendingSwap('.env', Buffer.from('ANTHROPIC_API_KEY=secret\n'));

      expect(statSync(p('.env.importing')).mode & 0o777).toBe(0o600);
    });
  });
});
