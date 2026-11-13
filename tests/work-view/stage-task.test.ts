import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoStageAfterRefresh, generateStage, gatherStageEvidence, placeStageEvidence, resolveAutoStageFormat, type StageEvidence, type StageRequest } from '../../src/services/work-view/stage-task.js';
import { BUILT_IN_STAGE_FORMATS, readStageFormats } from '../../src/services/work-view/stage-formats.js';
import { OwnerRunStore } from '../../src/services/work-view/owner-run-store.js';
import { AUTO_STAGE_LIMIT, STAGE_OUTPUT_KINDS } from '../../src/services/work-view/owner-runs.mjs';
import { groupIdFor, runCli } from '../../src/services/work-view/request-groups.mjs';
import { scratchDir } from '../helpers/scratch-dir.js';

const SESSION = '6f1c2a9e-4b7d-4e0a-9c35-2d8f7a1b0c11';
const KEY = JSON.stringify(['conversation', 'claude', SESSION]);
const brief = BUILT_IN_STAGE_FORMATS.find(format => format.id === 'brief')!;

let dir: string;
beforeEach(() => { dir = scratchDir('stage-task-test'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A spawn that records its argv and prints `stdout`; exit 128 when `stdout` is null (git: unknown revision). */
function fakeGit(stdout: string | null) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    const child = new EventEmitter() as any;
    const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdout = stream(); child.stderr = stream();
    setTimeout(() => { if (stdout !== null) child.stdout.emit('data', stdout); child.emit('close', stdout === null ? 128 : 0); }, 1);
    return child;
  }) as any;
  return { calls, spawn };
}

function mediaDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, title TEXT, created_at_epoch INTEGER);
    CREATE TABLE media_attachments (id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE observation_media_links (observation_id INTEGER, attachment_id TEXT, event_key TEXT, label TEXT);
    INSERT INTO sdk_sessions VALUES (1, 'claude', '${SESSION}', 'm1');
    INSERT INTO observations VALUES (7, 'm1', 'The board after the change', 1000);
    INSERT INTO media_attachments VALUES ('shot-ready', 'ready'), ('shot-converting', 'converting');
    INSERT INTO observation_media_links VALUES (7, 'shot-ready', 'e', 'Screenshot 1'), (7, 'shot-converting', 'e', 'Screenshot 2');`);
  return db;
}

describe('gatherStageEvidence', () => {
  it('opens the request\'s real screenshots, made files and commit diffs, and names what it could not open', async () => {
    const dataDir = join(dir, 'data'), deliverablesDir = join(dataDir, 'deliverables'), checkout = join(dir, 'checkout');
    mkdirSync(join(dataDir, 'media-v1', 'shot-ready'), { recursive: true });
    mkdirSync(join(deliverablesDir, 'proj'), { recursive: true });
    mkdirSync(checkout);
    writeFileSync(join(dataDir, 'media-v1', 'shot-ready', 'viewer.webp'), 'VIEWER-BYTES');
    writeFileSync(join(dataDir, 'media-v1', 'shot-ready', 'llm.webp'), 'LLM-BYTES');
    writeFileSync(join(deliverablesDir, 'proj', 'hero-1a2b3c4d.png'), 'PNG-BYTES');
    writeFileSync(join(dir, 'outside.png'), 'OUTSIDE');
    const git = fakeGit(' src/board.tsx | 12 ++++\n+const answer = send()\n');
    const request: StageRequest = {
      id: KEY, groupId: groupIdFor(KEY), title: 'Board', conversationKeys: [KEY],
      workProduct: [
        { kind: 'image', title: 'Hero image', deliverable: true, bucketPath: join(deliverablesDir, 'proj', 'hero-1a2b3c4d.png'), url: '/api/deliverables/3/hero-1a2b3c4d.png' },
        { kind: 'image', title: 'Planted path', deliverable: true, bucketPath: join(dir, 'outside.png'), url: '/api/deliverables/4/outside.png' },
        { kind: 'commit', title: 'abc1234 answer from the row', sha: 'abc1234' },
        { kind: 'commit', title: 'hostile', sha: '--output=/tmp/pwned' },
        { kind: 'commit', title: 'hostile', sha: 'abc1234; rm -rf ~' },
        { kind: 'pr', title: 'PR 12', url: 'https://github.com/example/repo/pull/12' },
      ],
    };
    const evidence = await gatherStageEvidence(request, join(dir, 'run', 'evidence'), {
      dataDir, deliverablesDir, spawnImpl: git.spawn, openDatabase: mediaDatabase, sessionCwd: () => checkout,
    });
    expect(evidence.map(item => [item.id, item.kind, item.title, item.file !== null])).toEqual([
      ['E1', 'screenshot', 'Screenshot 1: The board after the change', true],
      ['E2', 'deliverable', 'Hero image', true],
      ['E3', 'deliverable', 'Planted path', false],
      ['E4', 'diff', 'abc1234 answer from the row', true],
      ['E5', 'link', 'PR 12', false],
    ]);
    // The agent reads the small copy; the stage shows the full image.
    expect(readFileSync(evidence[0].file!, 'utf8')).toBe('LLM-BYTES');
    expect(evidence[0].embed).toEqual({ path: join(dataDir, 'media-v1', 'shot-ready', 'viewer.webp'), contentType: 'image/webp' });
    expect(evidence[0].url).toBe('/api/media/shot-ready/viewer');
    expect(evidence[2].note).toMatch(/not opened/);
    expect(readFileSync(evidence[3].file!, 'utf8')).toContain('+const answer = send()');
    expect(evidence[4].note).toMatch(/did not open it/);
    // One git call, as an argument array, only for the sha that is a sha.
    expect(git.calls).toEqual([{ command: 'git', args: ['-C', checkout, 'show', '--stat', '--patch', '--no-color', '--no-ext-diff', 'abc1234'] }]);
  });

  it('says a commit was not opened when no local checkout has it, and reads a database from before media capture as no screenshots', async () => {
    const git = fakeGit(null);
    const plain = () => { const db = new Database(':memory:'); db.exec('CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY)'); return db; };
    const evidence = await gatherStageEvidence({ id: KEY, groupId: groupIdFor(KEY), title: null, conversationKeys: [KEY], workProduct: [{ kind: 'commit', title: 'abc1234', sha: 'abc1234' }] },
      join(dir, 'evidence'), { dataDir: dir, deliverablesDir: join(dir, 'deliverables'), spawnImpl: git.spawn, openDatabase: plain, sessionCwd: () => dir });
    expect(evidence).toEqual([expect.objectContaining({ id: 'E1', kind: 'diff', file: null, note: expect.stringMatching(/not found in a checkout/) })]);
  });
});

describe('placeStageEvidence', () => {
  const image = () => { const path = join(dir, 'viewer.webp'); writeFileSync(path, 'IMG'); return path; };
  const evidence = (): StageEvidence[] => [
    { id: 'E1', kind: 'screenshot', title: 'Board', file: '/run/E1.webp', note: null, embed: { path: image(), contentType: 'image/webp' }, url: '/api/media/shot/viewer' },
    { id: 'E2', kind: 'diff', title: 'abc1234', file: '/run/E2.diff', note: null, embed: null, url: null },
  ];

  it('puts the real image into an HTML stage and the served link into a Markdown stage', () => {
    expect(placeStageEvidence('<img src="evidence:E1" alt="Board"> see evidence:E2', 'html', evidence()))
      .toBe(`<img src="data:image/webp;base64,${Buffer.from('IMG').toString('base64')}" alt="Board"> see evidence:E2`);
    expect(placeStageEvidence('![Board](evidence:E1)', 'markdown', evidence())).toBe('![Board](/api/media/shot/viewer)');
  });

  it('refuses a stage that shows evidence that was never gathered, or shows a diff as an image', () => {
    expect(() => placeStageEvidence('![x](evidence:E9)', 'markdown', evidence())).toThrow(/not gathered \(E9\)/);
    expect(() => placeStageEvidence('<img src="evidence:E2">', 'html', evidence())).toThrow(/as an image, and it is not one/);
    expect(() => placeStageEvidence('![diff](evidence:E2)', 'markdown', evidence())).toThrow(/no file My Work can open/);
  });
});

describe('stage formats', () => {
  it('every built-in names an output kind the definition lists, and an owner file named like a built-in replaces it', () => {
    for (const format of BUILT_IN_STAGE_FORMATS) expect(STAGE_OUTPUT_KINDS).toContain(format.output);
    expect(BUILT_IN_STAGE_FORMATS.map(format => format.id)).toEqual(['brief', 'one-pager', 'deck', 'technical']);
    mkdirSync(join(dir, 'stage-formats'));
    writeFileSync(join(dir, 'stage-formats', 'brief.md'), 'Three bullets, nothing else.');
    writeFileSync(join(dir, 'stage-formats', 'empty.md'), '---\nname: Empty\n---\n');
    const { formats, skipped } = readStageFormats(dir);
    expect(formats.map(format => [format.id, format.builtIn])).toEqual([['one-pager', true], ['deck', true], ['technical', true], ['brief', false]]);
    expect(formats.at(-1)).toMatchObject({ label: 'brief', output: 'markdown', instructions: 'Three bullets, nothing else.' });
    expect(skipped).toEqual(['empty.md: it has no instructions']);
  });
});

describe('generateStage', () => {
  it('hands the agent the whole request, not only what came after its last review', async () => {
    const NOW = Date.parse('2026-11-11T12:00:00.000Z'), DAY = 86_400_000;
    const ledgerDir = join(dir, 'work-view'), dataDir = join(dir, 'data');
    mkdirSync(ledgerDir, { recursive: true });
    mkdirSync(dataDir);
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, platform_source TEXT, content_session_id TEXT, memory_session_id TEXT, project TEXT, user_prompt TEXT, started_at_epoch INTEGER);
      CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
      CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_name TEXT, tool_input TEXT, created_at_epoch INTEGER);
      CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT, created_at_epoch INTEGER);
      CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);`);
    db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, 'claude', SESSION, 'm1', 'repo/tree', 'Build the release cards', NOW - 3 * DAY);
    db.prepare('INSERT INTO user_prompts (session_db_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)').run(1, 1, 'Build the release cards', NOW - 3 * DAY);
    db.prepare('INSERT INTO observations (memory_session_id, type, title, subtitle, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run('m1', 'feature', 'Cards built', 'Before the review', NOW - DAY);
    const cli = (argv: string[]) => { let output: any; runCli(argv, { dir: ledgerDir, database: db, now: NOW, print: (value: unknown) => { output = value; }, localDeviceId: '' }); return output; };
    const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const groupId = groupIdFor(KEY);
    cli(['apply', write('d.json', { groups: [{ title: 'Release cards', conversations: [KEY] }] })]);
    // The refresh saves its review just before the stage is made, so a plain `show` would be an empty amendment.
    cli(['record-progress', write('r.json', { groupId, state: 'in-progress', percent: 90, summary: 'Cards are built.', reviewBasis: cli(['show', groupId]).reviewBasis })]);
    expect(cli(['show', groupId])).toMatchObject({ mode: 'amend', conversations: [{ asks: [], observations: [] }] });

    const store = new OwnerRunStore(ledgerDir);
    const startedAt = store.beginStage(groupId, 'brief', null, { reviewedThrough: new Date(NOW).toISOString(), trigger: 'owner' })!;
    let shown: any = null;
    const state = await generateStage({
      dataDir, ledgerDir, pluginRoot: join(import.meta.dir, '..', '..', 'plugin'), store, deliverablesDir: join(dataDir, 'deliverables'), now: () => NOW,
      openDatabase: () => ({ prepare: (sql: string) => db.prepare(sql), close() {} }),
      spawnImpl: fakeGit(null).spawn, sessionCwd: () => null,
      runAgent: async task => {
        await task.prepare?.();
        await task.run(async () => {
          const [run] = readdirSync(join(ledgerDir, 'agent-runs'));
          shown = JSON.parse(readFileSync(join(ledgerDir, 'agent-runs', run, 'show.json'), 'utf8'));
          return '# Release cards\n\nNothing visual was recorded for this request.';
        }, 'claude');
        return { state: 'ok' } as any;
      },
    }, { id: KEY, groupId, title: 'Release cards', conversationKeys: [KEY], workProduct: [] }, brief, { startedAt, trigger: 'owner' });

    expect(state).toBe('ready');
    expect(shown).toMatchObject({ mode: 'full', amendSince: null, previousReview: { percent: 90 } });
    expect(shown.conversations[0].asks.map((ask: { text: string }) => ask.text)).toEqual(['Build the release cards']);
    expect(shown.conversations[0].observations.map((observation: { title: string }) => observation.title)).toEqual(['Cards built']);
  });
});

describe('automatic stages', () => {
  const START = Date.parse('2026-11-11T12:00:00.000Z');
  /** `awaiting` is whether the board files the request under Review; the percent is only what the review recorded. */
  function ledger(reviews: Array<{ session: string; percent: number; awaiting?: boolean; checkedAt: number; reviewedThrough?: string }>) {
    const ledgerDir = join(dir, 'work-view');
    mkdirSync(join(ledgerDir, 'progress'), { recursive: true });
    const groups: Record<string, unknown> = {}, ids: string[] = [], awaiting = new Set<string>();
    for (const review of reviews) {
      const groupId = groupIdFor(JSON.stringify(['conversation', 'claude', review.session]));
      ids.push(groupId);
      if (review.awaiting !== false) awaiting.add(groupId);
      groups[groupId] = { title: review.session };
      writeFileSync(join(ledgerDir, 'progress', `${groupId}.json`), JSON.stringify({ groupId, percent: review.percent, checkedAt: new Date(review.checkedAt).toISOString(), reviewedThrough: review.reviewedThrough ?? new Date(review.checkedAt).toISOString() }));
    }
    writeFileSync(join(ledgerDir, 'request-groups.json'), JSON.stringify({ version: 1, conversations: {}, groups, ignored: {} }));
    return { ledgerDir, ids, awaiting };
  }
  const run = async ({ ledgerDir, awaiting }: ReturnType<typeof ledger>, options: Partial<Parameters<typeof autoStageAfterRefresh>[0]> = {}) => {
    const made: string[] = [];
    const started = await autoStageAfterRefresh({ ledgerDir, format: brief, refreshState: 'ok', refreshStartedAtEpoch: START, awaitingCheck: async () => awaiting, generate: async groupId => { made.push(groupId); }, ...options });
    expect(started).toEqual(made);
    return made;
  };

  it('is off unless the setting names a format that exists', () => {
    expect(resolveAutoStageFormat(join(dir, 'settings.json'), dir)).toBeNull();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT: '' }));
    expect(resolveAutoStageFormat(join(dir, 'settings.json'), dir)).toBeNull();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT: 'video' }));
    expect(resolveAutoStageFormat(join(dir, 'settings.json'), dir)).toBeNull();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT: 'deck' }));
    expect(resolveAutoStageFormat(join(dir, 'settings.json'), dir)?.id).toBe('deck');
  });

  it('generates nothing while off, after a refresh that did not finish, or for a request the board does not file under Review', async () => {
    const recorded = ledger([{ session: 'done', percent: 90, checkedAt: START + 1000 }, { session: 'half', percent: 60, awaiting: false, checkedAt: START + 1000 }]);
    expect(await run(recorded, { format: null })).toEqual([]);
    expect(await run(recorded, { refreshState: 'failed' })).toEqual([]);
    expect(await run(recorded, { refreshState: 'waiting-for-agent' })).toEqual([]);
    expect(await run(recorded)).toEqual([recorded.ids[0]]);
  });

  it('asks the board which requests wait for a check, never the percent, and only when a review is due a stage', async () => {
    const recorded = ledger([{ session: 'shipped', percent: 100, awaiting: false, checkedAt: START + 2000 }, { session: 'in-review', percent: 90, checkedAt: START + 1000 }]);
    expect(await run(recorded)).toEqual([recorded.ids[1]]);
    let asked = 0;
    const counting = { awaitingCheck: async () => { asked++; return recorded.awaiting; } };
    expect(await run(recorded, { ...counting, refreshStartedAtEpoch: START + 60000 })).toEqual([]);
    expect(await run(recorded, { ...counting, format: null })).toEqual([]);
    expect(asked).toBe(0);
  });

  it('never backfills: only reviews this refresh recorded, newest first, at most three, and what the cap leaves out is not picked up later', async () => {
    const recorded = ledger([
      { session: 'old-1', percent: 90, checkedAt: START - 86400000 }, { session: 'old-2', percent: 90, checkedAt: START - 1 },
      { session: 'a', percent: 90, checkedAt: START + 1000 }, { session: 'b', percent: 90, checkedAt: START + 2000 },
      { session: 'c', percent: 90, checkedAt: START + 3000 }, { session: 'd', percent: 90, checkedAt: START + 4000 }, { session: 'e', percent: 90, checkedAt: START + 5000 },
    ]);
    const { ids } = recorded;
    expect(AUTO_STAGE_LIMIT).toBe(3);
    expect(await run(recorded)).toEqual([ids[6], ids[5], ids[4]]);
    // The next refresh starts later and records nothing new: the two the cap left out stay unstaged.
    expect(await run(recorded, { refreshStartedAtEpoch: START + 60000 })).toEqual([]);
  });

  it('makes a stage once per review version, whether that stage is ready or failed', async () => {
    const { ledgerDir, ids, awaiting } = ledger([{ session: 'a', percent: 90, checkedAt: START + 1000, reviewedThrough: '2026-11-11T11:59:00.000Z' }]);
    const store = new OwnerRunStore(ledgerDir);
    const generate = async (groupId: string) => {
      const startedAt = store.beginStage(groupId, 'brief', null, { reviewedThrough: '2026-11-11T11:59:00.000Z', trigger: 'auto' });
      store.finishStage(groupId, 'brief', startedAt, { error: 'Claude Code: quota exhausted' });
    };
    const made: string[] = [];
    const again = () => autoStageAfterRefresh({ ledgerDir, format: brief, refreshState: 'ok', refreshStartedAtEpoch: START, awaitingCheck: async () => awaiting, generate: async groupId => { made.push(groupId); await generate(groupId); } });
    await again(); await again(); await again();
    expect(made).toEqual([ids[0]]);
    expect(store.read().stages[ids[0]].brief).toMatchObject({ state: 'failed', error: 'Claude Code: quota exhausted' });
  });
});
