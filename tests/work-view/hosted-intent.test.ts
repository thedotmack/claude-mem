import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });
function fixture(response: typeof fetch = (async () => Response.json(answer())) as typeof fetch, credentials = { token: 'setup-token', userId: 'owner' }) {
  const scratch = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'hosted-intent-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databasePath = join(dir, 'memory.db');
  const store = new SessionStore(databasePath);
  cleanup.push(() => store.close());
  const run = new HostedIntent({
    origin: () => 'https://cloud.example/', credentials: () => credentials, ledgerDir: join(dir, 'work-view'),
    openDatabase: () => new Database(databasePath, { readonly: true }),
    appendWorkStateEntry: entry => { store.appendWorkStateEntry(entry); }, homeProject: () => 'home',
    fetch: response, now: () => at, timezoneOffsetMinutes: () => 420,
  });
  return { run, dir, store, databasePath };
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

  it('refuses missing credentials, no prompts and ambiguous cross-agent ids before upload', async () => {
    let calls = 0;
    const fetch = (async () => { calls++; return Response.json(answer()); }) as typeof globalThis.fetch;
    await expect(fixture(fetch, { token: '', userId: '' }).run.run(prompts, true)).rejects.toThrow('CMEM account connection');
    await expect(fixture(fetch).run.run([], true)).rejects.toThrow('No owner-typed prompts');
    await expect(fixture(fetch).run.run([prompts[0], { ...prompts[0], platformSource: 'claude' }], true)).rejects.toThrow('shared by multiple agents');
    expect(calls).toBe(0);
  });
});
