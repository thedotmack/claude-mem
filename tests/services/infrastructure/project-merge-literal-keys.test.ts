import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

// Run the real route and SQLite mutation in a clean process: settings paths
// are captured at import time, and other route suites replace these modules.
for (const transport of ['http', 'direct'] as const) {
  for (const from of ['topic ', ' topic', 'topic\t', 'topic\n']) {
    test.skipIf(process.platform === 'win32')(`project merge preserves ${JSON.stringify(from)} via ${transport}`, () => {
      const script = `
        import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
        import { execFileSync } from 'node:child_process';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import express from 'express';
        const directory = mkdtempSync(join(tmpdir(), 'merge-literal-'));
        process.env.CLAUDE_MEM_DATA_DIR = directory;
        writeFileSync(join(directory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }));
        const { SessionStore } = await import('./src/services/sqlite/SessionStore.ts');
        const { mergeProjectInto } = await import('./src/services/infrastructure/ProjectMerge.ts');
        const { DataRoutes } = await import('./src/services/worker/http/routes/DataRoutes.ts');
        const { getPathModeProjectContext } = await import('./src/utils/project-name.ts');
        const from = ${JSON.stringify(from)}, into = ' destination ';
        const plain = from.trim(), dbPath = join(directory, 'claude-mem.db');
        const sourcePath = join(directory, from), plainPath = join(directory, plain);
        mkdirSync(sourcePath); mkdirSync(plainPath);
        for (const checkout of [sourcePath, plainPath]) execFileSync('git', ['init', '--quiet', checkout]);
        const sourceKey = getPathModeProjectContext(sourcePath).primary;
        const store = new SessionStore(dbPath);
        const ids = [];
        for (const [index, project] of [sourceKey, plain].entries()) {
          const memory = 'memory-' + index;
          const session = store.createSDKSession('content-' + index, project, 'prompt');
          store.ensureMemorySessionIdRegistered(session, memory);
          const observation = store.storeObservation(memory, project, { type: 'discovery', title: 'row-' + index,
            subtitle: null, narrative: 'Saved under literal project', facts: [], concepts: [], files_read: [], files_modified: [] }, 1);
          const summary = store.storeSummary(memory, project, { request: 'summary-' + index, investigated: '', learned: '',
            completed: '', next_steps: '', notes: null }, 1, 0);
          ids.push({ observation: observation.id, summary: summary.id, project });
        }
        store.close();
        let server;
        try {
          let merge;
          if (${JSON.stringify(transport)} === 'http') {
            const app = express(); app.use(express.json());
            new DataRoutes({}, {}, {}, {}, {}, Date.now()).setupRoutes(app);
            server = app.listen(0, '127.0.0.1');
            await new Promise(resolve => server.once('listening', resolve));
            merge = async dryRun => {
              const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/projects/merge', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, into, dryRun }) });
              if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + await response.text());
              return response.json();
            };
          } else merge = dryRun => mergeProjectInto({ from, into, dataDirectory: directory, dryRun });
          const dryRun = await merge(true);
          const before = new SessionStore(dbPath);
          const beforeRows = before.db.query('SELECT merged_into_project FROM observations ORDER BY id').all();
          const beforeOps = before.db.query('SELECT body FROM sync_outbox').all(); before.close();
          const result = await merge(false);
          const verify = new SessionStore(dbPath);
          const observations = verify.db.query('SELECT id, project, merged_into_project FROM observations ORDER BY id').all();
          const summaries = verify.db.query('SELECT id, project, merged_into_project FROM session_summaries ORDER BY id').all();
          const ops = verify.db.query('SELECT body FROM sync_outbox').all().map(row => JSON.parse(row.body));
          verify.close();
          console.log(JSON.stringify({ sourceKey, dryRun, beforeRows, beforeOps, result, observations, summaries, ops, ids }));
        } finally {
          if (server) await new Promise(resolve => server.close(resolve));
          rmSync(directory, { recursive: true, force: true });
        }
      `;
      const child = spawnSync(process.execPath, ['--eval', script], { cwd: process.cwd(), encoding: 'utf8' });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
      expect(result.sourceKey).toBe(from);
      expect(result.dryRun).toMatchObject({ from, into: ' destination ', mergedObservations: 1, mergedSummaries: 1, dryRun: true });
      expect(result.beforeRows).toEqual([{ merged_into_project: null }, { merged_into_project: null }]);
      expect(result.beforeOps).toEqual([]);
      expect(result.result).toMatchObject({ from, into: ' destination ', mergedObservations: 1, mergedSummaries: 1 });
      for (const rows of [result.observations, result.summaries]) {
        expect(rows.map(({ project, merged_into_project }: any) => ({ project, merged_into_project }))).toEqual([
          { project: from, merged_into_project: ' destination ' }, { project: from.trim(), merged_into_project: null },
        ]);
      }
      expect(result.ops).toEqual([{ op: 'remap_project', where: { project: from, merged_into_project_is_null: true },
        fields: { merged_into_project: ' destination ' } }]);
    }, 15_000);
  }
}
