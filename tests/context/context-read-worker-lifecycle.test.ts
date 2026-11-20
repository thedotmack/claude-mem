import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runScenario(script: string): any {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-reader-lifecycle-'));
  const db = new Database(join(directory, 'claude-mem.db'));
  db.exec(`
    CREATE TABLE sdk_sessions(project TEXT);
    CREATE TABLE observations(project TEXT, merged_into_project TEXT);
    CREATE TABLE session_summaries(project TEXT, merged_into_project TEXT);
    INSERT INTO sdk_sessions VALUES ('APP');
    INSERT INTO observations VALUES ('legacy', 'app');
  `);
  db.close();
  try {
    const result = Bun.spawnSync([process.execPath, '-e', `
      import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
      import { existsSync, unlinkSync } from 'node:fs';
      const reader = new ContextReadWorkerClient();
      try { ${script} } finally { await reader.close(); }
    `], {
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_CONFIG_DIR: directory, CLAUDE_MEM_TELEMETRY_ENABLED: 'false' },
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('context reader resource ownership', () => {
  it('bounds a burst to 64 pending reads without changing successful alias results', () => {
    const result = runScenario(`
      const initial = await reader.readKeys(['app']);
      const burst = await Promise.allSettled(Array.from({ length: 65 }, () => reader.readKeys(['app'])));
      console.log(JSON.stringify({
        initial,
        fulfilled: burst.filter(result => result.status === 'fulfilled').map(result => result.value),
        rejected: burst.filter(result => result.status === 'rejected').map(result => result.reason.message),
      }));
    `);
    expect(result.initial).toEqual(['app', 'APP', 'legacy']);
    expect(result.fulfilled).toHaveLength(64);
    expect(result.fulfilled.every((keys: string[]) => JSON.stringify(keys) === JSON.stringify(['app', 'APP', 'legacy']))).toBe(true);
    expect(result.rejected).toEqual(['Context reader queue is full']);
  }, 20_000);

  it('rejects reads after close and does not create a missing database', () => {
    const result = runScenario(`
      const initial = await reader.readKeys(['app']);
      await reader.close();
      const closed = await reader.readKeys(['app']).then(() => null, error => error.message);
      const path = process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db';
      unlinkSync(path);
      const missingReader = new ContextReadWorkerClient();
      try {
        const missing = await missingReader.readKeys(['app']).then(() => null, error => error.message);
        console.log(JSON.stringify({ initial, closed, missing, created: existsSync(path) }));
      } finally { await missingReader.close(); }
    `);
    expect(result.initial).toEqual(['app', 'APP', 'legacy']);
    expect(result.closed).toBe('Context reader closed');
    expect(result.missing).toMatch(/open|file|database/i);
    expect(result.created).toBe(false);
  }, 20_000);
});
