import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

describe('recent context after worktree adoption', () => {
  let store: SessionStore;
  let server: Server;
  let origin: string;
  const epoch = Date.UTC(2026, 0, 1);

  beforeEach(async () => {
    store = new SessionStore(':memory:');
    const app = express();
    new SearchRoutes(new SearchManager(new SessionSearch(store.db), store, null,
      new FormattingService(), new TimelineService())).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });

  function session(name: string, project: string, order: number, platform = 'claude-code', summary = true) {
    const id = store.createSDKSession(name, project, `ASK_${name}`, undefined, platform);
    const memory = store.ensureMemorySessionIdRegistered(id, `memory-${name}`);
    store.db.run('UPDATE sdk_sessions SET started_at = ?, started_at_epoch = ? WHERE id = ?',
      [new Date(epoch + order).toISOString(), epoch + order, id]);
    store.storeObservation(memory, project, {
      type: 'discovery', title: `OBS_${name}`, subtitle: null, narrative: `Evidence ${name}`,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, epoch + order);
    if (summary) store.storeSummary(memory, project, {
      request: `SUMMARY_${name}`, investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, epoch + order);
    return memory;
  }

  // WorktreeAdoption stamps these two tables and retains sdk_sessions.project.
  function adopt(source: string, destination: string) {
    store.db.run('UPDATE observations SET merged_into_project = ? WHERE project = ?', [destination, source]);
    store.db.run('UPDATE session_summaries SET merged_into_project = ? WHERE project = ?', [destination, source]);
  }

  async function recent(project: string, limit = 10, platform?: string) {
    const query = new URLSearchParams({ project, limit: String(limit) });
    const response = await fetch(`${origin}/api/context/recent?${query}`, {
      headers: platform ? { 'x-platform-source': platform } : {},
    });
    expect(response.status).toBe(200);
    return (await response.json() as { content: Array<{ text: string }> }).content[0].text;
  }

  it('returns a fully adopted worktree when the parent has no local sessions', async () => {
    session('adopted', 'app/finished', 1);
    adopt('app/finished', 'app');
    expect(store.getProjectReadKeys(['app'])).toContain('app/finished');
    expect(await recent('app')).toContain('SUMMARY_adopted');
    expect(store.db.query('SELECT project FROM sdk_sessions').get()).toEqual({ project: 'app/finished' });
  });

  it('selects the newest sessions across local and adopted histories before applying the limit', async () => {
    session('old_local', 'app', 1);
    session('middle_adopted', 'app/finished', 2);
    session('new_local', 'app', 3);
    adopt('app/finished', 'app');
    const text = await recent('app', 2);
    expect(text).toContain('SUMMARY_middle_adopted');
    expect(text).toContain('SUMMARY_new_local');
    expect(text).not.toContain('SUMMARY_old_local');
    expect(text.indexOf('SUMMARY_middle_adopted')).toBeLessThan(text.indexOf('SUMMARY_new_local'));
  });

  it('follows complete merge chains and case variants', async () => {
    session('leaf', 'APP/finished/leaf', 1);
    session('middle', 'APP/finished', 2);
    adopt('APP/finished/leaf', 'app/finished');
    adopt('APP/finished', 'App');
    const text = await recent('aPP');
    expect(text).toContain('SUMMARY_leaf');
    expect(text).toContain('SUMMARY_middle');
  });

  it('applies the platform filter before the shared recent-session limit', async () => {
    session('adopted_cursor', 'app/finished', 1, 'cursor');
    session('new_claude', 'app', 2);
    adopt('app/finished', 'app');
    const text = await recent('app', 1, 'Cursor');
    expect(text).toContain('SUMMARY_adopted_cursor');
    expect(text).not.toContain('SUMMARY_new_claude');
  });

  it('retains in-progress observations from an adopted session without a summary', async () => {
    session('active', 'app/finished', 1, 'claude-code', false);
    adopt('app/finished', 'app');
    const text = await recent('app');
    expect(text).toContain('ASK_active');
    expect(text).toContain('OBS_active');
  });

  it('does not promote a partially adopted source or an unrelated project', async () => {
    session('local', 'app', 1);
    session('unrelated', 'elsewhere', 4);
    session('partial', 'app/unfinished', 3);
    store.db.run('UPDATE observations SET merged_into_project = ? WHERE project = ?', ['app', 'app/unfinished']);
    expect(store.getProjectReadKeys(['app'])).not.toContain('app/unfinished');
    const text = await recent('app');
    expect(text).toContain('SUMMARY_local');
    expect(text).not.toContain('SUMMARY_partial');
    expect(text).not.toContain('SUMMARY_unrelated');
    expect(await recent('app/unfinished')).toContain('SUMMARY_partial');
  });
});
