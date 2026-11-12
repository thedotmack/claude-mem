import { afterEach, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import { createCodexReader, readLines } from '../../../src/services/prompt-import/readers.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { normalizeStoredPromptText } from '../../../src/services/sqlite/prompt-storage.js';
import { scanZstdFramesInFile } from '../../../src/services/transcripts/zstd-frames.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const DAY = 86400_000;
const SINCE = NOW - 30 * DAY;
const COLD_MTIME = NOW - 10 * DAY;
const homes: string[] = [];
const zstdCompressSync = (zlib as unknown as { zstdCompressSync(data: Buffer, options?: { params: Record<number, number> }): Buffer }).zstdCompressSync;

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-compressed-import-'));
  homes.push(home);
  const directory = join(home, '.codex', 'sessions', '2026', '11', '01');
  mkdirSync(directory, { recursive: true });
  const options = { homeDirectory: home, agents: ['codex' as const], sinceEpochMs: SINCE,
    excludedProjects: '', resolveProject: () => 'fixture-project' };
  return { home, directory, options };
}

const iso = (at: number) => new Date(at).toISOString();
const meta = (id?: string) => ({ timestamp: iso(NOW - 35 * DAY), type: 'session_meta',
  payload: { id, source: 'cli', originator: 'codex_cli_rs', cwd: '/work/fixture' } });
const prompt = (id: string, text: string, at = NOW - 11 * DAY) => ({
  timestamp: iso(at), type: 'response_item',
  payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] },
});
const usage = (at: number, total: number, last: number) => ({
  timestamp: iso(at), type: 'event_msg',
  payload: { type: 'token_count', info: {
    total_token_usage: { total_tokens: total }, last_token_usage: { total_tokens: last },
  } },
});

function writeRollout(directory: string, name: string, records: unknown[], compressed = true) {
  const raw = Buffer.from(records.map(record => JSON.stringify(record)).join('\n'));
  const path = join(directory, name + (compressed ? '.jsonl.zst' : '.jsonl'));
  writeFileSync(path, compressed ? zstdCompressSync(raw) : raw);
  // Native Codex keeps the original mtime when compressing cold rollouts.
  utimesSync(path, new Date(COLD_MTIME), new Date(COLD_MTIME));
  return path;
}

// Codex e58bf8f5233b51e7cd1679d947e3028c1ed91b06 compresses cold rollouts
// after seven days, retaining a single Zstandard frame and the source mtime.
it('imports cold compressed Codex prompts into SQLite without changing the source', async () => {
  const { home, directory, options } = fixture();
  const text = 'please preserve this original UTF-8 request: ' + '漢字🙂\n'.repeat(5000) + 'finish';
  const path = writeRollout(directory, 'rollout-cold', [meta('cold-session'), prompt('request-1', text)]);
  const bytes = readFileSync(path);
  const mtime = statSync(path).mtimeMs;
  const located = createCodexReader().locate(home);
  expect(located.sources.map(source => source.path)).toEqual([path]);
  expect((await scanOwnerPrompts(options)).ownerPrompts.map(prompt => prompt.text)).toEqual([text]);

  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const scanner = new SetupScan({ getStore: () => store, now: () => NOW, scanOptions: options });
    scanner.start();
    const state = await scanner.finished();
    expect(state.error).toBeNull();
    expect(state.skippedSources).toBe(0);
    expect(state.added).toBe(1);
    const rows = store.db.query('SELECT prompt_text FROM user_prompts ORDER BY id').all();
    expect(rows).toEqual([{ prompt_text: normalizeStoredPromptText(text) }]);
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mtimeMs).toBe(mtime);
  } finally {
    store.close();
  }
});

it('uses compressed assistant evidence when classifying later plain prompts and hook rows', async () => {
  const { directory, options } = fixture();
  const authored = 'Implement the history scan so that it reads every original transcript and retains the author of each request. Verify the actual database rows before using those requests to infer what the owner wants to accomplish next.';
  const owner = 'please inspect the latest import results';
  writeRollout(directory, 'rollout-answer', [meta('answer-session'), {
    timestamp: iso(NOW - 12 * DAY), type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: authored }] },
  }]);
  writeRollout(directory, 'rollout-requests', [meta('request-session'),
    prompt('copied', authored), prompt('owner', owner)], false);
  const result = await scanOwnerPrompts({ ...options, memoryPrompts: [
    { id: 91, platformSource: 'codex', contentSessionId: 'hook-session',
      promptText: authored, createdAtEpoch: NOW - 11 * DAY },
    { id: 92, platformSource: 'codex', contentSessionId: 'hook-session',
      promptText: owner, createdAtEpoch: NOW - 11 * DAY },
  ] });
  expect(result.skippedSources).toEqual([]);
  expect(result.ownerPrompts.map(entry => entry.text)).toEqual([owner]);
  expect(result.agentWritten.map(entry => entry.text)).toEqual([authored]);
  expect([...result.ownerMemoryPromptIds]).toEqual([92]);
});

for (const compressed of [true, false]) {
  it('counts only in-window Codex usage increases from ' + (compressed ? 'compressed' : 'plain') + ' history', async () => {
    const { directory, options } = fixture();
    writeRollout(directory, 'rollout-usage', [
      meta('usage-session'), usage(NOW - 35 * DAY, 100, 100),
      usage(NOW - 12 * DAY, 130, 30), usage(NOW - 11 * DAY, 160, 30),
      usage(NOW - 11 * DAY, 160, 30),
    ], compressed);
    const result = await scanTokenUsage(options);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      id: 'codex', detected: true, tokens: 60, skippedSources: 0,
      historyStartsBeforeWindow: true, firstRecordAt: iso(NOW - 35 * DAY),
    });
  });
}

it('prefers the plain sibling during a compression transition without importing stale text or double-counting usage', async () => {
  const { home, directory, options } = fixture();
  writeRollout(directory, 'rollout-transition', [
    meta('transition-session'), prompt('old', 'please keep the stale request'), usage(NOW - 11 * DAY, 9000, 9000),
  ]);
  const plain = writeRollout(directory, 'rollout-transition', [
    meta('transition-session'), prompt('new', 'please keep the current request'), usage(NOW - 11 * DAY, 30, 30),
  ], false);
  expect(createCodexReader().locate(home).sources.map(source => source.path)).toEqual([plain]);
  const result = await scanOwnerPrompts(options);
  expect(result.ownerPrompts.map(entry => entry.text)).toEqual(['please keep the current request']);
  expect((await scanTokenUsage(options)).agents[0].tokens).toBe(30);
});

it('keeps fallback session and prompt identities after a rollout is compressed', async () => {
  const { directory, options } = fixture();
  const records = [meta(), prompt('stable-request', 'please keep this same request after compression')];
  const plain = writeRollout(directory, 'rollout-legacy', records, false);
  const before = await scanOwnerPrompts(options);
  expect(before.ownerPrompts).toHaveLength(1);
  writeRollout(directory, 'rollout-legacy', records);
  unlinkSync(plain);
  const after = await scanOwnerPrompts(options);
  expect(after.ownerPrompts).toEqual(before.ownerPrompts);
  expect(after.ownerPrompts[0].sessionId).toBe('rollout-legacy');
});

for (const damaged of ['corrupt', 'truncated', 'empty'] as const) {
  it('reports ' + damaged + ' compressed sources instead of presenting an unread scan as complete', async () => {
    const { directory, options } = fixture();
    const path = writeRollout(directory, 'rollout-damaged', [
      meta('damaged-session'), prompt('request', 'please retain readable history'), usage(NOW - 11 * DAY, 10, 10),
    ]);
    const bytes = readFileSync(path);
    writeFileSync(path, damaged === 'corrupt' ? Buffer.from('not a Zstandard frame') : damaged === 'empty' ? Buffer.alloc(0) : bytes.subarray(0, bytes.length - 1));
    const result = await scanOwnerPrompts(options);
    expect(result.skippedSources.map(source => source.path)).toEqual([path]);
    expect((await scanTokenUsage(options)).agents[0].skippedSources).toBe(1);
  });
}

it('reports a decoder error after a complete frame passes the structural scan', async () => {
  const { directory, options } = fixture();
  const raw = Buffer.from([meta('checksum-session'),
    prompt('request', 'please inspect the retained native history'),
    usage(NOW - 11 * DAY, 10, 10),
  ].map(record => JSON.stringify(record)).join('\n'));
  const checksumFlag = (zlib.constants as unknown as { ZSTD_c_checksumFlag: number }).ZSTD_c_checksumFlag;
  const bytes = zstdCompressSync(raw, { params: { [checksumFlag]: 1 } });
  expect(bytes[4] & 4).toBe(4);
  // A bad payload checksum preserves every frame/header/block boundary. Only
  // the actual streaming decoder can reject this complete but damaged frame.
  bytes[bytes.length - 1] ^= 1;
  const path = join(directory, 'rollout-checksum.jsonl.zst');
  writeFileSync(path, bytes);
  expect(scanZstdFramesInFile(path, 0, bytes.length)).toEqual({
    frames: [{ start: 0, end: bytes.length }], tornStart: null,
  });
  const collect = async () => {
    for await (const _line of readLines(path)) { /* consume the real decoder */ }
  };
  await expect(collect()).rejects.toThrow();
  const result = await scanOwnerPrompts(options);
  expect(result.skippedSources.map(source => source.path)).toEqual([path]);
  expect((await scanTokenUsage(options)).agents[0].skippedSources).toBe(1);
});

it('propagates a compressed input file read error to the caller', async () => {
  const { directory } = fixture();
  const missing = join(directory, 'missing.jsonl.zst');
  const collect = async () => {
    const lines: string[] = [];
    for await (const line of readLines(missing)) lines.push(line);
    return lines;
  };
  await expect(collect()).rejects.toThrow('ENOENT');
});

it.skipIf(!existsSync('/proc/self/fd'))('closes the compressed input when a line reader stops before EOF', async () => {
  const { directory } = fixture();
  const header = meta('early-stop');
  const path = writeRollout(directory, 'rollout-long', [
    header, { padding: randomBytes(4 * 1024 * 1024).toString('base64') },
  ]);
  expect(statSync(path).size).toBeGreaterThan(1 << 20);
  const descriptors = () => readdirSync('/proc/self/fd').filter(fd => {
    try { return readlinkSync('/proc/self/fd/' + fd) === path; } catch { return false; }
  });
  const lines = readLines(path);
  try {
    expect(await lines.next()).toEqual({ done: false, value: JSON.stringify(header) });
    expect(descriptors().length).toBeGreaterThan(0);
  } finally {
    await lines.return(undefined);
  }
  // destroy closes asynchronously; give the actual file descriptor its close turn.
  for (let attempt = 0; attempt < 100 && descriptors().length; attempt++) await Bun.sleep(10);
  expect(descriptors()).toEqual([]);
});

// Codex compresses archived_sessions/ as well as sessions/ (compression.rs
// walks both), so an archived cold rollout is a .jsonl.zst in the flat folder.
it('imports compressed archived Codex rollouts and prefers their plain sibling', async () => {
  const { home, options } = fixture();
  const archived = join(home, '.codex', 'archived_sessions');
  mkdirSync(archived, { recursive: true });
  const cold = writeRollout(archived, 'rollout-archived-cold', [meta('archived-cold'), prompt('archived', 'please keep the archived request')]);
  writeRollout(archived, 'rollout-archived-transition', [meta('archived-transition'), prompt('stale', 'please drop the stale archived request')]);
  const plain = writeRollout(archived, 'rollout-archived-transition', [meta('archived-transition'), prompt('current', 'please keep the current archived request')], false);
  expect(createCodexReader().locate(home).sources.map(source => source.path).sort()).toEqual([cold, plain].sort());
  const result = await scanOwnerPrompts(options);
  expect(result.skippedSources).toEqual([]);
  expect(result.ownerPrompts.map(entry => entry.text).sort())
    .toEqual(['please keep the archived request', 'please keep the current archived request']);
});
