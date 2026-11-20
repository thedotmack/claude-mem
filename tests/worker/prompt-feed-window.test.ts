import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { PaginationHelper } from './src/services/worker/PaginationHelper.ts';
  let store = new SessionStore(process.env.FIXTURE_DATABASE, { syncOpsEnabled: false });
  const edge = store.createSDKSession('edge', 'repo', 'Owned fixture');
  const native = store.createSDKSession('native', 'repo', 'Owned fixture');
  const codex = store.createSDKSession('edge', 'repo', 'Owned fixture', undefined, 'codex');
  const other = store.createSDKSession('other', 'other-repo', 'Owned fixture');
  let sequence = 0;
  const add = (session, content, text, time, nativeId = null) => Number(store.db.prepare(
    'INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, native_prompt_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(session, content, ++sequence, text, new Date(time).toISOString(), time, nativeId).lastInsertRowid);
  const ids = {};
  ids.exactOld = add(edge, 'edge', 'exact window', 1000);
  ids.exactNew = add(edge, 'edge', 'exact window', 11000);
  ids.beyondOld = add(edge, 'edge', 'beyond window', 2000);
  ids.beyondNew = add(edge, 'edge', 'beyond window', 12001);
  ids.insideOld = add(edge, 'edge', 'inside window', 3000);
  ids.insideNew = add(edge, 'edge', 'inside window', 12999);
  ids.tieOld = add(edge, 'edge', 'same timestamp', 20000);
  ids.tieNew = add(edge, 'edge', 'same timestamp', 20000);
  ids.legacyOld = add(native, 'native', 'repeated turn', 40000);
  ids.nativeFirst = add(native, 'native', 'repeated turn', 41000, 'turn-a');
  ids.nativeSecond = add(native, 'native', 'repeated turn', 41000, 'turn-b');
  ids.legacyNew = add(native, 'native', 'repeated turn', 42000);
  ids.codex = add(codex, 'edge', 'exact window', 21000);
  ids.other = add(other, 'other', 'exact window', 21000);
  const before = JSON.stringify(store.db.query('SELECT * FROM user_prompts ORDER BY id').all());
  // Exercise an existing database that already has native identity columns.
  store.db.run('DROP INDEX IF EXISTS idx_user_prompts_legacy_window');
  store.close();
  store = new SessionStore(process.env.FIXTURE_DATABASE, { syncOpsEnabled: false });
  const prepare = store.db.prepare.bind(store.db);
  let feedSql;
  store.db.prepare = sql => {
    if (sql.includes('FROM user_prompts up') && sql.includes('NOT EXISTS')) feedSql = sql;
    return prepare(sql);
  };
  try {
    const helper = new PaginationHelper({ getSessionStore: () => store });
    const edgePage = (offset, limit) => helper.getPrompts(offset, limit, 'repo', 'claude', 'edge');
    const result = {
      ids,
      full: edgePage(0, 100),
      first: edgePage(0, 2),
      second: edgePage(2, 2),
      third: edgePage(4, 2),
      beyond: edgePage(5, 2),
      native: helper.getPrompts(0, 100, 'repo', 'claude', 'native'),
      codex: helper.getPrompts(0, 100, 'repo', 'codex', 'edge'),
      other: helper.getPrompts(0, 100, 'other-repo'),
      unchanged: before === JSON.stringify(store.db.query('SELECT * FROM user_prompts ORDER BY id').all()),
    };
    helper.getPrompts(0, 100, 'repo', undefined, 'edge');
    result.plan = prepare('EXPLAIN QUERY PLAN ' + feedSql).all('repo', 'edge', 10000, 101, 0);
    console.log(JSON.stringify(result));
  } finally { store.close(); }
`;

let result: any;
beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'owned-prompt-window-'));
  try {
    const child = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: {
        ...process.env, FIXTURE_DATABASE: join(directory, 'history.db'),
        CLAUDE_MEM_DATA_DIR: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'config'),
        CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
      },
      stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    });
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    result = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const idsOf = (page: any): number[] => page.items.map((row: any) => row.id);
describe('bounded legacy prompt retry lookup in the feed', () => {
  it('preserves the inclusive ten-second window and newest-id tie break', () => {
    const id = result.ids;
    expect(idsOf(result.full)).toEqual([id.tieNew, id.insideNew, id.beyondNew, id.exactNew, id.beyondOld]);
    expect(result.full.hasMore).toBe(false);
  });

  it('paginates after retry removal without losing a page boundary', () => {
    const id = result.ids;
    expect(idsOf(result.first)).toEqual([id.tieNew, id.insideNew]);
    expect(result.first).toMatchObject({ offset: 0, limit: 2, hasMore: true });
    expect(idsOf(result.second)).toEqual([id.beyondNew, id.exactNew]);
    expect(result.second).toMatchObject({ offset: 2, limit: 2, hasMore: true });
    expect(idsOf(result.third)).toEqual([id.beyondOld]);
    expect(result.third.hasMore).toBe(false);
    expect(idsOf(result.beyond)).toEqual([]);
    expect(result.beyond.hasMore).toBe(false);
  });

  it('keeps distinct native identities while deduplicating only legacy retries', () => {
    const id = result.ids;
    expect(idsOf(result.native)).toEqual([id.legacyNew, id.nativeSecond, id.nativeFirst]);
    expect(result.native.items.map((row: any) => row.prompt_text)).toEqual(Array(3).fill('repeated turn'));
  });

  it('keeps content-session, project and platform scopes independent', () => {
    expect(idsOf(result.codex)).toEqual([result.ids.codex]);
    expect(idsOf(result.other)).toEqual([result.ids.other]);
    expect(result.full.items.every((row: any) => row.platform_source === 'claude')).toBe(true);
  });

  it('uses both time bounds for the actual feed subquery after reopening existing storage', () => {
    const boundedLookup = result.plan.some((row: { detail: string }) =>
      /\bduplicate\b/.test(row.detail)
      && row.detail.includes('created_at_epoch>?')
      && row.detail.includes('created_at_epoch<?'));
    expect(boundedLookup).toBe(true);
    expect(result.unchanged).toBe(true);
  });
});
