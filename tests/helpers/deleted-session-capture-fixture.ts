import { spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { setSessionInitDependenciesForTesting } from '../../src/cli/handlers/session-init.js';
import { logger } from '../../src/utils/logger.js';

/** The viewer's DELETE (DataRoutes.handleDeleteSession): rows go, the tombstone stays. */
export function deleteSessionLikeTheViewer(store: SessionStore, platformSource: string, contentSessionId: string): void {
  const row = store.db.prepare(
    'SELECT id, memory_session_id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ?'
  ).get(platformSource, contentSessionId) as { id: number; memory_session_id: string | null };
  store.db.transaction(() => {
    store.db.prepare('DELETE FROM user_prompts WHERE session_db_id = ?').run(row.id);
    store.db.prepare('DELETE FROM tool_uses WHERE session_db_id = ? OR (content_session_id = ? AND platform_source = ?)')
      .run(row.id, contentSessionId, platformSource);
    store.db.prepare('DELETE FROM committed_observation_tool_uses WHERE content_session_id = ? AND platform_source = ?')
      .run(contentSessionId, platformSource);
    store.markSessionDeleted(platformSource, contentSessionId, row.memory_session_id);
    store.db.prepare('DELETE FROM sdk_sessions WHERE id = ?').run(row.id);
  }).immediate();
}

/**
 * A real capture worker: SessionStore, SessionManager and SessionRoutes over
 * HTTP, the shared ingest context, and the real session-init hook handler
 * pointed at it. Only the generator start is stubbed, and recorded: it is the
 * only way queued work reaches the paid provider.
 */
export async function startCaptureWorker() {
  const infoLog = spyOn(logger, 'info').mockImplementation(() => {});
  const quietLogs = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
  const store = new SessionStore(new Database(':memory:'), { syncOpsEnabled: false });
  const dbManager = {
    getSessionStore: () => store,
    getSessionById: (id: number) => store.getSessionById(id),
    getCloudSync: () => undefined,
    getChromaSync: () => undefined,
  };
  const manager = new SessionManager(dbManager as any);
  const queuedToolUseIds: string[] = [];
  const queueObservation = manager.queueObservation.bind(manager);
  manager.queueObservation = ((sessionDbId: number, message: { toolUseId?: string }, ...rest: unknown[]) => {
    if (message.toolUseId) queuedToolUseIds.push(message.toolUseId);
    return (queueObservation as any)(sessionDbId, message, ...rest);
  }) as typeof manager.queueObservation;
  const broadcaster = {
    broadcastNewPrompt() {}, broadcastSessionStarted() {},
    broadcastObservationQueued() {}, broadcastSummarizeQueued() {},
  };
  const routes = new SessionRoutes(manager, dbManager as any,
    {} as any, {} as any, {} as any, broadcaster as any, {} as any, {} as any);
  const generatorStarts: string[] = [];
  routes.ensureGeneratorRunning = async (_id, source) => { generatorStarts.push(source); };
  setIngestContext({
    sessionManager: manager, dbManager: dbManager as any, eventBroadcaster: broadcaster as any,
    ensureGeneratorRunning: (id, source) => routes.ensureGeneratorRunning(id, source),
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const request = async (apiPath: string, method: string, body: unknown) => (await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json() as Promise<any>;

  setSessionInitDependenciesForTesting({
    loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false', CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5' }) as any,
    resolveRuntimeContext: () => ({ runtime: 'worker' }),
    shouldTrackProject: () => true,
    getSessionInitRequestTimeoutMs: () => 10_000,
    executeWithWorkerFallback: request as any,
    isWorkerFallback: (() => false) as any,
    consumeWorkerOutageNotice: async () => null,
  });

  const rowsFor = <T>(sql: string, contentSessionId: string) => store.db.prepare(sql).all(contentSessionId) as T[];
  return {
    store,
    generatorStarts,
    queuedToolUseIds,
    post: (route: string, body: object) => request(`/api/sessions/${route}`, 'POST', body),
    sessionRows: (contentSessionId: string) =>
      rowsFor<{ id: number; platform_source: string }>('SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?', contentSessionId),
    toolUseIds: (contentSessionId: string) =>
      rowsFor<{ tool_use_id: string }>('SELECT tool_use_id FROM tool_uses WHERE content_session_id = ? ORDER BY id', contentSessionId)
        .map(row => row.tool_use_id),
    promptTexts: (contentSessionId: string) =>
      rowsFor<{ prompt_text: string }>('SELECT prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY id', contentSessionId)
        .map(row => row.prompt_text),
    /** Info log lines for skips because of deletion (the reason is always logged). */
    deletionSkipsLogged: () => infoLog.mock.calls.filter(call =>
      String(call[1]).includes('its session was deleted') && (call[2] as { reason?: string })?.reason === 'session_deleted'),
    close: async () => {
      setSessionInitDependenciesForTesting();
      infoLog.mockRestore();
      quietLogs.forEach(spy => spy.mockRestore());
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}

export type CaptureWorker = Awaited<ReturnType<typeof startCaptureWorker>>;
