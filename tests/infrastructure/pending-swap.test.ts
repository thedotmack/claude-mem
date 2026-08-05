import { describe, it, expect, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claude-mem-pending-swap-test-'));
const PREVIOUS_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

const { stagePendingSwap, applyPendingSwaps } = await import('../../src/services/infrastructure/PendingSwap.js');
const { paths } = await import('../../src/shared/paths.js');

const DATA_DIR = paths.dataDir();

describe('PendingSwap', () => {
  afterAll(() => {
    if (PREVIOUS_DATA_DIR === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = PREVIOUS_DATA_DIR;
    }
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('stages a file under <name>.importing without touching the real target', () => {
    mkdirSync(DATA_DIR, { recursive: true });
    stagePendingSwap('settings.json', Buffer.from('{"staged":true}'));

    expect(existsSync(path.join(DATA_DIR, 'settings.json.importing'))).toBe(true);
    expect(existsSync(path.join(DATA_DIR, 'settings.json'))).toBe(false);
  });

  it('applyPendingSwaps renames staged files over their targets and returns the swapped basenames', () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path.join(DATA_DIR, 'claude-mem.db'), 'old-db-content');
    stagePendingSwap('claude-mem.db', Buffer.from('new-db-content'));
    stagePendingSwap('settings.json', Buffer.from('{"new":true}'));

    const swapped = applyPendingSwaps();

    expect(swapped.sort()).toEqual(['claude-mem.db', 'settings.json']);
    expect(readFileSync(path.join(DATA_DIR, 'claude-mem.db'), 'utf-8')).toBe('new-db-content');
    expect(readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf-8')).toBe('{"new":true}');
    expect(existsSync(path.join(DATA_DIR, 'claude-mem.db.importing'))).toBe(false);
    expect(existsSync(path.join(DATA_DIR, 'settings.json.importing'))).toBe(false);
  });

  it('applyPendingSwaps returns an empty array when nothing is staged', () => {
    mkdirSync(DATA_DIR, { recursive: true });
    expect(applyPendingSwaps()).toEqual([]);
  });
});
