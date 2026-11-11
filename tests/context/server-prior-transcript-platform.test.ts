import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toLocalObservationShape, toLocalSummaryShape } from '../../src/services/context/ServerContextRows.js';

// The producer is the real PostgreSQL repository and /v1/context route. A
// child owns frozen transcript paths, so no developer history can be read.
const fixture = String.raw`
  import express from 'express';
  import pg from 'pg';
  import { createHash, randomUUID } from 'node:crypto';
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from './src/storage/postgres/index.ts';
  import { ServerV1PostgresRoutes } from './src/server/routes/v1/ServerV1PostgresRoutes.ts';
  import { ServerClient } from './src/services/hooks/server-client.ts';
  import { generateServerContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { cwdToDashed } from './src/services/context/ObservationCompiler.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';

  ModeManager.getInstance().loadMode('code');
  const cwd = '/owned/server-mixed-platform-checkout';
  const transcripts = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwdToDashed(cwd));
  mkdirSync(transcripts, { recursive: true });
  const transcript = (id, text) => writeFileSync(join(transcripts, id + '.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  const schema = 'server_prior_' + randomUUID().replaceAll('-', '_');
  const admin = new pg.Pool({ connectionString: process.env.CLAUDE_MEM_TEST_POSTGRES_URL });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({
    connectionString: process.env.CLAUDE_MEM_TEST_POSTGRES_URL,
    options: '-c search_path=' + schema,
  });
  let server;
  try {
    await bootstrapServerPostgresSchema(pool);
    const repos = createPostgresStorageRepositories(pool);
    const team = await repos.teams.create({ name: 'Owned platform team' });
    const project = await repos.projects.create({ teamId: team.id, name: 'Owned platform project' });
    const seed = async (host, platform, epoch) => {
      const session = await repos.sessions.create({
        teamId: team.id, projectId: project.id,
        contentSessionId: host, externalSessionId: host, platformSource: platform,
      });
      const observation = await repos.observations.create({
        teamId: team.id, projectId: project.id, serverSessionId: session.id,
        kind: 'discovery', content: host + ' observation',
        // The linked session is authoritative even if old metadata disagrees.
        metadata: { title: host + ' observation', project: 'mixed-project',
          concepts: ['how-it-works'], platformSource: platform === 'codex' ? 'claude' : 'codex' },
      });
      await pool.query('UPDATE observations SET created_at = to_timestamp($1 / 1000.0) WHERE id = $2',
        [epoch, observation.id]);
    };
    if (process.env.PRIOR_INCLUDE_CLAUDE === 'true') {
      await seed('prior-claude', 'claude', 1700000000000);
      transcript('prior-claude', 'EXPECTED_CLAUDE_REPLY');
    }
    await seed('newer-codex', 'codex', 1700000060000);
    if (process.env.PRIOR_COLLISION === 'true') transcript('newer-codex', 'UNRELATED_CLAUDE_REPLY');
    await seed('active-claude', 'claude', 1700000120000);
    transcript('active-claude', 'CURRENT_SESSION_REPLY');
    await repos.auth.createApiKey({
      keyHash: createHash('sha256').update('owned-platform-fixture-key').digest('hex'),
      teamId: team.id, projectId: project.id, actorId: 'owned-fixture',
      scopes: ['memories:read'],
    });
    const app = express();
    app.use(express.json());
    new ServerV1PostgresRoutes({ pool, queueManager: {}, authMode: 'api-key' }).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const serverBaseUrl = 'http://127.0.0.1:' + server.address().port;
    const client = new ServerClient({ serverBaseUrl, apiKey: 'owned-platform-fixture-key' });
    const request = { projectId: project.id, folderProjects: ['mixed-project'] };
    const recent = await client.contextObservations(request);
    const queried = await client.contextObservations({ ...request, query: 'observation' });
    const result = await generateServerContextWithStats({
      runtime: 'server', projectId: project.id, serverBaseUrl, client,
    }, {
      projects: ['mixed-project'], cwd, session_id: 'active-claude', includeHealthWarning: false,
      ...(process.env.PRIOR_FILTER ? { platformSource: process.env.PRIOR_FILTER } : {}),
    });
    const identities = rows => Object.fromEntries(rows.map(row => [row.contentSessionId, row.platformSource]));
    console.log(JSON.stringify({ text: result.text, recent: identities(recent.observations),
      queried: identities(queried.observations) }));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
`;

function run(includeClaude: boolean, collision: boolean, platformSource = ''): {
  text: string;
  recent: Record<string, string>;
  queried: Record<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'server-prior-platform-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify({
      CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true',
      CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'false',
      CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false',
    }));
    const child = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'),
        CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true', PRIOR_INCLUDE_CLAUDE: String(includeClaude),
        PRIOR_COLLISION: String(collision), PRIOR_FILTER: platformSource },
      stdout: 'pipe', stderr: 'pipe', timeout: 45_000,
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('server context retains the host platform used by prior-reply selection', () => {
  const postgresTest = process.env.CLAUDE_MEM_TEST_POSTGRES_URL ? it : it.skip;

  for (const collision of [false, true]) {
    postgresTest(`reads the prior Claude reply past server Codex rows (colliding filename: ${collision})`, () => {
      const { text } = run(true, collision);
      expect(text).toContain('EXPECTED_CLAUDE_REPLY');
      expect(text).not.toContain('UNRELATED_CLAUDE_REPLY');
      expect(text).not.toContain('CURRENT_SESSION_REPLY');
      expect(text).toContain('newer-codex observation');
      expect(text).toContain('prior-claude observation');
    }, 60_000);
  }

  postgresTest('does not use a Codex session as a prior Claude reply when there is no prior Claude memory', () => {
    const { text } = run(false, true);
    expect(text).not.toContain('UNRELATED_CLAUDE_REPLY');
    expect(text).not.toContain('CURRENT_SESSION_REPLY');
    expect(text).toContain('newer-codex observation');
  }, 60_000);

  postgresTest('retains existing explicitly scoped Claude context', () => {
    const { text } = run(true, true, 'claude');
    expect(text).toContain('EXPECTED_CLAUDE_REPLY');
    expect(text).not.toContain('UNRELATED_CLAUDE_REPLY');
    expect(text).not.toContain('CURRENT_SESSION_REPLY');
    expect(text).not.toContain('newer-codex observation');
  }, 60_000);

  postgresTest('returns the linked session platform through recency and keyword context HTTP responses', () => {
    const result = run(true, false);
    const expected = { 'prior-claude': 'claude', 'newer-codex': 'codex', 'active-claude': 'claude' };
    expect(result.recent).toEqual(expected);
    expect(result.queried).toEqual(expected);
  }, 60_000);

  it('keeps older server responses compatible with an explicit request source', () => {
    const legacy = { id: 'legacy', kind: 'discovery', content: 'old response', createdAtEpoch: 1700000000000 };
    expect(toLocalObservationShape(legacy, 'project', 'claude').platform_source).toBe('claude');
    expect(toLocalSummaryShape(legacy, 'project', 'claude').platform_source).toBe('claude');
    expect(toLocalObservationShape(legacy, 'project', undefined).platform_source).toBe('');
  });
});
