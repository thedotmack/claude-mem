import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import {
  HookSpool,
  HOOK_SPOOL_RETRY_WINDOW_MS,
  migrateLegacySessionEndReplay,
  resolveHookSpoolDirectory,
  resolveLegacySessionEndReplayDirectory,
} from '../../src/shared/hook-spool.js';
import { logger } from '../../src/utils/logger.js';

let dataDir: string;
let savedDataDir: string | undefined;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

function spoolFiles(spool: HookSpool): string[] {
  return readdirSync(spool.directory).filter(name => name.endsWith('.json'));
}

beforeEach(() => {
  savedDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-spool-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  if (savedDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('HookSpool', () => {
  it('resolves its directory from CLAUDE_MEM_DATA_DIR at use time', () => {
    const spool = new HookSpool();
    expect(spool.directory).toBe(join(dataDir, 'state', 'hook-spool'));
    expect(resolveHookSpoolDirectory()).toBe(spool.directory);
    spool.enqueue('session_end', { contentSessionId: 'session-1', platformSource: 'claude' });
    expect(spoolFiles(spool)).toHaveLength(1);
  });

  it('drains in enqueue order, across kinds', async () => {
    const spool = new HookSpool();
    spool.enqueue('session_end', { contentSessionId: 'session-b', platformSource: 'claude' }, 3000);
    spool.enqueue('session_end', { contentSessionId: 'session-a', platformSource: 'claude' }, 1000);
    spool.enqueue('subagent_stop', { contentSessionId: 'session-c', platformSource: 'claude', agentId: 'agent-1' }, 5000);
    spool.enqueue('session_end', { contentSessionId: 'session-d', platformSource: 'claude' }, 6000);

    const seen: string[] = [];
    const result = await spool.drain(entry => {
      seen.push(`${entry.kind}:${entry.payload.contentSessionId}`);
      return true;
    });

    expect(seen).toEqual(['session_end:session-a', 'session_end:session-b', 'subagent_stop:session-c', 'session_end:session-d']);
    expect(result).toEqual({ drained: 4, retained: 0, quarantined: 0, expired: 0 });
    expect(spoolFiles(spool)).toEqual([]);
  });

  it('keeps same-millisecond enqueues from one process in call order', () => {
    const spool = new HookSpool();
    for (const contentSessionId of ['session-z', 'session-y', 'session-x']) {
      spool.enqueue('session_end', { contentSessionId, platformSource: 'claude' });
    }
    expect(spool.entries().map(entry => entry.payload.contentSessionId))
      .toEqual(['session-z', 'session-y', 'session-x']);
  });

  it('dedupes a re-enqueued event by overwriting its file and keeping its original position', () => {
    const spool = new HookSpool();
    const first = { contentSessionId: 'session-first', platformSource: 'claude' };
    const path = spool.enqueue('session_end', first, 10_000);
    spool.enqueue('session_end', { ...first, contentSessionId: 'session-later' }, 20_000);
    expect(spool.enqueue('session_end', first, 30_000)).toBe(path);

    expect(spoolFiles(spool)).toHaveLength(2);
    expect(spool.entries().map(entry => [entry.payload.contentSessionId, entry.enqueuedAtEpochMs]))
      .toEqual([['session-first', 10_000], ['session-later', 20_000]]);
  });

  it('dedupes events by a hash of kind + session + canonical payload', () => {
    const spool = new HookSpool();
    const stopped = { contentSessionId: 's', platformSource: 'Claude Code', agentId: 'agent-1' };
    spool.enqueue('subagent_stop', stopped);
    // Same content, different key order and platform spelling → same file.
    spool.enqueue('subagent_stop', { agentId: 'agent-1', platformSource: 'claude', contentSessionId: 's' });
    expect(spoolFiles(spool)).toHaveLength(1);
    expect(spoolFiles(spool)[0]).toMatch(/^subagent_stop-[a-f0-9]{64}\.json$/);

    spool.enqueue('subagent_stop', { ...stopped, agentId: 'agent-2' });
    expect(spoolFiles(spool)).toHaveLength(2);

    // Different session, same agent → distinct entries.
    spool.enqueue('subagent_stop', { ...stopped, contentSessionId: 'other' });
    expect(spoolFiles(spool)).toHaveLength(3);
  });

  it('keeps an entry the accept callback declines or throws on, and removes accepted ones', async () => {
    const spool = new HookSpool();
    const recentEpochMs = Date.now() - 60_000;
    spool.enqueue('session_end', { contentSessionId: 'unknown', platformSource: 'claude' }, recentEpochMs + 1);
    spool.enqueue('session_end', { contentSessionId: 'throws', platformSource: 'claude' }, recentEpochMs + 2);
    spool.enqueue('session_end', { contentSessionId: 'known', platformSource: 'claude' }, recentEpochMs + 3);

    const result = await spool.drain(entry => {
      if (entry.payload.contentSessionId === 'throws') throw new Error('db busy');
      return entry.payload.contentSessionId === 'known';
    });

    expect(result).toEqual({ drained: 1, retained: 2, quarantined: 0, expired: 0 });
    expect(spool.entries().map(entry => entry.payload.contentSessionId)).toEqual(['unknown', 'throws']);
  });

  it('moves a declined or failing entry past the retry window to expired/ with an error log, never deleting it', async () => {
    const spool = new HookSpool();
    const pastWindowEpochMs = Date.now() - HOOK_SPOOL_RETRY_WINDOW_MS - 60_000;
    const declinedPath = spool.enqueue('session_end', { contentSessionId: 'never-known', platformSource: 'claude' }, pastWindowEpochMs);
    const failingPath = spool.enqueue('subagent_stop', { contentSessionId: 'always-throws', platformSource: 'claude', agentId: 'agent-1' }, pastWindowEpochMs + 1);
    // Inside the window: still retried.
    spool.enqueue('session_end', { contentSessionId: 'recent-unknown', platformSource: 'claude' }, Date.now() - 60_000);

    const result = await spool.drain(entry => {
      if (entry.payload.contentSessionId === 'always-throws') throw new Error('db busy');
      return false;
    });

    expect(result).toEqual({ drained: 0, retained: 1, quarantined: 0, expired: 2 });
    expect(spool.entries().map(entry => entry.payload.contentSessionId)).toEqual(['recent-unknown']);
    expect(readdirSync(spool.expiredDirectory).sort()).toEqual([basename(declinedPath), basename(failingPath)].sort());

    const expiryLogs = loggerSpies[3].mock.calls.filter(call => String(call[1]).includes('retry window'));
    expect(expiryLogs).toHaveLength(2);
    expect(expiryLogs[0][2]).toMatchObject({ kind: 'session_end', contentSessionId: 'never-known' });
    expect(expiryLogs[0][2].ageHours).toBeGreaterThanOrEqual(7 * 24);
    expect(expiryLogs[1][2]).toMatchObject({ kind: 'subagent_stop', contentSessionId: 'always-throws' });
  });

  it('quarantines a corrupt file into corrupt/ with an error log instead of deleting it', async () => {
    const spool = new HookSpool();
    spool.enqueue('session_end', { contentSessionId: 'session-ok', platformSource: 'claude' });
    writeFileSync(join(spool.directory, 'observation-garbage.json'), '{not json');
    writeFileSync(join(spool.directory, 'mystery-kind.json'), JSON.stringify({ kind: 'mystery', payload: { contentSessionId: 's' }, enqueuedAtEpochMs: 1 }));
    // An interrupted atomic write's temp file is not an entry and is left alone.
    writeFileSync(join(spool.directory, '.observation-x.json.123.abc.tmp'), 'partial');

    const accepted: string[] = [];
    const result = await spool.drain(entry => {
      accepted.push(entry.kind);
      return true;
    });

    expect(accepted).toEqual(['session_end']);
    expect(result).toEqual({ drained: 1, retained: 0, quarantined: 2, expired: 0 });
    expect(readdirSync(spool.corruptDirectory).sort()).toEqual(['mystery-kind.json', 'observation-garbage.json']);
    expect(existsSync(join(spool.directory, '.observation-x.json.123.abc.tmp'))).toBe(true);
    const errorSpy = loggerSpies[3];
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0][1]).toBe('Quarantined corrupt hook spool entry');
  });

  it('skips a past-window entry a concurrent drain already moved, without an error log', async () => {
    const spool = new HookSpool();
    const entryPath = spool.enqueue('session_end', { contentSessionId: 'never-known', platformSource: 'claude' }, Date.now() - HOOK_SPOOL_RETRY_WINDOW_MS - 60_000);

    const result = await spool.drain(() => {
      // Another worker process moves the file between the read and the expiry.
      unlinkSync(entryPath);
      return false;
    });

    expect(result).toEqual({ drained: 0, retained: 0, quarantined: 0, expired: 1 });
    expect(loggerSpies[3]).not.toHaveBeenCalled();
  });

  it('skips a corrupt file a concurrent drain already quarantined, without an error log', async () => {
    const spool = new HookSpool();
    mkdirSync(spool.directory, { recursive: true });
    writeFileSync(join(spool.directory, 'mystery-kind.json'), JSON.stringify({ kind: 'mystery', payload: { contentSessionId: 's' }, enqueuedAtEpochMs: 1 }));
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });

    try {
      const result = await spool.drain(() => true);
      expect(result).toEqual({ drained: 0, retained: 0, quarantined: 0, expired: 0 });
    } finally {
      renameSpy.mockRestore();
    }
    expect(loggerSpies[3]).not.toHaveBeenCalled();
  });
});

describe('migrateLegacySessionEndReplay', () => {
  it('moves retired SessionEnd replay files into the spool and removes the legacy directory', async () => {
    const legacyDirectory = resolveLegacySessionEndReplayDirectory();
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(join(legacyDirectory, `${'a'.repeat(64)}.json`), JSON.stringify({
      contentSessionId: 'legacy-session',
      platformSource: 'Cursor',
      requestedAtEpoch: 1234,
    }));
    writeFileSync(join(legacyDirectory, `${'b'.repeat(64)}.json`), 'garbage');

    const spool = new HookSpool();
    expect(migrateLegacySessionEndReplay(spool)).toBe(1);

    expect(existsSync(legacyDirectory)).toBe(false);
    expect(spool.entries()).toEqual([{
      kind: 'session_end',
      payload: { contentSessionId: 'legacy-session', platformSource: 'cursor' },
      enqueuedAtEpochMs: 1234,
    }]);
    expect(readdirSync(spool.corruptDirectory)).toEqual([`legacy-session-end-${'b'.repeat(64)}.json`]);
  });

  it('is a no-op when there is no legacy directory', () => {
    expect(migrateLegacySessionEndReplay(new HookSpool())).toBe(0);
  });
});
