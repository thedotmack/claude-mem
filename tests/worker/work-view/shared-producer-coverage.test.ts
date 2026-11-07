import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SharedLedgerAdapter } from '../../../src/services/work-view/shared-ledger-adapter.mjs';
import { registerSharedFileWriter } from '../../../src/services/work-view/shared-file-hooks.mjs';
import { AGENT_WRITTEN_PROMPTS_FILE, groupIdFor, readLedger, runCli, writeJsonAtomic } from '../../../src/services/work-view/request-groups.mjs';
import { decideSuggestion, routeUndecided } from '../../../src/services/work-view/request-judge.mjs';
import { AutoRefreshWorker } from '../../../src/services/work-view/auto-refresh-worker.mjs';
import { HostedIntent, type HostedIntentResult } from '../../../src/services/work-view/hosted-intent.js';
import { readSharedRecords } from '../../../src/services/work-view/shared-record-store.mjs';
import { sharedRecordKey } from '../../../src/services/work-view/shared-records.mjs';
import { isSharedProjectionValue } from '../../../src/services/work-view/shared-projection.mjs';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });
const NOW = Date.parse('2026-11-01T12:00:00Z');
const key = (id: string, platform = 'claude') => JSON.stringify(['conversation', platform, id]);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'shared-producers-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  const store = new SessionStore(path); store.setLocalSyncDeviceId('device-a');
  cleanup.push(() => store.close());
  const directory = join(dir, 'work-view'); mkdirSync(directory);
  const adapter = new SharedLedgerAdapter(store.db, { directory, deviceId: 'device-a' });
  const writes: string[] = [];
  cleanup.push(registerSharedFileWriter(directory, (name: string, value: unknown) => {
    const finish = adapter.beforeWrite(name, value);
    if (finish) {
      const pending = store.db.query('SELECT pending_json FROM my_work_file_state WHERE name = ?').get(name) as any;
      expect(pending?.pending_json).toBeTruthy(); // durable before the producer's rename
      writes.push(name);
    }
    return finish;
  }));
  const shared = () => readSharedRecords(store.db, { deviceId: 'device-a', validateValue: isSharedProjectionValue });
  const value = (kind: string, id: string) => shared().records.get(sharedRecordKey(kind, id))?.value as any;
  const session = (id: string, text: string) => {
    const row = store.createSDKSession(id, 'org/repo', text, undefined, 'claude');
    store.updateMemorySessionId(row, `memory-${id}`);
    store.saveUserPrompt(id, 1, text, row);
    store.db.query('UPDATE sdk_sessions SET started_at_epoch = ? WHERE id = ?').run(NOW - 1000, row);
    store.db.query('UPDATE user_prompts SET created_at_epoch = ? WHERE session_db_id = ?').run(NOW - 1000, row);
    return row;
  };
  return { dir, path, directory, store, adapter, shared, value, session, writes };
}

test('real local, Python, judge, refresh and exclusion producers persist accepted shared facts', async () => {
  const f = fixture();
  // First-run save_rules intentionally creates a preference-only story. This
  // exercises the Python fallback/import path, rather than duplicating its JSON.
  const python = spawnSync('python3', ['-c', `import importlib.util, sys
spec = importlib.util.spec_from_file_location('goals', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.save_rules(sys.argv[2], [module.rule_preference({'then': 'Keep every quote.', 'when': 'When recording rules', 'evidence': [{'at': '2026-11-01 11:00', 'quote': 'Keep every quote.'}]})])`, resolve(import.meta.dir, '../../../plugin/skills/owner-goals/scripts/save_goals.py'), f.directory], { encoding: 'utf8' });
  expect(python.status).toBe(0);
  f.adapter.reconcile({ captureActivity: false });
  expect(f.value('story', 'current')).toMatchObject({ preferences: [{ preference: 'Keep every quote.', source: 'owner-goals' }] });
  expect(f.value('story', 'current').narrative).toBeUndefined();

  f.session('a', 'Build the release cards');
  f.session('b', 'Fix the card spacing');
  f.session('c', 'Write the pricing page');
  let result: any;
  const command = (args: string[]) => runCli(args, { dir: f.directory, database: f.store.db, now: NOW, localDeviceId: 'device-a', print: (value: unknown) => { result = value; } });
  const input = (name: string, value: unknown) => { const path = join(f.dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
  command(['apply', input('groups.json', { groups: [{ title: 'Release cards', conversations: [key('a')] }] })]);
  const groupId = groupIdFor(key('a'));
  expect(f.value('group', groupId).group.anchorAsk.text).toBe('Build the release cards');
  command(['show', groupId]);
  command(['record-progress', input('progress.json', { groupId, state: 'in-progress', percent: 60, summary: 'Cards are taking shape.', reviewBasis: result.reviewBasis,
    milestones: [{ text: 'Card grid built.', at: null, evidence: ['obs 1'] }],
    preferences: [{ kind: 'directive', preference: 'Keep spacing consistent.', quote: 'same spacing', at: null }],
    outcome: { usage: { level: 'some-use', text: 'The owner opened the grid.', evidence: ['obs 2'] }, changes: [{ what: 'Unified spacing', why: 'The owner asked', evidence: ['obs 3'] }] } })]);
  expect(f.value('progress', groupId)).toMatchObject({ percent: 60, readings: [{ percent: 60 }], milestones: [{ text: 'Card grid built.' }] });
  command(['record-story', input('story.json', { narrative: 'The card grid is built and spacing is being unified.', preferences: [] })]);
  expect(f.value('story', 'current')).toMatchObject({ narrative: 'The card grid is built and spacing is being unified.', preferences: [{ source: 'owner-goals' }] });

  await routeUndecided({ dir: f.directory, database: f.store.db, now: NOW, apply: true, judge: { name: 'fixture', judge: async () => ({ requestId: groupId, confidence: 0.6, evidence: 'Related card work.' }) } });
  expect(f.value('group', groupId).suggestions[key('b')].status).toBe('open');
  decideSuggestion({ dir: f.directory, database: f.store.db, conversationKey: key('b'), action: 'join', now: NOW });
  decideSuggestion({ dir: f.directory, database: f.store.db, conversationKey: key('c'), action: 'not-this', now: NOW });
  expect(f.value('group', groupId).members).toContain(key('b'));
  expect(f.value('group', groupId).suggestions[key('c')].status).toBe('declined');

  const refresh = new AutoRefreshWorker({ dir: f.directory, localDeviceId: () => 'device-a', now: () => NOW,
    openDatabase: () => ({ prepare: f.store.db.prepare.bind(f.store.db), close() {} }),
    runJob: async () => ({ state: 'ok', agent: 'fixture-agent', result: 'Reviewed the cards.', error: null }) });
  cleanup.push(() => refresh.close());
  expect(await refresh.runNow({ reason: 'manual' })).toBe('ok');
  expect(f.value('refresh', 'device-a')).toMatchObject({ state: 'ok', result: 'Reviewed the cards.', originDeviceId: 'device-a' });
  expect(f.value('refresh', 'device-a')).not.toHaveProperty('pid');

  const prompt = f.store.db.query('SELECT id FROM user_prompts ORDER BY id LIMIT 1').get() as { id: number };
  // Exact callback payload used by worker-service's setup scan.
  writeJsonAtomic(join(f.directory, AGENT_WRITTEN_PROMPTS_FILE), { promptIds: [prompt.id], updatedAt: new Date(NOW).toISOString() });
  expect([...f.shared().records.values()].find(record => record.kind === 'exclusion')?.value).toMatchObject({ ref: { device: 'device-a', row: String(prompt.id) }, opening: true });
  expect(f.shared().diagnostics.invalid).toBe(0);
  expect(f.writes).toEqual(expect.arrayContaining(['request-groups.json', `progress/${groupId}.json`, 'story.json', 'refresh.json', AGENT_WRITTEN_PROMPTS_FILE]));
});

test('real hosted extraction preserves its grouping product, full ignore reason and story through the registered adapter', async () => {
  const f = fixture();
  const quote = { at: '2026-11-01 12:00', quote: 'Build the cards and keep every quote.' };
  const reason = 'This is a runtime setup instruction. '.repeat(12);
  const answer: HostedIntentResult = {
    goals: { map: '# Owner map', goals: { generated_at: new Date(NOW).toISOString(), window_days: 30, source_prompt_count: 3,
      human_summary: 'Build a consistent card viewer. '.repeat(450), priorities: [{ rank: 1, title: 'Release cards', product: 'org/repo', latest_at: quote.at, times_asked: 2, evidence: [quote, quote] }], open_asks: [] } },
    rules: [{ preference: 'Keep every quote.', kind: 'directive', supportCount: 2, quotes: [quote] }],
    groups: { groups: [{ title: 'Release cards', product: 'org/repo', conversations: ['hosted-a', 'hosted-b'], links: [{ kind: 'agent-judgment', conversations: ['hosted-a', 'hosted-b'], evidence: 'Both are card work.' }] }], ignored: [{ conversation: 'hosted-c', reason }] },
    cost_usd: 0, model: 'fixture', dropped_quotes: 0,
  };
  const hosted = new HostedIntent({ ledgerDir: f.directory, localDeviceId: () => 'device-a', homeProject: () => 'org/repo',
    origin: () => 'https://cloud.example/', credentials: () => ({ token: 'fixture', userId: 'fixture' }),
    openDatabase: () => new Database(f.path, { readonly: true }), appendWorkStateEntry: entry => { f.store.appendWorkStateEntry(entry); },
    now: () => NOW, timezoneOffsetMinutes: () => 0, fetch: (async (_url, init) => Response.json(init?.method === 'GET' ? { available: true } : answer)) as typeof fetch });
  await hosted.run(['hosted-a', 'hosted-b', 'hosted-c'].map(sessionId => ({ agent: 'codex', platformSource: 'codex', sessionId, nativePromptId: `${sessionId}-1`, at: NOW, cwd: '/private/work', project: 'org/repo', text: 'Build the cards and keep every quote.' })), false);
  expect(hosted.state().state).toBe('ok');
  expect(f.value('group', groupIdFor(key('hosted-a', 'codex'))).group).toMatchObject({ title: 'Release cards', product: 'org/repo' });
  expect(f.value('ignored', key('hosted-c', 'codex'))).toBe(reason);
  expect(f.value('story', 'current')).toMatchObject({ narrative: answer.goals.goals.human_summary, source: 'hosted-intent', preferences: [{ preference: 'Keep every quote.' }] });
  expect(f.shared().diagnostics.invalid).toBe(0);
  expect(readLedger(f.directory).story.narrative).toBe(answer.goals.goals.human_summary);
  expect(JSON.parse(readFileSync(join(f.directory, 'hosted-intent.json'), 'utf8')).model).toBe('fixture');
});
