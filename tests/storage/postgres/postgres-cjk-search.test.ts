// SPDX-License-Identifier: Apache-2.0
//
// PostgreSQL keyword search must recall a term in a script the text-search
// parser keeps as one lexeme by matching it as a literal substring (#3982).
// The contract is the server SQLite read, MemoryItemsRepository.search, which
// the worker already follows: every term matches, each by substring or by its
// word forms.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  usesBm25Index,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { quoteIdentifier } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

// pg_textsearch deliberately answers keyword search with any-term bm25 and
// skips the substring path, so this suite only has meaning where that
// extension is absent (the stock pgvector image). Existing suites use the same
// guard rather than a second database.
function skipsOnBm25(client: PostgresPoolClient): boolean {
  if (!usesBm25Index(client)) return false;
  console.warn('pg_textsearch is in use here; the unsegmented-script substring path is not exercised');
  return true;
}

describe('server beta postgres unsegmented-script keyword search (#3982)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires explicit CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration tests', () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;

  beforeEach(async () => {
    client = await pool.connect();
    schemaName = `cm_pg_cjk_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
  });

  afterEach(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      client.release();
    }
  });

  async function scope(name: string) {
    const team = await storage.teams.create({ name: `${name} team` });
    const project = await storage.projects.create({ teamId: team.id, name });
    return { team, project };
  }

  async function store(projectId: string, teamId: string, content: string) {
    return storage.observations.create({ projectId, teamId, content });
  }

  async function search(projectId: string, teamId: string, query: string): Promise<string[]> {
    const rows = await storage.observations.search({ projectId, teamId, query });
    return rows.map(row => row.content);
  }

  it('finds a CJK term inside a run the tsvector parser keeps whole', async () => {
    if (skipsOnBm25(client)) return;
    const { team, project } = await scope('cjk');
    await store(project.id, team.id, 'worker 修改了连接池配置');

    expect(await search(project.id, team.id, 'worker 连接池')).toEqual(['worker 修改了连接池配置']);
    expect(await search(project.id, team.id, '连接池')).toEqual(['worker 修改了连接池配置']);
  });

  it('finds Japanese and Korean terms inside an unsegmented run', async () => {
    if (skipsOnBm25(client)) return;
    const { team, project } = await scope('kana');
    await store(project.id, team.id, '設定を変更しました');
    await store(project.id, team.id, '설정을변경했습니다');

    expect(await search(project.id, team.id, '変更')).toEqual(['設定を変更しました']);
    expect(await search(project.id, team.id, '設定')).toEqual(['設定を変更しました']);
    expect(await search(project.id, team.id, '설정')).toEqual(['설정을변경했습니다']);
  });

  it('finds a decomposed Korean term by the jamo it is written with', async () => {
    if (skipsOnBm25(client)) return;
    const { team, project } = await scope('jamo');
    // NFD 설정을변경했습니다, as a decomposed Korean write stores it.
    const content = '\u1109\u1165\u11AF\u110C\u1165\u11BC\u110B\u1173\u11AF'
      + '\u1107\u1167\u11AB\u1100\u1167\u11BC\u1112\u1166\u11BA'
      + '\u1109\u1173\u11B7\u1102\u1175\u11AB';
    await store(project.id, team.id, content);

    // NFD 정: the term is a jamo run the parser cannot segment.
    const term = '\u110C\u1165\u11BC';
    expect(await search(project.id, team.id, term)).toEqual([content]);
  });

  it('drops an English stop word instead of failing the whole query', async () => {
    if (skipsOnBm25(client)) return;
    const { team, project } = await scope('stopword');
    await store(project.id, team.id, 'the 設定を変更しました');
    await store(project.id, team.id, '変更だけ');

    expect(await search(project.id, team.id, 'the 設定')).toEqual(['the 設定を変更しました']);
    // The stop word adds no condition, so the other content word still decides.
    expect((await search(project.id, team.id, '変更 the')).sort())
      .toEqual(['the 設定を変更しました', '変更だけ'].sort());
  });

  it('keeps AND semantics across every term', async () => {
    if (skipsOnBm25(client)) return;
    const { team, project } = await scope('and');
    await store(project.id, team.id, '连接池');
    await store(project.id, team.id, '数据库 连接池');

    expect(await search(project.id, team.id, '数据 连接池')).toEqual(['数据库 连接池']);
  });

  it('leaves plain ASCII keyword search and its AND semantics unchanged', async () => {
    if (skipsOnBm25(client)) return;
    const { team, project } = await scope('ascii');
    await store(project.id, team.id, 'restore snapshots require tables');
    await store(project.id, team.id, 'restore only');

    expect(await search(project.id, team.id, 'restore snapshots')).toEqual(['restore snapshots require tables']);
    expect(await search(project.id, team.id, 'restore missing')).toEqual([]);
  });

  it('keeps project and team scope on the substring path', async () => {
    if (skipsOnBm25(client)) return;
    const own = await scope('own');
    const foreign = await scope('foreign');
    await store(own.project.id, own.team.id, '设定 保持');
    await store(foreign.project.id, foreign.team.id, '设定 保持');

    expect(await search(own.project.id, own.team.id, '设定')).toEqual(['设定 保持']);
    expect(await search(own.project.id, foreign.team.id, '设定')).toEqual([]);
  });
});
