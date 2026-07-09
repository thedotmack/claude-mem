
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
  const closeResult = new Promise<'closed' | 'error'>((resolve, reject) => {
    server.close(err => {
      if (err) {
        reject(err);
        return;
      }
      resolve('closed');
    });
  });

  // Stop accepting first, then close existing sockets. This ordering avoids a
  // Windows/Bun race where force-exiting after a stuck close can leave a dead
  // PID holding the LISTEN socket.
  await new Promise(r => setTimeout(r, 50));
  server.closeIdleConnections?.();
  server.closeAllConnections();

  const deadlineMs = process.platform === 'win32' ? 3000 : 1000;
  const outcome = await Promise.race([
    closeResult,
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), deadlineMs)),
  ]);

  if (outcome === 'timeout') {
    server.closeAllConnections();
    logger.warn('SYSTEM', 'HTTP server close timed out after listener close; proceeding with shutdown', {
      deadlineMs,
    });
    return;
  }

  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }
}
