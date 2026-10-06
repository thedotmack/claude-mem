import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
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

function observation(toolUseId: string | undefined, toolName = 'Bash') {
  return {
    contentSessionId: 'session-1',
    platformSource: 'claude',
    toolName,
    toolInput: { command: 'ls' },
    toolResponse: { stdout: 'a' },
    cwd: '/repo',
    toolUseId,
  };
}

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
    spool.enqueue('observation', observation('toolu_1'));
    expect(spoolFiles(spool)).toHaveLength(1);
    expect(spoolFiles(spool)[0]).toMatch(/^observation-[a-f0-9]{64}-toolu_1\.json$/);
  });

  it('retains identical host tool ids from different sessions and platforms', async () => {
    const spool = new HookSpool();
    const first = observation('call_1');
    spool.enqueue('observation', first);
    spool.enqueue('observation', { ...first, contentSessionId: 'session-2' });
    spool.enqueue('observation', { ...first, platformSource: 'codex' });
    // A repeat within the original scope replaces that event only.
    spool.enqueue('observation', { ...first, platformSource: 'Claude Code', toolResponse: 'updated' });
    expect(spoolFiles(spool)).toHaveLength(3);
    const received: string[] = [];
    await spool.drain(entry => {
      received.push(`${entry.payload.contentSessionId}:${entry.payload.platformSource}`);
      return true;
    });
    expect(received.sort()).toEqual(['session-1:claude', 'session-1:codex', 'session-2:claude']);
  });

  it('drains in enqueue order, across kinds', async () => {
    const spool = new HookSpool();
    spool.enqueue('observation', observation('toolu_b'), 3000);
    spool.enqueue('observation', observation('toolu_a'), 1000);
    spool.enqueue('summarize', { contentSessionId: 'session-1', platformSource: 'claude', lastAssistantMessage: 'done' }, 5000);
    spool.enqueue('session_end', { contentSessionId: 'session-1', platformSource: 'claude' }, 6000);

    const seen: string[] = [];
    const result = await spool.drain(entry => {
      seen.push(entry.kind === 'observation' ? `observation:${entry.payload.toolUseId}` : entry.kind);
      return true;
    });

    expect(seen).toEqual(['observation:toolu_a', 'observation:toolu_b', 'summarize', 'session_end']);
    expect(result).toEqual({ drained: 4, retained: 0, quarantined: 0, expired: 0 });
    expect(spoolFiles(spool)).toEqual([]);
  });

  it('keeps same-millisecond enqueues from one process in call order', () => {
    const spool = new HookSpool();
    spool.enqueue('observation', observation('toolu_z'));
    spool.enqueue('observation', observation('toolu_y'));
    spool.enqueue('observation', observation('toolu_x'));
    expect(spool.entries().map(entry => (entry.payload as { toolUseId?: string }).toolUseId))
      .toEqual(['toolu_z', 'toolu_y', 'toolu_x']);
  });

  it('dedupes a re-enqueued event by overwriting its file and keeping its original position', () => {
    const spool = new HookSpool();
    spool.enqueue('observation', observation('toolu_dup'), 10_000);
    spool.enqueue('observation', observation('toolu_later'), 20_000);
    spool.enqueue('observation', observation('toolu_dup'), 30_000);

    expect(spoolFiles(spool)).toHaveLength(2);
    expect(spoolFiles(spool).filter(name => name.endsWith('-toolu_dup.json'))).toHaveLength(1);
    expect(spoolFiles(spool).filter(name => name.endsWith('-toolu_later.json'))).toHaveLength(1);
    expect(spool.entries().map(entry => (entry.payload as { toolUseId?: string }).toolUseId))
      .toEqual(['toolu_dup', 'toolu_later']);
  });

  it('dedupes events without a tool_use_id by a hash of kind + session + canonical payload', () => {
    const spool = new HookSpool();
    const summarize = { contentSessionId: 's', platformSource: 'Claude Code', lastAssistantMessage: 'hi', observedModel: 'm' };
    spool.enqueue('summarize', summarize);
    // Same content, different key order and platform spelling → same file.
    spool.enqueue('summarize', { observedModel: 'm', lastAssistantMessage: 'hi', platformSource: 'claude', contentSessionId: 's' });
    expect(spoolFiles(spool)).toHaveLength(1);
    expect(spoolFiles(spool)[0]).toMatch(/^summarize-[a-f0-9]{64}\.json$/);

    spool.enqueue('summarize', { ...summarize, lastAssistantMessage: 'different turn' });
    expect(spoolFiles(spool)).toHaveLength(2);

    // Different session, same text → distinct entries.
    spool.enqueue('summarize', { ...summarize, contentSessionId: 'other' });
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
    const failingPath = spool.enqueue('summarize', { contentSessionId: 'always-throws', platformSource: 'claude', lastAssistantMessage: 'x' }, pastWindowEpochMs + 1);
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
    expect(expiryLogs[1][2]).toMatchObject({ kind: 'summarize', contentSessionId: 'always-throws' });
  });

  it('quarantines a corrupt file into corrupt/ with an error log instead of deleting it', async () => {
    const spool = new HookSpool();
    spool.enqueue('observation', observation('toolu_ok'));
    writeFileSync(join(spool.directory, 'observation-garbage.json'), '{not json');
    writeFileSync(join(spool.directory, 'mystery-kind.json'), JSON.stringify({ kind: 'mystery', payload: { contentSessionId: 's' }, enqueuedAtEpochMs: 1 }));
    // An interrupted atomic write's temp file is not an entry and is left alone.
    writeFileSync(join(spool.directory, '.observation-x.json.123.abc.tmp'), 'partial');

    const accepted: string[] = [];
    const result = await spool.drain(entry => {
      accepted.push(entry.kind);
      return true;
    });

    expect(accepted).toEqual(['observation']);
    expect(result).toEqual({ drained: 1, retained: 0, quarantined: 2, expired: 0 });
    expect(readdirSync(spool.corruptDirectory).sort()).toEqual(['mystery-kind.json', 'observation-garbage.json']);
    expect(existsSync(join(spool.directory, '.observation-x.json.123.abc.tmp'))).toBe(true);
    const errorSpy = loggerSpies[3];
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0][1]).toBe('Quarantined corrupt hook spool entry');
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
