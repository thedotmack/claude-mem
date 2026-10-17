import { Database } from 'bun:sqlite';
import { parentPort } from 'node:worker_threads';
import { DB_PATH } from '../../shared/paths.js';
import { getProjectContext } from '../../utils/project-name.js';
import { ModeManager } from '../domain/ModeManager.js';
import { resolveRuntimeContext } from '../hooks/runtime-selector.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../sqlite/connection.js';
import { projectReadKeys } from '../sqlite/project-read-keys.js';
import { getWorkStateEntries, scopeWorkStateEntries } from '../sqlite/work-state.js';
import { countObservationsByProjects } from './ObservationCompiler.js';
import { generateContextWithStats } from './ContextBuilder.js';
import type { ContextReadReply, ContextReadRequest } from './ContextReadProtocol.js';

if (!parentPort) throw new Error('Context reader requires a worker thread');
const port = parentPort;

function readDatabase<T>(read: (db: Database) => T): T {
  const db = new Database(DB_PATH, { readonly: true, create: false });
  try {
    db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.run('PRAGMA query_only = ON');
    return read(db);
  } finally {
    db.close();
  }
}

async function execute(request: ContextReadRequest): Promise<unknown> {
  switch (request.method) {
    case 'render':
      if (resolveRuntimeContext().runtime !== 'worker') throw new Error('Context render reader only supports local SQLite');
      ModeManager.getInstance().useModeSnapshot(request.input.mode);
      return generateContextWithStats(request.input.context, request.input.forHuman, { config: request.input.config });
    case 'readKeys':
      return readDatabase(db => projectReadKeys(db, request.input.projects));
    case 'workState':
      return readDatabase(db => scopeWorkStateEntries(
        getWorkStateEntries(db, projectReadKeys(db, request.input.projects), undefined, request.input.localDeviceId),
        request.input.projects,
      ));
    case 'hasObservations':
      return readDatabase(db => countObservationsByProjects({ db }, request.input.projects, request.input.platformSource) > 0);
    case 'projectsForCwd':
      return getProjectContext(request.input.cwd).allProjects;
  }
}

port.on('message', async (request: ContextReadRequest) => {
  try {
    const result = await execute(request);
    port.postMessage({ id: request.id, ok: true, result } satisfies ContextReadReply);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    port.postMessage({ id: request.id, ok: false, error: { name: failure.name, message: failure.message } } satisfies ContextReadReply);
  }
});
