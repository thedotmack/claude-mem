import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();

/**
 * #4559: generateContextWithStats renders through a throwaway read-only
 * connection and closes it in a finally block. Every statement the render
 * prepares on that connection must be finalized before the close, or SQLite
 * defers the close and logs invalid-connection-pointer errors. Local Bun
 * tolerates the leak silently, so this test tracks statement lifecycles
 * directly: it instruments Database.prepare / Statement.finalize in a child
 * process, renders context from a seeded store, and reports how many SELECT
 * statements were created during the render and how many were never
 * finalized.
 */
const childScript = `
  import { Database, Statement } from 'bun:sqlite';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContext } from './src/services/context/ContextBuilder.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const dbPath = process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db';

  const store = new SessionStore(dbPath);
  const session = store.createSDKSession('finalize-content', 'finalize-parent', 'prompt');
  store.ensureMemorySessionIdRegistered(session, 'finalize-memory');
  store.storeObservation('finalize-memory', 'finalize-parent', {
    type: 'discovery', title: 'FINALIZE_PROBE_RECORD', subtitle: null,
    facts: [], narrative: 'finalize narrative', concepts: ['how-it-works'],
    files_read: [], files_modified: [],
  }, 1, 0, 1_700_000_000_000);
  store.close();

  const tracked = new Map();
  let unfinalizedAtClose = 0;
  const originalPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function (...args) {
    const statement = originalPrepare.apply(this, args);
    if (typeof args[0] === 'string' && args[0].includes('SELECT')) {
      tracked.set(statement, false);
    }
    return statement;
  };
  const originalFinalize = Statement.prototype.finalize;
  Statement.prototype.finalize = function () {
    if (tracked.has(this)) tracked.set(this, true);
    return originalFinalize.call(this);
  };
  // Finalizing after close() is the bug, not a fix: snapshot how many tracked
  // statements are still open at the moment any connection closes.
  const originalClose = Database.prototype.close;
  Database.prototype.close = function (...args) {
    unfinalizedAtClose += [...tracked.values()].filter(done => !done).length;
    return originalClose.apply(this, args);
  };

  const text = await generateContext({ projects: ['finalize-parent'] });
  const leaked = [...tracked.values()].filter(done => !done).length;
  console.log(JSON.stringify({
    created: tracked.size,
    leaked,
    unfinalizedAtClose,
    hasRecord: text.includes('FINALIZE_PROBE_RECORD'),
  }));
`;

function runChild(dataDir: string) {
  // The render must not depend on the caller's context settings: an
  // inherited CLAUDE_MEM_CONTEXT_OBSERVATIONS=0 would hide the seeded record
  // even though statement cleanup is fine.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_MEM_CONTEXT_')) delete env[key];
  }
  const result = Bun.spawnSync(['bun', '-e', childScript], {
    cwd: repoRoot,
    env: {
      ...env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_MODES_DIR: join(repoRoot, 'plugin', 'modes'),
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  const lines = new TextDecoder().decode(result.stdout).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as { created: number; leaked: number; unfinalizedAtClose: number; hasRecord: boolean };
}

describe('context builder statement lifecycle (#4559)', () => {
  it('finalizes every statement the render prepares before closing its read-only connection', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-finalize-'));
    try {
      const outcome = runChild(dataDir);
      expect(outcome.hasRecord).toBe(true);
      // projectReadKeys + observations + summaries each prepare at least one.
      expect(outcome.created).toBeGreaterThanOrEqual(3);
      expect(outcome.leaked).toBe(0);
      // And every one of them was finalized before the connection closed,
      // not merely by the time the render returned.
      expect(outcome.unfinalizedAtClose).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
