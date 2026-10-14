import { describe, expect, it, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isOpencodeObserverPrompt } from '../../src/utils/tag-stripping.js';
import { OBSERVER_PROMPT_SENTINEL } from '../../src/shared/observer-sentinel.js';
import {
  collectRunOutput,
  classifyOpencodeRunError,
  isOpencodeSelected,
} from '../../src/services/worker/OpencodeProvider.js';
import {
  readArchivedSessionId,
  writeArchivedSessionId,
  isObserverContentSession,
  planObserverCleanup,
  parseSessionList,
  isOpencodeBinaryOnPath,
  exportMessagesClean,
} from '../../src/services/worker/opencode-observer.js';

const savedDataDir = process.env.CLAUDE_MEM_DATA_DIR;
let tempDataDir = '';

function useTempDataDir(): string {
  tempDataDir = join(tmpdir(), `opencode-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDataDir, 'opencode-observer'), { recursive: true });
  process.env.CLAUDE_MEM_DATA_DIR = tempDataDir;
  return tempDataDir;
}

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = savedDataDir;
  if (tempDataDir) {
    try { rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    tempDataDir = '';
  }
});

describe('opencode observer prompt sentinel', () => {
  it('matches a spawned prompt and leading whitespace', () => {
    expect(isOpencodeObserverPrompt(`${OBSERVER_PROMPT_SENTINEL}\nbody`)).toBe(true);
    expect(isOpencodeObserverPrompt(`  \n${OBSERVER_PROMPT_SENTINEL}\nbody`)).toBe(true);
  });

  it('matches the quote-wrapped form the opencode service stores', () => {
    expect(isOpencodeObserverPrompt(`"${OBSERVER_PROMPT_SENTINEL}\nbody"`)).toBe(true);
  });

  it('rejects ordinary prompts and empty text', () => {
    expect(isOpencodeObserverPrompt('Reply with exactly: HI')).toBe(false);
    expect(isOpencodeObserverPrompt('')).toBe(false);
    // Sentinel anywhere but the start is not a spawned turn.
    expect(isOpencodeObserverPrompt(`hello\n${OBSERVER_PROMPT_SENTINEL}`)).toBe(false);
  });
});

describe('collectRunOutput', () => {
  const SID = 'ses_ecf750736ffepksyNL0M36sTCt';
  it('joins text parts and reads step_finish usage', () => {
    const stdout = [
      `{"type":"step_start","timestamp":1,"sessionID":"${SID}","part":{"type":"step-start"}}`,
      '{"type":"text","timestamp":2,"sessionID":"SID","part":{"type":"text","text":"HI"}}',
      `{"type":"step_finish","timestamp":3,"sessionID":"${SID}","part":{"type":"step-finish","tokens":{"input":100,"output":12}}}`,
    ].join('\n');
    const out = collectRunOutput(stdout);
    expect(out.sessionId).toBe(SID);
    expect(out.text).toBe('HI');
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(12);
    expect(out.sawUnknownEventType).toBe(false);
    expect(out.error).toBeUndefined();
  });

  it('captures provider.auth errors with status', () => {
    const stdout = '{"type":"error","timestamp":1,"sessionID":"ses_x","error":{"type":"provider.auth","message":"OpenCode\'s free tier can only be used from within OpenCode","status":403}}';
    const out = collectRunOutput(stdout);
    expect(out.error?.status).toBe(403);
    expect(out.error?.message).toContain('free tier');
  });

  it('flags unknown event types (tool-use canary) and skips garbage lines', () => {
    const out = collectRunOutput('not json\n{"type":"tool_call","part":{}}');
    expect(out.sawUnknownEventType).toBe(true);
    expect(out.text).toBe('');
  });
});

describe('classifyOpencodeRunError', () => {
  it.each([
    [{ message: 'rate limit (429)', status: 429 }, 'rate_limit'],
    [{ message: 'TPM limit reached', status: undefined }, 'rate_limit'],
    [{ message: 'allowance spent', status: 402 }, 'quota_exhausted'],
    [{ message: "OpenCode's free tier can only be used from within OpenCode", status: 403 }, 'quota_exhausted'],
    [{ message: 'unauthorized', status: 401 }, 'auth_invalid'],
    [{ message: 'boom', status: 500 }, 'transient'],
    [{ message: 'Prompt is too long', status: undefined }, 'context_overflow'],
    [{ message: 'spawn opencode ENOENT', status: undefined }, 'setup_required'],
  ] as const)('classifies %p as %p', (input, kind) => {
    expect(classifyOpencodeRunError({ ...input, cause: new Error('x') }).kind).toBe(kind);
  });
});

describe('observer session archive', () => {
  it('round-trips a server-minted id and rejects junk', async () => {
    useTempDataDir();
    expect(await readArchivedSessionId()).toBeNull();
    await writeArchivedSessionId('ses_abc123XYZ');
    expect(await readArchivedSessionId()).toBe('ses_abc123XYZ');
    await writeArchivedSessionId('not-a-session');
    expect(await readArchivedSessionId()).toBeNull();
  });

  it('matches plugin contentSessionIds embedding the archived id', async () => {
    useTempDataDir();
    await writeArchivedSessionId('ses_abc123XYZ');
    expect(await isObserverContentSession('opencode-ses_abc123XYZ-1791815329260')).toBe(true);
    expect(await isObserverContentSession('opencode-ses_other-1791815329260')).toBe(false);
    expect(await isObserverContentSession('ses_abc123XYZ')).toBe(false);
  });
});

describe('planObserverCleanup', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  it('keeps the newest 5 and drops older-than-7-days within them', () => {
    const list = [
      { id: 'a', timeMs: NOW - 1 * DAY },
      { id: 'b', timeMs: NOW - 8 * DAY },
      { id: 'c', timeMs: NOW - 2 * DAY },
      { id: 'd', timeMs: NOW - 3 * DAY },
      { id: 'e', timeMs: NOW - 4 * DAY },
      { id: 'f', timeMs: NOW - 5 * DAY },
      { id: 'g' },
    ];
    const doomed = planObserverCleanup(list, NOW).map((e) => e.id).sort();
    // b: too old; f,g: past the newest 5.
    expect(doomed).toEqual(['b', 'f', 'g']);
  });
});

describe('exportMessagesClean', () => {
  const clean = (texts: string[]) =>
    JSON.stringify({ messages: texts.map((text, i) => ({ id: `m${i}`, text })) });
  it('accepts sentinel user turns and skips text-less assistant turns', () => {
    expect(exportMessagesClean(clean([`${OBSERVER_PROMPT_SENTINEL}\nbody`]))).toBe(true);
    expect(
      exportMessagesClean(
        JSON.stringify({ messages: [{ id: 'a' }, { id: 'u', text: `${OBSERVER_PROMPT_SENTINEL}\nx` }] }),
      ),
    ).toBe(true);
  });
  it('rejects foreign prompts and unparseable exports', () => {
    expect(exportMessagesClean(clean(['hello there']))).toBe(false);
    expect(exportMessagesClean(clean([`${OBSERVER_PROMPT_SENTINEL}\nok`, 'second human prompt']))).toBe(false);
    expect(exportMessagesClean('garbage')).toBe(false);
    expect(exportMessagesClean('{}')).toBe(false);
  });
  it('carves the document out of CLI wrapping noise', () => {
    const doc = clean([`${OBSERVER_PROMPT_SENTINEL}\nbody`]);
    expect(exportMessagesClean(`Update available 2.0.27 → 2.0.29\n${doc}\nRun opencode upgrade\n`)).toBe(true);
  });
});

describe('parseSessionList', () => {
  it('reads arrays and {sessions} envelopes, skips id-less rows', () => {
    expect(parseSessionList('[]')).toEqual([]);
    expect(parseSessionList('garbage')).toEqual([]);
    const entries = parseSessionList(JSON.stringify([
      { id: 'ses_a', title: 'claude-mem-observer', time: 1700000000000 },
      { sessionID: 'ses_b', title: 'user work' },
      { nope: true },
    ]));
    expect(entries.map((e) => e.id)).toEqual(['ses_a', 'ses_b']);
    expect(entries[0]?.timeMs).toBe(1700000000000);
  });
});

describe('isOpencodeBinaryOnPath', () => {
  it('finds a staged binary and misses an empty dir', () => {
    const dir = join(tmpdir(), `opencode-bin-test-${Date.now()}`);
    const empty = join(tmpdir(), `opencode-bin-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(empty, { recursive: true });
    try {
      writeFileSync(join(dir, 'opencode.cmd'), '@echo off');
      expect(isOpencodeBinaryOnPath(dir)).toBe(true);
      expect(isOpencodeBinaryOnPath(empty)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('findOpencodeBinary', () => {
  it('peers through a .cmd shim at its %~dp0 target', async () => {
    if (process.platform !== 'win32') return;
    const { findOpencodeBinary, resetOpencodeBinaryCacheForTesting } = await import(
      '../../src/services/worker/opencode-observer.js'
    );
    const dir = join(tmpdir(), `opencode-shim-test-${Date.now()}`);
    const realDir = join(dir, 'real');
    mkdirSync(realDir, { recursive: true });
    const target = join(realDir, 'opencode.exe');
    try {
      writeFileSync(join(dir, 'opencode.cmd'), '@SETLOCAL\r\n@"%~dp0\\real\\opencode.exe"  %*');
      writeFileSync(target, 'binary');
      resetOpencodeBinaryCacheForTesting();
      expect(await findOpencodeBinary(dir)).toBe(target);
    } finally {
      resetOpencodeBinaryCacheForTesting();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isOpencodeSelected', () => {
  it('reads the provider flag from an explicit settings file', () => {
    const dir = join(tmpdir(), `opencode-selected-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'opencode' }));
      expect(isOpencodeSelected(path)).toBe(true);
      writeFileSync(path, JSON.stringify({ CLAUDE_MEM_PROVIDER: 'claude' }));
      expect(isOpencodeSelected(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
