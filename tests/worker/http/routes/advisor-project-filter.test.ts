import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { AdvisorRoutes } from './src/services/worker/http/routes/AdvisorRoutes.ts';
  const database = process.env.FIXTURE_DATABASE;
  let store = new SessionStore(database, { syncOpsEnabled: false });
  const seed = (id, project, time, platform = 'claude') => {
    const session = store.createSDKSession(id, project, 'Owned advisor question', undefined, platform);
    return store.recordAdvisorCall({
      sessionDbId: session, contentSessionId: id, project, platformSource: platform,
      toolUseId: 'tool-' + id, advice: 'Advice for ' + id, occurredAtEpoch: time,
    }).id;
  };
  seed('older', 'Team_%/Service', 1000);
  seed('middle', 'TEAM_%/SERVICE', 2000);
  seed('newer', 'team_%/service', 3000);
  seed('different', 'team_AX/service', 4000);
  seed('other-platform', 'TEAM_%/SERVICE', 5000, 'codex');
  seed('accent-upper', 'Équipe', 6000);
  seed('accent-lower', 'équipe', 7000);
  const before = store.db.query('SELECT id, project, advice FROM advisor_calls ORDER BY id').all();
  // The existing v58 schema already has the binary project index. Reopen it
  // without the new companion index to exercise the normal upgrade path.
  store.db.run('DROP INDEX IF EXISTS idx_advisor_calls_project_nocase');
  store.close();
  store = new SessionStore(database, { syncOpsEnabled: false });
  const app = express();
  new AdvisorRoutes({ getSessionStore: () => store }).setupRoutes(app);
  let server;
  try {
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const url = 'http://127.0.0.1:' + server.address().port + '/api/advisor-calls';
    const get = async parameters => {
      const response = await fetch(url + '?' + new URLSearchParams(parameters));
      if (response.status !== 200) throw new Error('Advisor list returned ' + response.status + ': ' + await response.text());
      return response.json();
    };
    const scope = { project: 'team_%/service', platformSource: 'claude' };
    const result = {
      full: await get({ ...scope, limit: '100' }),
      first: await get({ ...scope, offset: '0', limit: '2' }),
      second: await get({ ...scope, offset: '2', limit: '2' }),
      beyond: await get({ ...scope, offset: '3', limit: '2' }),
      direct: store.getAdvisorCalls(0, 100, 'team_%/service', 'claude'),
      different: await get({ project: 'team_AX/service' }),
      platform: await get({ project: 'TEAM_%/SERVICE', platformSource: 'codex' }),
      accentUpper: await get({ project: 'Équipe' }),
      accentLower: await get({ project: 'équipe' }),
      all: await get({ limit: '100' }),
      unchanged: JSON.stringify(before) === JSON.stringify(store.db.query('SELECT id, project, advice FROM advisor_calls ORDER BY id').all()),
    };
    console.log(JSON.stringify(result));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    store.close();
  }
`;

let result: any;
beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'owned-advisor-project-'));
  try {
    const child = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../../../..'),
      env: {
        ...process.env, FIXTURE_DATABASE: join(directory, 'history.db'),
        CLAUDE_MEM_DATA_DIR: join(directory, 'data'),
        CLAUDE_CONFIG_DIR: join(directory, 'config'),
        CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    result = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const names = (page: any): string[] => page.items.map((row: any) => row.content_session_id);

describe('advisor project filtering through HTTP and SQLite', () => {
  it('lists calls across ASCII project spellings after reopening existing storage', () => {
    expect(names(result.full)).toEqual(['newer', 'middle', 'older']);
    expect(names(result.direct)).toEqual(names(result.full));
    expect(result.full.items.map((row: any) => row.project)).toEqual(['team_%/service', 'TEAM_%/SERVICE', 'Team_%/Service']);
    expect(result.unchanged).toBe(true);
  });

  it('paginates and computes hasMore after matching all project spellings', () => {
    expect(names(result.first)).toEqual(['newer', 'middle']);
    expect(result.first).toMatchObject({ offset: 0, limit: 2, hasMore: true });
    expect(names(result.second)).toEqual(['older']);
    expect(result.second).toMatchObject({ offset: 2, limit: 2, hasMore: false });
    expect(names(result.beyond)).toEqual([]);
    expect(result.beyond.hasMore).toBe(false);
  });

  it('keeps project wildcards literal and retains platform isolation', () => {
    expect(names(result.different)).toEqual(['different']);
    expect(names(result.platform)).toEqual(['other-platform']);
    expect(result.full.items.every((row: any) => row.platform_source === 'claude')).toBe(true);
  });

  it('uses SQLite NOCASE semantics without folding distinct non-ASCII names', () => {
    expect(names(result.accentUpper)).toEqual(['accent-upper']);
    expect(names(result.accentLower)).toEqual(['accent-lower']);
    expect(result.all.items).toHaveLength(7);
    expect(result.all.hasMore).toBe(false);
  });
});
