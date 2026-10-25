import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostedIntent, INTENT_MAX_UPLOAD_BYTES, type HostedIntentResult } from '../../src/services/work-view/hosted-intent.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { readGoals, readLedger } from '../../src/services/work-view/request-groups.mjs';
import { WorkStateSource } from '../../src/services/work-view/data-source.mjs';
import type { OwnerPrompt } from '../../src/services/prompt-import/index.js';

const at = Date.parse('2026-10-23T15:05:00Z');
const prompts: OwnerPrompt[] = ['one', 'two', 'three'].map(sessionId => ({
  agent: 'codex', platformSource: 'codex', sessionId, nativePromptId: `${sessionId}-1`, at,
  cwd: '/work', project: 'test', text: `Build ${sessionId} and keep every quote.`,
}));
function answer(): HostedIntentResult {
  const evidence = [{ at: '2026-10-23 08:05', quote: 'Build one and keep every quote.' }, { at: '2026-10-23 08:05', quote: 'Build two and keep every quote.' }];
  return {
    goals: { map: '# Owner map\nAll the original text.', goals: {
      generated_at: '2026-10-23T15:06:00Z', window_days: 30, source_prompt_count: 3,
      human_summary: 'Build everything with full evidence.',
      priorities: [{ rank: 1, title: 'Build everything', product: 'test', latest_at: '2026-10-23 08:05', times_asked: 3, evidence }], open_asks: [],
    } },
    rules: [{ preference: 'Keep every quote.', kind: 'directive', supportCount: 3, quotes: structuredClone(evidence) }],
    groups: { groups: [{ title: 'Build all three', product: 'test', conversations: ['one', 'two', 'three'],
      // The Cloud contract permits an incomplete link graph; the worker must retain it.
      links: [{ kind: 'agent-judgment', conversations: ['one', 'two'], evidence: 'Build' }] }], ignored: [] },
    cost_usd: 0.02, model: 'deepseek/flash:floor', dropped_quotes: 0,
  };
}
const cleanup: Array<() => void> = [];
const installCredentials = { install_id: 'a'.repeat(32), intent_token: 'b'.repeat(64) };
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });
function fixture(response: typeof fetch = (async () => Response.json(answer())) as typeof fetch, credentials = { token: 'setup-token', userId: 'owner' }) {
  const scratch = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'hosted-intent-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'memory.db');
  const store = new SessionStore(databasePath);
  cleanup.push(() => store.close());
  const configPath = join(dir, 'intent-install.json');
  const createRun = () => new HostedIntent({
    origin: () => 'https://cloud.example/', credentials: () => credentials, intentConfigPath: configPath, ledgerDir: join(dir, 'work-view'),
    openDatabase: () => new Database(databasePath, { readonly: true }),
    appendWorkStateEntry: entry => { store.appendWorkStateEntry(entry); }, homeProject: () => 'home',
    fetch: response, now: () => at, timezoneOffsetMinutes: () => 420,
  });
  return { run: createRun(), createRun, configPath, dir, store, databasePath };
}

describe('hosted setup extraction', () => {
  it('uploads the complete importer output as gzip with setup auth and saves goals, groups and rules to the existing snapshot', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const { run, dir, databasePath } = fixture((async (url, init) => {
      request = { url: String(url), init: init! };
      return Response.json(answer());
    }) as typeof fetch);
    await run.run(prompts, true);
    expect(request?.url).toBe('https://cloud.example/api/pro/intent');
    expect(request?.init.headers).toEqual({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: 'Bearer setup-token', 'X-User-Id': 'owner' });
    expect(JSON.parse(gunzipSync(request!.init.body as Uint8Array).toString())).toEqual({ ownerPrompts: prompts, improveProduct: true, timezoneOffsetMinutes: 420 });
    expect(run.state()).toMatchObject({ state: 'ok', error: null });
    const db = new Database(databasePath, { readonly: true });
    expect(readGoals(db).goals[0].evidence).toEqual(answer().goals.goals.priorities[0].evidence);
    db.close();
    const ledgerDir = join(dir, 'work-view');
    const ledger = readLedger(ledgerDir);
    expect(Object.keys(ledger.groups.conversations)).toContain('["conversation","codex","three"]');
    expect(ledger.story.preferences[0].quotes[0].at).toBe('2026-10-23T15:05:00.000Z');
    expect(JSON.parse(readFileSync(join(ledgerDir, 'hosted-intent.json'), 'utf8'))).toEqual(answer());
    const source = new WorkStateSource({ databasePath, ledgerDir });
    cleanup.push(() => source.close());
    const view = source.read().agentView;
    expect(view.goals.priorities[0].title).toBe('Build everything');
    expect(view.rules[0].then).toBe('Keep every quote.');
  });

  it('unchecked still uploads and saves the full result', async () => {
    let flag: boolean | undefined;
    const { run } = fixture((async (_url, init) => {
      flag = JSON.parse(gunzipSync(init!.body as Uint8Array).toString()).improveProduct;
      return Response.json(answer());
    }) as typeof fetch);
    await run.run(prompts, false);
    expect(flag).toBe(false);
    expect(run.state().state).toBe('ok');
  });

  it('retains long ignored reasons, summaries and original quotes without the local CLI truncation', async () => {
    const result = answer();
    result.goals.goals.human_summary = 'Full summary. '.repeat(200);
    result.goals.goals.priorities[0].title = 'Complete title '.repeat(25);
    result.goals.goals.priorities[0].product = 'Complete product '.repeat(8);
    result.goals.goals.priorities[0].evidence[0].quote = 'First line\nSecond line';
    result.groups.groups[0].conversations = ['one', 'two'];
    result.groups.ignored.push({ conversation: 'three', reason: 'Complete reason. '.repeat(20) });
    result.rules[0].quotes[0].quote = 'Long original quotation. '.repeat(12);
    const { run, dir, databasePath } = fixture((async () => Response.json(result)) as typeof fetch);
    await run.run(prompts, true);
    const ledger = readLedger(join(dir, 'work-view'));
    expect(ledger.story.narrative).toBe(result.goals.goals.human_summary);
    expect(ledger.story.preferences[0].quotes[0].quote).toBe(result.rules[0].quotes[0].quote);
    expect(Object.values(ledger.groups.ignored)).toEqual([result.groups.ignored[0].reason]);
    const source = new WorkStateSource({ databasePath, ledgerDir: join(dir, 'work-view') });
    cleanup.push(() => source.close());
    const view = source.read().agentView;
    expect(view.goals.summary).toBe(result.goals.goals.human_summary);
    expect(view.goals.priorities[0].title).toBe(result.goals.goals.priorities[0].title);
    expect(view.goals.priorities[0].product).toBe(result.goals.goals.priorities[0].product);
    expect(view.goals.priorities[0].evidence).toEqual(result.goals.goals.priorities[0].evidence);
    expect(view.rules[0].quotes[0].quote).toBe(result.rules[0].quotes[0].quote);
    const database = new Database(databasePath, { readonly: true });
    expect(readGoals(database).goals[0].evidence).toEqual(result.goals.goals.priorities[0].evidence);
    database.close();
  });

  it.each([413, 429, 502])('exposes the Cloud reason for HTTP %s without retrying', async status => {
    let calls = 0;
    const { run } = fixture((async () => { calls++; return Response.json({ error: 'intent_failed', message: 'rules failed validation after two attempts' }, { status }); }) as typeof fetch);
    await expect(run.run(prompts, true)).rejects.toThrow(`HTTP ${status}): rules failed validation after two attempts`);
    expect(calls).toBe(1);
    expect(run.state()).toMatchObject({ state: 'failed', error: expect.stringContaining('rules failed validation') });
  });

  it('exposes a network failure and rejects malformed success responses', async () => {
    const network = fixture((async () => { throw new Error('Network unavailable'); }) as typeof fetch);
    await expect(network.run.run(prompts, true)).rejects.toThrow('Network unavailable');
    const malformed = fixture((async () => Response.json({ goals: {} })) as typeof fetch);
    await expect(malformed.run.run(prompts, true)).rejects.toThrow('invalid response');
  });

  it('fails loudly on the uncompressed cap even when the gzip would fit, with no paid request', async () => {
    let calls = 0;
    const { run } = fixture((async () => { calls++; return Response.json(answer()); }) as typeof fetch);
    await expect(run.run([{ ...prompts[0], text: 'a'.repeat(INTENT_MAX_UPLOAD_BYTES) }], true)).rejects.toThrow('2 MiB upload cap');
    expect(calls).toBe(0);
  });

  it.each([{ token: 'setup-token', userId: 'owner' }, { token: '', userId: '' }])('completes empty history without credentials or a Cloud call (%j)', async credentials => {
    let calls = 0;
    const { run, configPath, dir } = fixture((async () => { calls++; throw new Error('Empty history must not contact Cloud'); }) as typeof fetch, credentials);
    await run.run([], true);
    expect(run.state()).toMatchObject({ state: 'ok', step: null, error: null, finishedAt: new Date(at).toISOString() });
    expect(calls).toBe(0);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(dir, 'work-view'))).toBe(false);
  });

  it('preserves the previous extraction when a later scan has no owner prompts', async () => {
    let calls = 0;
    const { run, dir, databasePath } = fixture((async () => { calls++; return Response.json(answer()); }) as typeof fetch);
    await run.run(prompts, true);
    const before = readLedger(join(dir, 'work-view'));
    await run.run([], false);
    expect(calls).toBe(1);
    expect(readLedger(join(dir, 'work-view'))).toEqual(before);
    const database = new Database(databasePath, { readonly: true });
    expect(readGoals(database).goals[0].title).toBe(answer().goals.goals.priorities[0].title);
    database.close();
    expect(run.state()).toMatchObject({ state: 'ok', error: null });
  });

  it('refuses incomplete account credentials and ambiguous cross-agent ids before upload', async () => {
    let calls = 0;
    const fetch = (async () => { calls++; return Response.json(answer()); }) as typeof globalThis.fetch;
    await expect(fixture(fetch, { token: 'explicit-token', userId: '' }).run.run(prompts, true)).rejects.toThrow('incomplete CMEM account credentials');
    await expect(fixture(fetch, { token: '', userId: 'explicit-user' }).run.run(prompts, true)).rejects.toThrow('incomplete CMEM account credentials');
    await expect(fixture(fetch).run.run([prompts[0], { ...prompts[0], platformSource: 'claude' }], true)).rejects.toThrow('shared by multiple agents');
    expect(calls).toBe(0);
  });

  it('issues and persists an anonymous credential before upload, then reuses it on retry and after sign-in', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const account = { token: '', userId: '' };
    const test = fixture((async (url, init) => {
      requests.push({ url: String(url), init: init! });
      if (String(url).endsWith('/api/installer/intent')) {
        expect(init!.method).toBe('POST');
        expect(init!.body).toBeUndefined();
        expect(init!.headers).toBeUndefined();
        return Response.json(installCredentials);
      }
      expect(JSON.parse(readFileSync(test.configPath, 'utf8'))).toEqual(installCredentials);
      if (requests.length === 2) return Response.json({ error: 'intent_failed', message: 'Hosted extraction could not complete.' }, { status: 502 });
      return requests.length === 3
        ? Response.json({ error: 'install_run_used', message: 'This installation has already used its hosted run.' }, { status: 429 })
        : Response.json(answer());
    }) as typeof fetch, account);
    await expect(test.run.run(prompts, false)).rejects.toThrow('Hosted extraction could not complete.');
    expect(statSync(test.configPath).mode & 0o777).toBe(0o600);
    const restarted = test.createRun();
    await expect(restarted.run(prompts, true)).rejects.toThrow('This installation has already used its hosted run.');
    expect(restarted.state().error).toContain('This installation has already used its hosted run.');
    account.token = 'signed-in-token';
    account.userId = 'signed-in-user';
    await test.createRun().run(prompts, true);
    expect(requests.map(request => request.url)).toEqual([
      'https://cloud.example/api/installer/intent', 'https://cloud.example/api/pro/intent',
      'https://cloud.example/api/pro/intent', 'https://cloud.example/api/pro/intent',
    ]);
    for (const { init } of requests.slice(1)) {
      expect(init.headers).toMatchObject({ 'X-Intent-Install-Id': installCredentials.install_id, 'X-Intent-Token': installCredentials.intent_token });
    }
    expect(requests[1].init.headers).not.toHaveProperty('Authorization');
    expect(requests[1].init.headers).not.toHaveProperty('X-User-Id');
    expect(requests[3].init.headers).toMatchObject({ Authorization: 'Bearer signed-in-token', 'X-User-Id': 'signed-in-user' });
    expect(JSON.parse(gunzipSync(requests[1].init.body as Uint8Array).toString())).toEqual({ ownerPrompts: prompts, improveProduct: false, timezoneOffsetMinutes: 420 });
  });

  it('saves a Cloud group spanning two project roots as one group per root, each with its own links', async () => {
    const split = prompts.map((prompt, index) => ({ ...prompt, project: index === 2 ? 'beta' : 'alpha/worktree' }));
    const { run, dir } = fixture();
    await run.run(split, true);
    const { groups } = readLedger(join(dir, 'work-view')).groups;
    const saved = Object.values(groups) as Array<{ anchor: string; projectRoot: string | null; links: unknown[]; title: string }>;
    expect(saved.map(group => [group.anchor, group.projectRoot, group.links.length, group.title])).toEqual([
      ['["conversation","codex","one"]', 'alpha', 1, 'Build all three'],
      ['["conversation","codex","three"]', 'beta', 0, 'Build all three'],
    ]);
  });

  it('leaves conversations Cloud did not place undecided instead of failing the save', async () => {
    const partial = answer();
    partial.groups.groups[0].conversations = ['one', 'two'];
    const { run, dir } = fixture((async () => Response.json(partial)) as typeof fetch);
    await run.run(prompts, true);
    expect(run.state()).toMatchObject({ state: 'ok', error: null });
    const { conversations, ignored } = readLedger(join(dir, 'work-view')).groups;
    expect(Object.keys(conversations).sort()).toEqual(['["conversation","codex","one"]', '["conversation","codex","two"]']);
    expect(ignored).toEqual({});
  });

  it('reuses the saved result when setup resumes after a successful run, with no second upload', async () => {
    let uploads = 0;
    const test = fixture((async () => { uploads++; return Response.json(answer()); }) as typeof fetch);
    await test.run.run(prompts, true);
    const before = readLedger(join(test.dir, 'work-view'));
    const resumed = test.createRun();
    await resumed.run(prompts, true);
    expect(uploads).toBe(1);
    expect(resumed.state()).toMatchObject({ state: 'ok', error: null });
    expect(readLedger(join(test.dir, 'work-view'))).toEqual(before);
  });

  it('replays a save that was cut off on the next attempt, with no second upload', async () => {
    let uploads = 0;
    const test = fixture((async () => { uploads++; return Response.json(answer()); }) as typeof fetch);
    const append = test.store.appendWorkStateEntry.bind(test.store);
    test.store.appendWorkStateEntry = () => { throw new Error('Worker stopped mid-save'); };
    await expect(test.run.run(prompts, true)).rejects.toThrow('Worker stopped mid-save');
    const ledgerDir = join(test.dir, 'work-view');
    expect(existsSync(join(ledgerDir, 'hosted-intent.json'))).toBe(false);
    expect(existsSync(join(ledgerDir, 'hosted-intent-pending.json'))).toBe(true);
    test.store.appendWorkStateEntry = append;
    const resumed = test.createRun();
    await resumed.run(prompts, true);
    expect(uploads).toBe(1);
    expect(resumed.state()).toMatchObject({ state: 'ok', error: null });
    expect(existsSync(join(ledgerDir, 'hosted-intent.json'))).toBe(true);
    expect(existsSync(join(ledgerDir, 'hosted-intent-pending.json'))).toBe(false);
    const database = new Database(test.databasePath, { readonly: true });
    expect(readGoals(database).goals[0].title).toBe('Build everything');
    database.close();
    expect(Object.keys(readLedger(ledgerDir).groups.conversations)).toHaveLength(3);
  });

  it('fails loudly when the saved result is unreadable instead of uploading again', async () => {
    let uploads = 0;
    const test = fixture((async () => { uploads++; return Response.json(answer()); }) as typeof fetch);
    mkdirSync(join(test.dir, 'work-view'), { recursive: true });
    writeFileSync(join(test.dir, 'work-view', 'hosted-intent.json'), JSON.stringify({ goals: null }));
    await expect(test.run.run(prompts, true)).rejects.toThrow('saved hosted setup result');
    expect(uploads).toBe(0);
  });

  it('keeps the anonymous credential after a lost upload response', async () => {
    let issues = 0;
    let uploads = 0;
    const test = fixture((async url => {
      if (String(url).endsWith('/api/installer/intent')) { issues++; return Response.json(installCredentials); }
      uploads++;
      throw new Error('Upload connection lost');
    }) as typeof fetch, { token: '', userId: '' });
    await expect(test.run.run(prompts, true)).rejects.toThrow('Upload connection lost');
    await expect(test.createRun().run(prompts, true)).rejects.toThrow('Upload connection lost');
    expect(issues).toBe(1);
    expect(uploads).toBe(2);
  });

  it('surfaces issuance errors before any upload', async () => {
    const requests: string[] = [];
    const test = fixture((async url => {
      requests.push(String(url));
      return Response.json({ error: 'issuance_limited', message: 'Installation credentials are temporarily unavailable.' }, { status: 429 });
    }) as typeof fetch, { token: '', userId: '' });
    await expect(test.run.run(prompts, true)).rejects.toThrow('Installation credentials are temporarily unavailable.');
    expect(test.run.state()).toMatchObject({ state: 'failed', error: expect.stringContaining('Installation credentials are temporarily unavailable.') });
    expect(requests).toEqual(['https://cloud.example/api/installer/intent']);
  });

  it('rejects an invalid explicit install credential even when account credentials exist', async () => {
    let calls = 0;
    const test = fixture((async () => { calls++; return Response.json(answer()); }) as typeof fetch);
    writeFileSync(test.configPath, JSON.stringify({ install_id: installCredentials.install_id }), { mode: 0o600 });
    await expect(test.run.run(prompts, true)).rejects.toThrow();
    expect(test.run.state().state).toBe('failed');
    expect(calls).toBe(0);
  });
});
