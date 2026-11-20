import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';
import { scanOwnerPrompts } from '../../../src/services/prompt-import/index.js';
import * as readers from '../../../src/services/prompt-import/readers.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const OLD = NOW - 40 * 86400000;
const PARENT = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const stamp = (at: number) => new Date(at).toISOString();
const meta = (id: string, at: number, forked?: string, version = '0.160.0') => ({ timestamp: stamp(at), type: 'session_meta',
  payload: { id, timestamp: stamp(at), source: 'cli', originator: 'codex_cli_rs', cwd: '/projects/example',
    cli_version: version, ...(forked ? { forked_from_id: forked } : {}) } });
const prompt = (id: string, text: string, at: number) => ({ timestamp: stamp(at), type: 'response_item',
  payload: { type: 'message', role: 'user', id, content: [{ type: 'input_text', text }] } });
const settings = (id: string, at = NOW) => ({ timestamp: stamp(at), type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_id: id } });
let home: string;
let store: SessionStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cmem-codex-fork-prompts-'));
  store = new SessionStore(':memory:', { syncOpsEnabled: false });
});
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
function write(name: string, records: unknown[], modified = NOW) {
  const file = join(home, '.codex', 'sessions', '2026', '11', '02', name + '.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  utimesSync(file, modified / 1000, modified / 1000);
  return file;
}
async function scan() {
  const scanner = new SetupScan({ getStore: () => store, now: () => NOW,
    scanOptions: { homeDirectory: home, agents: ['codex'], excludedProjects: '', resolveProject: () => 'example' },
    readTokenUsage: async () => ({ windowStart: stamp(NOW - 30 * 86400000), windowDays: 30, agents: [] }) });
  scanner.start();
  return scanner.finished();
}
function rows() {
  return store.db.prepare(`SELECT s.content_session_id AS session, up.prompt_text AS text
    FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id ORDER BY s.content_session_id, up.id`).all();
}

for (const version of ['0.154.0', '0.160.0']) {
  it(`does not import copied historical parent prompts as newly typed child prompts (${version})`, async () => {
    write('parent', [meta(PARENT, OLD), prompt('parent-native', 'fix the old parent task', OLD)], OLD);
    write('child', [meta(CHILD, NOW, PARENT, version), { ...meta(PARENT, OLD), timestamp: stamp(NOW) }, settings(PARENT),
      prompt('parent-native', 'fix the old parent task', NOW), settings(CHILD),
      prompt('child-native', 'fix the new child task', NOW + 1)]);
    for (const pass of [0, 1]) {
      const result = await scan();
      expect({ added: result.added, rows: rows() }).toEqual({ added: pass === 0 ? 1 : 0,
        rows: [{ session: CHILD, text: 'fix the new child task' }] });
    }
  });
}

it('preserves a legacy fork own prompt written before its first post-upgrade settings marker', async () => {
  write('legacy', [meta(CHILD, OLD, PARENT, '0.100.0'), meta(PARENT, NOW),
    prompt('legacy-child-native', 'fix the child task before upgrade', NOW - 1000), settings(CHILD),
    prompt('upgraded-child-native', 'fix the child task after upgrade', NOW + 1)]);
  expect((await scan()).added).toBe(2);
  expect(rows()).toEqual([{ session: CHILD, text: 'fix the child task before upgrade' },
    { session: CHILD, text: 'fix the child task after upgrade' }]);
});

it('keeps copied assistant text as provenance evidence for a later pasted user prompt', async () => {
  const text = 'Please improve the repository with a careful implementation and a reproducible verification. '.repeat(4);
  const assistant = (at: number) => ({ timestamp: stamp(at), type: 'response_item', payload: {
    type: 'message', role: 'assistant', id: 'old-assistant-native', content: [{ type: 'output_text', text }] } });
  write('old-parent', [meta(PARENT, OLD), assistant(OLD)], OLD);
  write('fork', [meta(CHILD, NOW, PARENT), { ...meta(PARENT, OLD), timestamp: stamp(NOW) }, assistant(NOW), settings(CHILD),
    prompt('pasted-child-native', text, NOW + 1000)]);
  const result = await scanOwnerPrompts({ homeDirectory: home, agents: ['codex'], sinceEpochMs: NOW - 30 * 86400000,
    excludedProjects: '', resolveProject: () => 'example' });
  expect(result.ownerPrompts).toEqual([]);
  expect(result.agentWritten.map(entry => entry.text)).toEqual([text.trim()]);
});

it('keeps independent native user turns even when their text and timestamps match', async () => {
  const text = 'fix this independent task';
  write('first', [meta(PARENT, NOW), prompt('same-native', text, NOW)]);
  write('second', [meta(CHILD, NOW), prompt('same-native', text, NOW)]);
  expect((await scan()).added).toBe(2);
  expect(rows()).toEqual([{ session: PARENT, text }, { session: CHILD, text }]);
});

for (const afterBoundary of [false, true]) {
  it(`preserves only actual child prompts on a partial read (${afterBoundary ? 'after' : 'before'} startup)`, async () => {
    const file = write('partial', []);
    const records = [meta(CHILD, NOW, PARENT), meta(PARENT, NOW),
      prompt('inherited-native', 'fix the inherited task', NOW),
      ...(afterBoundary ? [settings(CHILD), prompt('own-native', 'fix the own task', NOW + 1)] : [])];
    const readLines = readers.readLines;
    const spy = spyOn(readers, 'readLines').mockImplementation(async function* (path) {
      if (path !== file) { yield* readLines(path); return; }
      for (const record of records) yield JSON.stringify(record);
      throw new Error('injected read failure after a verified native record prefix');
    });
    try {
      const result = await scan();
      expect(result.skippedSources).toBe(1);
      expect(rows()).toEqual(afterBoundary ? [{ session: CHILD, text: 'fix the own task' }] : []);
    } finally { spy.mockRestore(); }
  });
}

it('keeps the existing prompt interpretation for unknown and prerelease creator versions', async () => {
  for (const version of [undefined, 'invalid', '0.154.0-alpha.1']) {
    const first: any = meta(CHILD, NOW, PARENT);
    if (version === undefined) delete first.payload.cli_version;
    else first.payload.cli_version = version;
    write('unknown', [first, prompt('before-native', 'fix the earlier task', NOW), settings(CHILD),
      prompt('after-native', 'fix the later task', NOW + 1)]);
    const result = await scanOwnerPrompts({ homeDirectory: home, agents: ['codex'], sinceEpochMs: 0,
      excludedProjects: '', resolveProject: () => 'example' });
    expect(result.ownerPrompts.map(entry => entry.text)).toEqual(['fix the earlier task', 'fix the later task']);
  }
});

it('does not let a copied header replace the canonical first header with a missing ID', async () => {
  const first: any = meta(CHILD, NOW, PARENT);
  delete first.payload.id;
  write('malformed', [first, meta(PARENT, NOW, CHILD), prompt('before-native', 'fix the earlier task', NOW),
    settings(PARENT), prompt('after-native', 'fix the later task', NOW + 1)]);
  const result = await scanOwnerPrompts({ homeDirectory: home, agents: ['codex'], sinceEpochMs: 0,
    excludedProjects: '', resolveProject: () => 'example' });
  expect(result.ownerPrompts.map(entry => [entry.sessionId, entry.text])).toEqual([
    ['malformed', 'fix the earlier task'], ['malformed', 'fix the later task']]);
});
