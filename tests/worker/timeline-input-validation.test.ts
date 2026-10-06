import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'timeline-input', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const epoch = Date.UTC(2024, 0, 1);
  const obs = store.storeObservation('memory', 'timeline-input', {
    type: 'discovery', title: 'Native timeline anchor', subtitle: null, narrative: 'timeline', facts: [], concepts: [], files_read: [], files_modified: []
  }, 1, 0, epoch);
  const summary = store.storeSummary('memory', 'timeline-input', { request: 'Native summary anchor', investigated: '', learned: '', completed: '', next_steps: '', notes: null }, 1, 0, epoch);
  const manager = new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
  const invalidAnchors = ['S1junk', '#S1.5', 'S1e0', 'S1/2', 'S9007199254740993', 1.5, Infinity, '9007199254740993'];
  const invalidDepths = [-1, 1.5, 'wat', 'Infinity', NaN, Infinity, true, ''];
  const errors = [];
  try {
    for (const anchor of invalidAnchors) {
      try { errors.push({ kind: 'anchor', input: String(anchor), result: await manager.timeline({ anchor, depth_before: 0, depth_after: 0 }) }); }
      catch (e) { errors.push({ kind: 'anchor', input: String(anchor), thrown: String(e) }); }
    }
    for (const depth of invalidDepths) {
      for (const key of ['depth_before', 'depth_after']) {
        try { errors.push({ kind: 'depth', input: String(depth), result: await manager.timeline({ anchor: obs.id, depth_before: 0, depth_after: 0, [key]: depth }) }); }
        catch (e) { errors.push({ kind: 'depth', input: String(depth), thrown: String(e) }); }
      }
    }
    const valid = [];
    for (const anchor of [obs.id, String(obs.id), '  ' + obs.id + '  ', 'S00' + summary.id, '#S0' + summary.id, new Date(epoch).toISOString()]) {
      valid.push(await manager.timeline({ anchor, depth_before: '0', depth_after: 0 }));
    }
    console.log(JSON.stringify({ errors, valid }));
  } finally { store.close(); }
`;

describe('timeline input validation at the SQL boundary', () => {
  it('rejects malformed anchors and depths without selecting a different row or throwing SQL errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-validation-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      for (const entry of result.errors) {
        expect(entry.thrown, entry.kind + ': ' + entry.input).toBeUndefined();
        expect(entry.result.isError, entry.kind + ': ' + entry.input).toBe(true);
        expect(entry.result.content[0].text, entry.kind + ': ' + entry.input).toContain('Invalid');
      }
      for (const entry of result.valid) {
        expect(entry.isError).not.toBe(true);
        expect(entry.content[0].text).toContain('Native timeline anchor');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
