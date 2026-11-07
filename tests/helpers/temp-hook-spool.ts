import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookSpool, type HookSpoolEntry, type HookSpoolKind } from '../../src/shared/hook-spool.js';
import { spyOn } from 'bun:test';
import * as liveObserver from '../../src/cli/live-observer-event.js';

let liveEntries: HookSpoolEntry[] = [];

/**
 * Points CLAUDE_MEM_DATA_DIR at a fresh temp dir so write-hook handlers spool
 * into it (resolveDataDir() is read at use time). Call from beforeEach and
 * call the returned restore() from afterEach.
 */
export function useTempHookSpoolDataDir(): { dataDir: string; restore: () => void } {
  const savedDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-spool-test-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  liveEntries = [];
  const liveCapture = spyOn(liveObserver, 'sendLiveObserverEvent').mockImplementation(entry => {
    liveEntries.push(entry);
    return 'live-test-receipt';
  });
  return {
    dataDir,
    restore: () => {
      liveCapture.mockRestore();
      liveEntries = [];
      if (savedDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = savedDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function spooledEntries(kind?: HookSpoolKind): HookSpoolEntry[] {
  // Compatibility name for handler assertions: inference is captured live;
  // only metadata events are read from the durable spool.
  const entries = [...new HookSpool().entries(), ...liveEntries].sort((a, b) => a.enqueuedAtEpochMs - b.enqueuedAtEpochMs);
  return kind ? entries.filter(entry => entry.kind === kind) : entries;
}
