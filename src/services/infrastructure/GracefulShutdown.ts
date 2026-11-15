
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
  stop(): Promise<void>;
}

/**
 * Child commands the worker sent their stop to as its shutdown began, such as My Work's turns and opens
 * (ConversationContinuationRunner, stopped by WorkViewRoutes.close in WorkerService.shutdown's first step).
 */
export interface StoppedChildCommands {
  /** Resolves once every one of them has exited. */
  waitUntilEveryCommandHasExited(): Promise<void>;
}

export interface GracefulShutdownConfig {
  server: http.Server | null;
  /**
   * Waited for right after the HTTP server closes, before the session drain and the other long steps. A turn then has
   * all of the graceful-shutdown deadline (runShutdownSequence) to end on the stop it was sent, which ends a Claude Code
   * turn cleanly (SIGINT), before the supervisor's cascade below would send it SIGTERM. What has not exited when the
   * deadline runs out is force-stopped before the worker exits (runShutdownSequence's forceStopCommandsStillRunning).
   */
  commandsStoppedAsShutdownBegan?: StoppedChildCommands;
  sessionManager: ShutdownableService;
  mcpClient?: CloseableClient;
  contextReader?: CloseableClient;
  dbManager?: CloseableDatabase;
  chromaMcpManager?: StoppableService;
}

export async function performGracefulShutdown(config: GracefulShutdownConfig): Promise<void> {
  logger.info('SYSTEM', 'Shutdown initiated');

  const errors: unknown[] = [];
  const details: string[] = [];
  async function cleanup(stage: string, action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) {
      errors.push(error);
      details.push(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.server) {
    await closeHttpServer(config.server);
    logger.info('SYSTEM', 'HTTP server closed');
  }

  if (config.commandsStoppedAsShutdownBegan) {
    await cleanup('stopped commands', async () => {
      await config.commandsStoppedAsShutdownBegan!.waitUntilEveryCommandHasExited();
      logger.info('SYSTEM', 'Every command stopped as the shutdown began has exited');
    });
  }

  await cleanup('sessions', () => config.sessionManager.shutdownAll());

  if (config.mcpClient) {
    await cleanup('MCP', async () => {
      await config.mcpClient!.close();
      logger.info('SYSTEM', 'MCP client closed');
    });
  }

  if (config.chromaMcpManager) {
    await cleanup('Chroma', async () => {
      logger.info('SHUTDOWN', 'Stopping Chroma MCP connection...');
      await config.chromaMcpManager!.stop();
      logger.info('SHUTDOWN', 'Chroma MCP connection stopped');
    });
  }

  if (config.contextReader) {
    await cleanup('context reader', () => config.contextReader!.close());
  }

  if (config.dbManager) {
    await cleanup('database', () => config.dbManager!.close());
  }

  await cleanup('supervisor', () => getSupervisor().stop());

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Worker shutdown cleanup failed: ${details.join('; ')}`);

  logger.info('SYSTEM', 'Worker shutdown complete');
}

async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Close the listener before sweeping active connections. Reconnecting
    // streams must not enter between the sweep and close().
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
    server.closeAllConnections();
  });

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }
}
