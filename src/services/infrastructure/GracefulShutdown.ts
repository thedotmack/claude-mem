
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

export interface GracefulShutdownConfig {
  server: http.Server | null;
  sessionManager: ShutdownableService;
  mcpClient?: CloseableClient;
  dbManager?: CloseableDatabase;
  chromaMcpManager?: StoppableService;
}

export async function performGracefulShutdown(config: GracefulShutdownConfig): Promise<void> {
  logger.info('SYSTEM', 'Shutdown initiated');

  if (config.server) {
    await closeHttpServer(config.server);
    logger.info('SYSTEM', 'HTTP server closed');
  }

  // Stop the shared Chroma subprocess before draining observer sessions.
  // Session shutdown can spend 5s per Claude SDK process and exceed the
  // worker's global graceful-shutdown deadline. If Chroma is stopped after
  // that drain, the dying worker can exit first and re-parent uv/python to
  // launchd, leaking one Chroma tree on every restart.
  if (config.chromaMcpManager) {
    logger.info('SHUTDOWN', 'Stopping Chroma MCP connection...');
    await config.chromaMcpManager.stop();
    logger.info('SHUTDOWN', 'Chroma MCP connection stopped');
  }

  await config.sessionManager.shutdownAll();

  if (config.mcpClient) {
    await config.mcpClient.close();
    logger.info('SYSTEM', 'MCP client closed');
  }

  if (config.dbManager) {
    await config.dbManager.close();
  }

  await getSupervisor().stop();

  logger.info('SYSTEM', 'Worker shutdown complete');
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
  }

  await new Promise<void>((resolve, reject) => {
    server.close(err => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (!err || code === 'ERR_SERVER_NOT_RUNNING') {
        if (code === 'ERR_SERVER_NOT_RUNNING') {
          logger.debug('SYSTEM', 'HTTP server was already closed during shutdown');
        }
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
