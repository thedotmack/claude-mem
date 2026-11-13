// Child runner for tests/integrations/aider-sync.test.ts (not a test file).
// Runs the whole scenario in one process so CLAUDE_MEM_DATA_DIR is set
// before any module freezes DATA_DIR/DB_PATH at import: a file-backed store
// seeded with a real session observation, a stub HTTP worker mounting the
// real SearchRoutes + MemoryRoutes, an explicit save over HTTP, then the
// default-fetch `aider sync` a user runs before a session. Prints one JSON
// line to stdout; exits 0 only when the refreshed memory file contains the
// seeded observation's title (inject renders the SessionStart index).
import { Database } from 'bun:sqlite';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { getProjectContext } from '../../src/utils/project-name.js';
import { refreshAiderMemoryFile } from '../../src/services/integrations/AiderInstaller.js';

const projectDir = process.env.AIDER_SYNC_PROJECT_DIR!;
const dataDir = process.env.AIDER_SYNC_DATA_DIR!;
const configPath = path.join(projectDir, '.aider.conf.yml');
const memoryFile = path.join(projectDir, '.claude-mem', 'aider-memory.md');
const project = getProjectContext(projectDir).primary;
const NARRATIVE = 'The project uses SQLite for local persistence.';
const TITLE = 'Local persistence choice';

async function main(): Promise<number> {
  ModeManager.getInstance().loadMode('code');
  const db = new Database(path.join(dataDir, 'claude-mem.db'));
  const store = new SessionStore(db);

  // A real observer-generated observation: a completed-shape session row with
  // a type + concept the code-mode SessionStart compiler accepts. This stands
  // in for what the observer writes after a real agent session; a manual
  // POST /api/memory/save note alone never reaches /api/context/inject (no
  // concepts), so it is saved over HTTP below only to prove the explicit-save
  // path and search — never as the inject seed.
  const sessionDbId = store.createSDKSession('aider-sync-content-1', project, 'What did we decide about local persistence?');
  const memorySessionId = store.ensureMemorySessionIdRegistered(sessionDbId, 'aider-sync-session-1');
  const seeded = store.storeObservation(memorySessionId, project, {
    type: 'decision',
    title: 'Local persistence choice',
    subtitle: null,
    narrative: NARRATIVE,
    facts: ['SQLite chosen for local persistence'],
    concepts: ['trade-off'],
    files_read: [],
    files_modified: [],
  }, 1, 0, Date.now());

  const manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '15.18.3' }));
  app.get('/api/readiness', (_req, res) => res.json({ status: 'ok' }));
  new SearchRoutes(manager).setupRoutes(app);
  const databaseManager = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
  new MemoryRoutes(databaseManager, project).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  // Explicit save through the documented worker API.
  const saved = await fetch(`http://127.0.0.1:${port}/api/memory/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Manual note: the project uses SQLite for local persistence.',
      title: 'Manual persistence note (Aider verification)',
      project,
    }),
  });
  const savedBody = (await saved.json()) as { success?: boolean; id?: number };

  // The refresh a user runs before an Aider session — default fetch path.
  process.env.CLAUDE_MEM_WORKER_PORT = String(port);
  process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  process.env.CLAUDE_MEM_WORKER_AUTOSTART = 'false';
  process.env.CLAUDE_MEM_RUNTIME = 'worker';
  const syncCode = await refreshAiderMemoryFile({ configPath });
  const memoryContent = existsSync(memoryFile) ? readFileSync(memoryFile, 'utf-8') : null;

  // The same memory is searchable from outside Aider.
  const search = await fetch(
    `http://127.0.0.1:${port}/api/search?query=${encodeURIComponent('SQLite local persistence')}`,
  );
  const searchText = await search.text();

  const result = {
    seededId: seeded.id,
    saveOk: saved.ok,
    saveSuccess: savedBody.success === true,
    saveId: savedBody.id ?? null,
    syncCode,
    memoryFileExists: memoryContent !== null,
    memoryContainsTitle: memoryContent?.includes(TITLE) ?? false,
    searchOk: search.ok,
    searchFoundTitle: searchText.includes(TITLE),
  };
  console.log(JSON.stringify(result));
  server.close();
  db.close();
  return result.syncCode === 0 && result.saveSuccess && result.memoryContainsTitle && result.searchFoundTitle ? 0 : 1;
}

process.exit(await main());
