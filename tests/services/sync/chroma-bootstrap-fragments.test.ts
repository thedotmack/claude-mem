import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaSyncState } from './src/services/sync/ChromaSyncState.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const session = store.createSDKSession('host', 'project', 'prompt');
  store.updateMemorySessionId(session, 'observer');
  const partial = store.storeObservation('observer', 'project', { type: 'discovery', title: 'Partial observation', subtitle: null, narrative: 'Present narrative', facts: ['Missing fact'], concepts: [], files_read: [], files_modified: [] }, 1);
  const complete = store.storeObservation('observer', 'project', { type: 'discovery', title: 'Complete observation', subtitle: null, narrative: 'Already present', facts: [], concepts: [], files_read: [], files_modified: [] }, 2);
  const summary = (request, completed) => ({ request, investigated: '', learned: '', completed, next_steps: '', notes: null });
  const partialSummary = store.storeObservations('observer', 'project', [], summary('Present request', 'Missing completion'), 1).summaryId;
  const completeSummary = store.storeObservations('observer', 'project', [], summary('Already present request', ''), 2).summaryId;
  const written = [];
  const indexed = new Set(['obs_' + partial.id + '_narrative', 'obs_' + complete.id + '_narrative', 'summary_' + partialSummary + '_request', 'summary_' + completeSummary + '_request']);
  const manager = ChromaMcpManager.getInstance();
  manager.acceptsMutations = () => true;
  manager.callTool = async (tool, args) => {
    if (tool === 'chroma_get_documents') {
      if (args.offset > 0) return { ids: [], metadatas: [] };
      return { ids: [...indexed], metadatas: [...[partial, complete].map(row => ({ sqlite_id: row.id, doc_type: 'observation' })), ...[partialSummary, completeSummary].map(id => ({ sqlite_id: id, doc_type: 'session_summary' }))] };
    }
    if (tool === 'chroma_add_documents') { written.push(...args.ids); for (const id of args.ids) indexed.add(id); }
    return {};
  };
  const sync = new ChromaSync('claude-mem');
  await sync.bootstrapWatermarksFromChroma('project', store);
  const before = ChromaSyncState.getPending('project', 'observations');
  const beforeSummaries = ChromaSyncState.getPending('project', 'summaries');
  const outcome = await sync.ensureBackfilled('project', store);
  console.log(JSON.stringify({ before, beforeSummaries, partialSummary, completeSummary, outcome, partial: partial.id, complete: complete.id, written, after: ChromaSyncState.getPending('project', 'observations'), factPresent: indexed.has('obs_' + partial.id + '_fact_0') }));
  store.close();
`;

describe('Chroma bootstrap fragment completeness', () => {
  it('repairs a partially indexed row without re-indexing a complete row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroma-bootstrap-fragments-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.before).toEqual([result.partial]);
      expect(result.beforeSummaries).toEqual([result.partialSummary]);
      expect(result.written).toContain('summary_' + result.partialSummary + '_completed');
      expect(result.written).not.toContain('summary_' + result.completeSummary + '_request');
      expect(result.outcome).toBe('completed');
      expect(result.factPresent).toBe(true);
      expect(result.written).toContain('obs_' + result.partial + '_fact_0');
      expect(result.written).not.toContain('obs_' + result.complete + '_narrative');
      expect(result.after).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
