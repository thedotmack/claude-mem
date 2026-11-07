// #2864 / #2967: the adoption sweep needs to know which directories this
// install actually works in. cwd arrives on every observation ingest but was
// never persisted after the pending_messages queue was removed (61fe70a2,
// v13.10.0), leaving the sweep with no repos to scan. Ingest now stamps it on
// the session row.
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;
let store: SessionStore | undefined;

afterEach(() => {
  try { store?.close(); } catch {}
  store = undefined;
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function wireIngest(sessionStore: SessionStore): void {
  setIngestContext({
    sessionManager: { queueObservation: async () => {} } as never,
    dbManager: { getSessionStore: () => sessionStore } as never,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as never,
  });
}

describe('ingest persists session cwd (#2864)', () => {
  it('stamps the ingest cwd onto the session row', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-ingest-'));
    const dataDirectory = path.join(tempRoot, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    const result = await ingestObservation({
      contentSessionId: 'content-cwd-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: '' },
      cwd: tempRoot,
    });

    expect(result.ok).toBe(true);
    const row = store.db.prepare(
      'SELECT cwd FROM sdk_sessions WHERE content_session_id = ?'
    ).get('content-cwd-1') as { cwd: string | null };
    expect(row.cwd).toBe(tempRoot);
  });

  it('keeps the launch cwd when a later observation arrives from a subdirectory', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-ingest-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const subdir = path.join(tempRoot, 'packages', 'api');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(subdir, { recursive: true });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    await ingestObservation({
      contentSessionId: 'content-cwd-2',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: '' },
      cwd: tempRoot,
    });
    await ingestObservation({
      contentSessionId: 'content-cwd-2',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: '' },
      cwd: subdir,
    });

    const row = store.db.prepare(
      'SELECT cwd FROM sdk_sessions WHERE content_session_id = ?'
    ).get('content-cwd-2') as { cwd: string | null };
    expect(row.cwd).toBe(tempRoot);
  });

  // Gate P1-2: worktree adoption trusts a deleted checkout only for a
  // folder-derived key, so the checkout is recorded with how its key was derived.
  it('records how the project key was derived with the checkout', async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-2864-ingest-'));
    const dataDirectory = path.join(tempRoot, 'data');
    const folderProject = path.join(tempRoot, 'plain-folder');
    const slugRepo = path.join(tempRoot, 'api');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(folderProject, { recursive: true });
    mkdirSync(slugRepo, { recursive: true });
    execFileSync('git', ['init', '-q', slugRepo], { stdio: 'ignore' });
    execFileSync('git', ['-C', slugRepo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'], { stdio: 'ignore' });
    store = new SessionStore(path.join(dataDirectory, 'claude-mem.db'));
    wireIngest(store);

    const savedNameSource = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
    try {
      for (const [contentSessionId, cwd] of [['content-folder', folderProject], ['content-slug', slugRepo]]) {
        await ingestObservation({
          contentSessionId,
          toolName: 'Bash',
          toolInput: { command: 'ls' },
          toolResponse: { stdout: '' },
          cwd,
        });
      }
    } finally {
      if (savedNameSource === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
      else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = savedNameSource;
    }

    const sources = store.db.prepare(
      'SELECT content_session_id, project, project_key_source FROM sdk_sessions ORDER BY content_session_id'
    ).all();
    expect(sources).toEqual([
      { content_session_id: 'content-folder', project: 'plain-folder', project_key_source: 'path' },
      { content_session_id: 'content-slug', project: 'acme/api', project_key_source: 'git-remote' },
    ]);
  });
});
