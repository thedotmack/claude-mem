
import http from 'http';
import { logger } from '../../utils/logger.js';
import { getSupervisor } from '../../supervisor/index.js';

export interface ShutdownableService {
  shutdownAll(): Promise<void>;
}

export interface CloseableClient {
  close(): Promise<void>;
}

export interface CloseableDatabase {
  close(): Promise<void>;
}

export interface StoppableService {
  /**
   * `terminal` marks this as a process-exit teardown: the service must not
   * rebuild itself afterwards. ChromaMcpManager uses it to stop its
   * transport-error retry from spawning a replacement subprocess tree that the
   * imminent process.exit() would orphan.
   */
  stop(options?: { terminal?: boolean }): Promise<void>;
}

export interface GracefulShutdownConfig {
  server: http.Server | null;
  sessionManager: ShutdownableService;
  mcpClient?: CloseableClient;
  dbManager?: CloseableDatabase;
  chromaMcpManager?: StoppableService;
  /**
   * Restart only: skip the supervisor cascade here and leave it to
   * runShutdownSequence, which runs it AFTER the successor handoff.
   *
   * This sequence runs under a hard deadline that does not cancel it — on
   * expiry the caller proceeds while this promise keeps going. Reaching
   * getSupervisor().stop() at any point around that boundary sets stopPromise,
   * and assertCanSpawn() then refuses the successor spawn, turning a restart
   * into a worker that never comes back. Deferring makes that unreachable by
   * construction rather than by timing: on a restart this function never takes
   * the spawn gate, whether it finishes early, late, or is abandoned mid-drain.
   */
  deferSupervisorStop?: boolean;
}

export async function performGracefulShutdown(config: GracefulShutdownConfig): Promise<void> {
  logger.info('SYSTEM', 'Shutdown initiated');

  if (config.server) {
    await closeHttpServer(config.server);
    logger.info('SYSTEM', 'HTTP server closed');
  }

  await config.sessionManager.shutdownAll();

  if (config.mcpClient) {
    await config.mcpClient.close();
    logger.info('SYSTEM', 'MCP client closed');
  }

  if (config.chromaMcpManager) {
    logger.info('SHUTDOWN', 'Stopping Chroma MCP connection...');
    await config.chromaMcpManager.stop({ terminal: true });
    logger.info('SHUTDOWN', 'Chroma MCP connection stopped');
  }

  if (config.dbManager) {
    await config.dbManager.close();
  }

  if (!config.deferSupervisorStop) {
    await getSupervisor().stop();
  }

  logger.info('SYSTEM', 'Worker shutdown complete');
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
  }

  await new Promise<void>((resolve, reject) => {
    server.close(err => {
      if (!err) {
        resolve();
        return;
      }
      // #3380 — Node's http.Server.close(cb) reports ERR_SERVER_NOT_RUNNING
      // when the handle is not listening (e.g. the bind failed or the server
      // already closed). Closing an already-closed server is the desired end
      // state, not a failure: rejecting here aborted ALL remaining teardown
      // (session drain, MCP close, chroma stop, db close, supervisor stop).
      // Same tolerance as ServerService.stop() in
      // src/server/runtime/ServerService.ts.
      if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        logger.warn('SYSTEM', 'Server was already stopped when close was requested', {}, err);
        resolve();
        return;
      }
      reject(err);
    });
  });

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }
}
