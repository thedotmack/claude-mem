/**
 * Standalone proxy entry point — runs independently of worker-service.
 *
 * This is built as a separate bundle (proxy-service.cjs) to avoid loading
 * the full worker stack (DB, Chroma, MCP, etc.) which can interfere with
 * Bun's networking on some macOS machines.
 *
 * Usage: bun proxy-service.cjs --daemon
 */

import path from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getNodeName, getNetworkMode } from '../../shared/node-identity.js';
import { writePidFile, readPidFile, removePidFile, isProcessAlive } from '../infrastructure/ProcessManager.js';
import { logger } from '../../utils/logger.js';
import { ProxyServer } from './ProxyServer.js';

async function main() {
  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT || '37777', 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    logger.error('PROXY', 'Invalid CLAUDE_MEM_WORKER_PORT — must be 1024-65535', { raw: settings.CLAUDE_MEM_WORKER_PORT });
    process.exit(1);
  }

  const mode = getNetworkMode();
  if (mode !== 'client') {
    logger.error('PROXY', 'proxy-service can only run in client mode, current mode: ' + mode);
    process.exit(1);
  }

  const serverHost = settings.CLAUDE_MEM_SERVER_HOST;
  if (!serverHost) {
    logger.error('PROXY', 'CLAUDE_MEM_SERVER_HOST required in settings.json');
    process.exit(1);
  }

  // Guard: don't start if already running
  const existing = readPidFile();
  if (existing && isProcessAlive(existing.pid)) {
    logger.info('PROXY', 'Proxy already running', { pid: existing.pid });
    process.exit(0);
  }

  const serverPort = parseInt(settings.CLAUDE_MEM_SERVER_PORT || '37777', 10);
  if (isNaN(serverPort) || serverPort < 1024 || serverPort > 65535) {
    logger.error('PROXY', 'Invalid CLAUDE_MEM_SERVER_PORT — must be 1024-65535', { raw: settings.CLAUDE_MEM_SERVER_PORT });
    process.exit(1);
  }
  const authToken = settings.CLAUDE_MEM_AUTH_TOKEN || '';
  if (!authToken) {
    logger.error('PROXY', 'CLAUDE_MEM_AUTH_TOKEN not set — client mode requires an auth token');
    process.exit(1);
  }
  const dataDir = settings.CLAUDE_MEM_DATA_DIR || SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');

  process.on('unhandledRejection', (reason) => {
    logger.error('PROXY', 'Unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  let proxyRef: ProxyServer | null = null;
process.on('SIGTERM', async () => { if (proxyRef) await proxyRef.stop(); removePidFile(); process.exit(0); });
  process.on('SIGINT', async () => { if (proxyRef) await proxyRef.stop(); removePidFile(); process.exit(0); });

  const proxy = new ProxyServer(serverHost, serverPort, authToken, dataDir);
  proxyRef = proxy;
  await proxy.start(port);
  writePidFile({ pid: process.pid, port, startedAt: new Date().toISOString() });
  logger.info('PROXY', 'Standalone proxy started', {
    node: getNodeName(),
    target: `${serverHost}:${serverPort}`,
    port
  });
}

main().catch((error) => {
  logger.error('PROXY', 'Proxy failed to start', {}, error as Error);
  removePidFile();
  process.exit(1);
});
