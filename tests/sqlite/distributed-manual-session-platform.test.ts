import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const shippedSessionStore = path.resolve(__dirname, '../../plugin/sqlite/SessionStore.js');

describe('distributed SessionStore manual session platform identity', () => {
  it('keeps Cursor and Codex manual saves as separate sessions in the shipped worker module', () => {
    // Load the distributed CJS module in a child so bun:sqlite + createRequire
    // cannot poison this process's `net` / `process.platform` spies.
    const script = `
      const { SessionStore } = require(${JSON.stringify(shippedSessionStore)});
      const store = new SessionStore(':memory:');
      const project = 'shared-project';
      const cursorSession = store.getOrCreateManualSession(project, 'cursor');
      const codexSession = store.getOrCreateManualSession(project, 'codex');
      const reused = store.getOrCreateManualSession(project, 'cursor');
      const rows = store.db.prepare(
        'SELECT memory_session_id, platform_source FROM sdk_sessions ORDER BY platform_source',
      ).all();
      store.close();
      process.stdout.write(JSON.stringify({ cursorSession, codexSession, reused, rows }));
    `;

    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as {
      cursorSession: string;
      codexSession: string;
      reused: string;
      rows: Array<{ memory_session_id: string; platform_source: string }>;
    };

    expect(payload.cursorSession).toBe('manual-shared-project-cursor');
    expect(payload.codexSession).toBe('manual-shared-project-codex');
    expect(payload.codexSession).not.toBe(payload.cursorSession);
    expect(payload.reused).toBe(payload.cursorSession);
    expect(payload.rows).toEqual([
      { memory_session_id: 'manual-shared-project-codex', platform_source: 'codex' },
      { memory_session_id: 'manual-shared-project-cursor', platform_source: 'cursor' },
    ]);
  });
});
