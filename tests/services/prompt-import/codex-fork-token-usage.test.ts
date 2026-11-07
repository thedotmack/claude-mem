import { afterEach, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import * as readers from '../../../src/services/prompt-import/readers.js';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const DAY = 86_400_000;
const NOW = Date.now();
const SINCE = NOW - 30 * DAY;
const PARENT = '00000000-0000-4000-8000-000000000001';
const CHILD = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

const iso = (at: number) => new Date(at).toISOString();
const tokens = (total: number) => ({ input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total });
const meta = (id: string, at: number, forkedFrom?: string, version = '0.160.0') => ({ timestamp: iso(at), type: 'session_meta', payload: {
  id, session_id: forkedFrom ? PARENT : id, timestamp: iso(at), cwd: '/work/app', source: 'cli', cli_version: version,
  ...(forkedFrom ? { forked_from_id: forkedFrom } : {}),
} });
const settings = (thread: string, at = NOW) => ({ timestamp: iso(at), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: thread } });
const count = (total: number, last: number, at = NOW) => ({ timestamp: iso(at), type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: tokens(total), last_token_usage: tokens(last), model_context_window: 10000 }, rate_limits: null,
} });

function write(name: string, records: unknown[]): string {
  home ??= mkdtempSync(join(tmpdir(), 'cm-codex-fork-usage-'));
  const file = join(home, '.codex/sessions/2026/11/02', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function copiedPrefix(creatorVersion = '0.160.0') {
  // The native copied-fork writer reserializes inherited items at fork time.
  return [meta(CHILD, NOW, PARENT, creatorVersion), { ...meta(PARENT, NOW - 40 * DAY), timestamp: iso(NOW) }, settings(PARENT), count(100, 100), count(300, 200)];
}

async function scan() {
  return (await scanTokenUsage({ homeDirectory: home!, sinceEpochMs: SINCE, agents: ['codex'] })).agents[0];
}

it('does not charge inherited parent counters again at fork time', async () => {
  const parent = write('a-parent.jsonl', [meta(PARENT, SINCE - DAY), count(100, 100, SINCE - DAY), count(300, 200, SINCE - DAY)]);
  utimesSync(parent, (SINCE - DAY) / 1000, (SINCE - DAY) / 1000);
  for (const version of ['0.154.0', '0.160.0']) {
    write('z-child.jsonl', [...copiedPrefix(version), settings(CHILD), count(350, 50, NOW + 10)]);
    expect(await scan()).toMatchObject({ tokens: 50, firstRecordAt: iso(NOW + 10), skippedSources: 0 });
  }
});

it('keeps child usage before later settings changes and preserves other files', async () => {
  write('a-parent.jsonl', [meta(PARENT, NOW), count(100, 100), count(300, 200)]);
  write('b-other.jsonl', [meta(OTHER, NOW), count(100, 100), count(300, 200)]);
  write('z-child.jsonl', [...copiedPrefix(), settings(CHILD), count(350, 50), settings(CHILD), count(410, 60)]);
  expect(await scan()).toMatchObject({ tokens: 710, skippedSources: 0 });
});

it('credits independent threads with identical timestamps and counters separately', async () => {
  for (const [name, id] of [['a.jsonl', PARENT], ['b.jsonl', OTHER]]) {
    write(name, [meta(id, NOW), count(100, 100), count(300, 200)]);
  }
  expect(await scan()).toMatchObject({ tokens: 600, skippedSources: 0 });
});

it('preserves the cumulative interpretation of legacy unmarked files', async () => {
  write('legacy.jsonl', [count(300, 200), count(300, 200), count(350, 50)]);
  expect(await scan()).toMatchObject({ tokens: 250, skippedSources: 0 });
});

it('does not discard a legacy creator fork without an own-thread startup boundary', async () => {
  write('unmarked.jsonl', [...copiedPrefix('0.100.0'), count(350, 50)]);
  // Without a child-owned marker, retain the legacy interpretation rather than discarding ambiguous history.
  expect(await scan()).toMatchObject({ tokens: 350, skippedSources: 0 });
});

it('retains already read child usage when a later transcript read fails', async () => {
  write('a-parent.jsonl', [meta(PARENT, NOW), count(100, 100), count(300, 200)]);
  const child = write('z-partial.jsonl', [...copiedPrefix(), settings(CHILD), count(350, 50)]);
  const original = readers.readLines;
  const read = spyOn(readers, 'readLines').mockImplementation(async function* (file) {
    if (file !== child) {
      yield* original(file);
      return;
    }
    for (const line of readFileSync(file, 'utf8').trimEnd().split('\n')) yield line;
    throw new Error('injected failure after committed child usage');
  });
  try {
    expect(await scan()).toMatchObject({ tokens: 350, skippedSources: 1 });
  } finally {
    read.mockRestore();
  }
});

it('preserves earlier legacy child usage when an upgrade appends its first owned settings snapshot', async () => {
  write('upgraded-child.jsonl', [
    meta(CHILD, NOW, PARENT, '0.100.0'),
    { ...meta(PARENT, NOW - 40 * DAY, undefined, '0.160.0'), timestamp: iso(NOW) },
    count(100, 100), count(300, 200),
    count(350, 50), // A real child turn before the new ownership-marker protocol.
    settings(CHILD), // Added by resume/upgrade, not by creation of this fork.
    count(410, 60),
  ]);
  // Keep the previous interpretation of ambiguous historical counters rather than deleting real child usage.
  expect(await scan()).toMatchObject({ tokens: 410, skippedSources: 0 });
});

it('leaves absent, invalid and prerelease creator versions on the legacy interpretation', async () => {
  for (const version of [undefined, 'invalid', '0.154.0-alpha.1', '0.160.0-rc.1']) {
    const [header, ...prefix] = copiedPrefix();
    write('unsupported.jsonl', [
      { ...header, payload: { ...(header as ReturnType<typeof meta>).payload, cli_version: version } },
      ...prefix, settings(CHILD), count(350, 50),
    ]);
    expect(await scan()).toMatchObject({ tokens: 350, skippedSources: 0 });
  }
});

it('does not credit inherited usage when a verified creator file fails before its startup boundary', async () => {
  const prefix = copiedPrefix();
  const child = write('partial-before-startup.jsonl', [...prefix, settings(CHILD), count(350, 50)]);
  const original = readers.readLines;
  const read = spyOn(readers, 'readLines').mockImplementation(async function* (file) {
    if (file !== child) { yield* original(file); return; }
    for (const line of readFileSync(file, 'utf8').split('\n').slice(0, prefix.length)) yield line;
    throw new Error('injected failure before child startup boundary');
  });
  try {
    expect(await scan()).toMatchObject({ tokens: 0, firstRecordAt: null, skippedSources: 1 });
  } finally {
    read.mockRestore();
  }
});

it('does not let a copied header replace a first session header with an unusable ID', async () => {
  for (const id of [undefined, '', 17]) {
    write('malformed-first.jsonl', [
      { timestamp: iso(NOW), type: 'session_meta', payload: { id, cli_version: '0.160.0', forked_from_id: PARENT } },
      meta(PARENT, NOW, OTHER), count(300, 200), settings(PARENT), count(350, 50),
    ]);
    expect(await scan()).toMatchObject({ tokens: 250, skippedSources: 0 });
  }
});
