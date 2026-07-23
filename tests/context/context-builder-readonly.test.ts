import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const childScript = `
  import { Database } from 'bun:sqlite';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContext } from './src/services/context/ContextBuilder.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const dbPath = process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db';
  if (process.env.READONLY_CASE === 'missing') {
    const text = await generateContext({ projects: ['readonly-parent'] });
    console.log(JSON.stringify({ text, exists: await Bun.file(dbPath).exists() }));
    process.exit(0);
  }

  const store = new SessionStore(dbPath);
  const parentSession = store.createSDKSession('native-content', 'readonly-parent', 'native prompt');
  store.ensureMemorySessionIdRegistered(parentSession, 'native-memory');
  store.storeObservation('native-memory', 'readonly-parent', {
    type: 'discovery', title: 'NATIVE_READONLY_RECORD', subtitle: null,
    facts: [], narrative: 'native narrative', concepts: ['how-it-works'],
    files_read: [], files_modified: [],
  }, 1, 0, 1_700_000_000_000);
  const adoptedSession = store.createSDKSession('adopted-content', 'readonly-child', 'adopted prompt');
  store.ensureMemorySessionIdRegistered(adoptedSession, 'adopted-memory');
  store.storeObservation('adopted-memory', 'readonly-child', {
    type: 'discovery', title: 'ADOPTED_READONLY_RECORD', subtitle: null,
    facts: [], narrative: 'adopted narrative', concepts: ['how-it-works'],
    files_read: [], files_modified: [],
  }, 1, 0, 1_700_000_000_001);
  store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE title = ?').run('readonly-parent', 'ADOPTED_READONLY_RECORD');
  if (process.env.READONLY_CASE === 'exclusive-lock') {
    store.db.run('PRAGMA journal_mode = DELETE');
  }
  store.close();

  if (process.env.READONLY_CASE === 'exclusive-lock') {
    const lockReadyPath = process.env.LOCK_READY ?? dbPath + '.lock-ready';
    const lockHolder = Bun.spawn(['bun', '-e', \`
      import { Database } from 'bun:sqlite';
      const db = new Database(process.env.LOCK_DB!);
      db.run('BEGIN EXCLUSIVE');
      const readyPath = process.env.LOCK_READY ?? process.env.LOCK_DB + '.lock-ready';
      await Bun.write(readyPath, 'ready');
      await Bun.sleep(350);
      db.run('ROLLBACK');
      db.close();
    \`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOCK_DB: dbPath,
        LOCK_READY: lockReadyPath,
      },
    });
    while (!(await Bun.file(lockReadyPath).exists())) await Bun.sleep(10);
    const startedAt = performance.now();
    const text = await generateContext({ projects: ['readonly-parent'] });
    const elapsedMs = performance.now() - startedAt;
    await lockHolder.exited;
    console.log(JSON.stringify({ text, elapsedMs }));
    process.exit(0);
  }

  const writer = new Database(dbPath);
  const before = {
    schema: (writer.prepare('SELECT COUNT(*) as count FROM schema_versions').get() as { count: number }).count,
    observations: (writer.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count,
    summaries: (writer.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number }).count,
  };
  writer.run('BEGIN IMMEDIATE');
  writer.prepare(
    'INSERT INTO observations ('
      + 'memory_session_id, project, text, type, title, subtitle, facts, narrative, '
      + 'concepts, files_read, files_modified, prompt_number, discovery_tokens, '
      + 'created_at, created_at_epoch'
      + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'native-memory',
    'readonly-parent',
    'uncommitted text',
    'discovery',
    'UNCOMMITTED_READONLY_RECORD',
    null,
    '[]',
    'uncommitted narrative',
    '["how-it-works"]',
    '[]',
    '[]',
    1,
    0,
    '2023-11-14T22:13:22.000Z',
    1_700_000_002_000,
  );
  const writerPending = (writer.prepare('SELECT COUNT(*) as count FROM observations WHERE title = ?').get('UNCOMMITTED_READONLY_RECORD') as { count: number }).count;
  const text = await generateContext({ projects: ['readonly-parent'] });
  const committedReader = new Database(dbPath, { readonly: true, create: false });
  const visible = {
    schema: (committedReader.prepare('SELECT COUNT(*) as count FROM schema_versions').get() as { count: number }).count,
    observations: (committedReader.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count,
    summaries: (committedReader.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number }).count,
    pendingRows: (committedReader.prepare('SELECT COUNT(*) as count FROM observations WHERE title = ?').get('UNCOMMITTED_READONLY_RECORD') as { count: number }).count,
  };
  committedReader.close();
  writer.run('ROLLBACK');
  const after = {
    schema: (writer.prepare('SELECT COUNT(*) as count FROM schema_versions').get() as { count: number }).count,
    observations: (writer.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count,
    summaries: (writer.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number }).count,
  };
  const integrity = (writer.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  writer.close();
  console.log(JSON.stringify({ text, before, writerPending, visible, after, integrity }));
`;

function runChild(dataDir: string, extraEnv: Record<string, string>): Record<string, any> {
  const result = Bun.spawnSync(['bun', '-e', childScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      CLAUDE_MEM_MODES_DIR: join(repoRoot, 'plugin', 'modes'),
      ...extraEnv,
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout).trim());
}

describe('context database ownership', () => {
  it('does not create a database for an absent context store', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-context-'));
    try {
      const result = runChild(dataDir, { READONLY_CASE: 'missing' });
      expect(result.text).toBe('');
      expect(result.exists).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reads committed native and adopted records without changing database state', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-context-'));
    try {
      const result = runChild(dataDir, {});
      expect(result.text).toContain('NATIVE_READONLY_RECORD');
      expect(result.text).toContain('ADOPTED_READONLY_RECORD');
      expect(result.text).not.toContain('UNCOMMITTED_READONLY_RECORD');
      expect(result.writerPending).toBe(1);
      expect(result.visible).toEqual({ ...result.before, pendingRows: 0 });
      expect(result.after).toEqual(result.before);
      expect(result.integrity).toBe('ok');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('waits through a temporary exclusive lock on the read-only connection', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-context-'));
    try {
      const readyPath = join(dataDir, 'lock-ready');
      const result = runChild(dataDir, { READONLY_CASE: 'exclusive-lock', LOCK_READY: readyPath });
      expect(result.text).toContain('NATIVE_READONLY_RECORD');
      expect(result.elapsedMs).toBeGreaterThan(250);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps SessionStore responsible for fresh database schema creation', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-context-'));
    try {
      const result = runChild(dataDir, { READONLY_CASE: 'missing' });
      expect(result.exists).toBe(false);
      const workerResult = Bun.spawnSync(['bun', '-e', `
        import { SessionStore } from './src/services/sqlite/SessionStore.ts';
        const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
        console.log(JSON.stringify({ versions: (store.db.prepare('SELECT COUNT(*) as count FROM schema_versions').get() as { count: number }).count }));
        store.close();
      `], {
        cwd: repoRoot,
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
      });
      expect(workerResult.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(workerResult.stdout).trim()).versions).toBeGreaterThan(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
