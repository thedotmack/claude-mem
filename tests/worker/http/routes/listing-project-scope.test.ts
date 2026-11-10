import { beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep real route/store imports isolated from neighbouring route module mocks.
const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { PaginationHelper } from './src/services/worker/PaginationHelper.ts';
  import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
  const store = new SessionStore(':memory:');
  const projects = ['repo', 'repo ', ' repo', 'repo\t'];
  const expected = projects.map((project, i) => {
    const content = 'content-' + i;
    const memory = 'memory-' + i;
    const session = store.createSDKSession(content, project, 'Fixture prompt');
    store.updateMemorySessionId(session, memory);
    store.storeObservation(memory, project, {
      type: 'discovery', title: 'Project ' + i, narrative: 'Fixture memory',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1);
    const tool = store.upsertToolUse({ toolUseId: 'tool-' + i, contentSessionId: content,
      sessionDbId: session, memorySessionId: memory, project, toolName: 'Read', toolInput: '{}' });
    return { project, content, tool };
  });
  const facade = { getSessionStore: () => store };
  const app = express();
  new DataRoutes(new PaginationHelper(facade), facade, {}, {}, {}, Date.now()).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const results = [];
    for (const row of expected) {
      const filter = new URLSearchParams({ project: row.project, platformSource: 'claude' });
      const sessions = await (await fetch(url + '/api/sessions?' + filter)).json();
      const tools = await (await fetch(url + '/api/tool-uses?' + filter)).json();
      const feed = await (await fetch(url + '/api/observations?' + filter)).json();
      results.push({ expected: row, sessions: sessions.sessions, tools: tools.toolUses, feed: feed.items });
    }
    const blank = new URLSearchParams({ project: ' \t ' });
    const unscoped = await (await fetch(url + '/api/tool-uses?' + blank)).json();
    console.log(JSON.stringify({ results, unscoped: unscoped.count }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
`;

let output: any;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'listing-project-scope-'));
  try {
    const run = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../../../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    output = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const [index, project] of ['repo', 'repo ', ' repo', 'repo\t'].entries()) {
  test(`session catalog keeps the selected project ${JSON.stringify(project)}`, () => {
    const row = output.results[index];
    expect(row.feed.map((item: any) => item.project)).toEqual([project]);
    expect(row.sessions.map((item: any) => item.content_session_id)).toEqual([row.expected.content]);
  });

  test(`tool index keeps the selected project ${JSON.stringify(project)}`, () => {
    const row = output.results[index];
    expect(row.tools.map((item: any) => item.id)).toEqual([row.expected.tool]);
    expect(row.tools.map((item: any) => item.project)).toEqual([project]);
  });
}

test('a blank project still leaves the tool index unscoped', () => {
  expect(output.unscoped).toBe(4);
});
