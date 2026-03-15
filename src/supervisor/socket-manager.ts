/**
 * Socket Manager - Unix Domain Socket support for worker communication
 *
 * Eliminates port 37777 collisions across concurrent sessions (#1346) by
 * defaulting to Unix domain sockets. Falls back to TCP for environments
 * where UDS isn't available (e.g., older Windows builds).
 *
 * Discovery order:
 *   1. Check settings for workerTransport override ("tcp" forces TCP)
 *   2. Check platform support for AF_UNIX
 *   3. Default to "socket" on supported platforms
 */

import { existsSync, mkdirSync, unlinkSync, chmodSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import net from 'net';
import { logger } from '../utils/logger.js';
import { isPidAlive } from './process-registry.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const SOCKETS_DIR = path.join(DATA_DIR, 'sockets');
const WORKER_SOCKET_FILENAME = 'worker.sock';

export type WorkerAddressType = 'socket' | 'tcp';

export interface SocketAddress {
  type: 'socket';
  socketPath: string;
}

export interface TcpAddress {
  type: 'tcp';
  host: string;
  port: number;
}

export type WorkerAddress = SocketAddress | TcpAddress;

/**
 * Determine whether the current platform supports Unix domain sockets.
 *
 * - macOS / Linux: always supported
 * - Windows 10 1803+ (build 17134+): AF_UNIX available
 * - Older Windows: not supported
 *
 * Additionally, some containerized environments or network file systems
 * may not support socket files even on Unix. We attempt a quick probe
 * and cache the result.
 */
let platformSupportsSocketsCached: boolean | null = null;

export function platformSupportsUnixSockets(): boolean {
  if (platformSupportsSocketsCached !== null) {
    return platformSupportsSocketsCached;
  }

  if (process.platform === 'win32') {
    // Windows 10 1803+ supports AF_UNIX. Detect via a quick probe.
    try {
      const server = net.createServer();
      const probePath = path.join(SOCKETS_DIR, '.probe.sock');
      ensureSocketsDirectory();
      // Clean up any stale probe file
      try { unlinkSync(probePath); } catch { /* ignore */ }
      server.listen(probePath);
      server.close();
      try { unlinkSync(probePath); } catch { /* ignore */ }
      platformSupportsSocketsCached = true;
    } catch {
      platformSupportsSocketsCached = false;
    }
  } else {
    // macOS, Linux, and other Unix-like systems always support UDS
    platformSupportsSocketsCached = true;
  }

  return platformSupportsSocketsCached;
}

/**
 * Read the transport preference from settings.
 * Returns 'socket' | 'tcp' | undefined (undefined = auto-detect).
 */
function readTransportSetting(): WorkerAddressType | undefined {
  try {
    const settingsPath = path.join(DATA_DIR, 'settings.json');
    if (!existsSync(settingsPath)) return undefined;

    const { readFileSync } = require('fs');
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const settings = raw.env ?? raw; // handle legacy nested schema
    const transport = settings.CLAUDE_MEM_WORKER_TRANSPORT;

    if (transport === 'tcp' || transport === 'socket') {
      return transport;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure the sockets directory exists with correct permissions.
 */
export function ensureSocketsDirectory(): void {
  if (!existsSync(SOCKETS_DIR)) {
    mkdirSync(SOCKETS_DIR, { recursive: true });
  }

  // Set directory permissions to owner-only (700) on Unix
  if (process.platform !== 'win32') {
    try {
      chmodSync(SOCKETS_DIR, 0o700);
    } catch {
      // Best-effort — some filesystems don't support chmod
    }
  }
}

/**
 * Get the path for the worker socket file.
 */
export function getWorkerSocketPath(): string {
  return path.join(SOCKETS_DIR, WORKER_SOCKET_FILENAME);
}

/**
 * Remove a stale socket file if the owning process is dead.
 * Returns true if the socket was removed (or didn't exist), false if still alive.
 */
export function cleanStaleSocketFile(socketPath: string): boolean {
  if (!existsSync(socketPath)) {
    return true;
  }

  // Try to connect — if connection succeeds, the socket is still alive
  return false;
}

/**
 * Clean all stale .sock files from the sockets directory.
 * Called on startup to remove leftovers from crashed processes.
 */
export function cleanStaleSocketFiles(): void {
  if (!existsSync(SOCKETS_DIR)) return;

  try {
    const entries = readdirSync(SOCKETS_DIR);
    for (const entry of entries) {
      if (!entry.endsWith('.sock')) continue;
      // Skip probe files
      if (entry.startsWith('.probe')) continue;

      const socketPath = path.join(SOCKETS_DIR, entry);
      try {
        unlinkSync(socketPath);
        logger.debug('SYSTEM', 'Removed stale socket file during startup cleanup', { socketPath });
      } catch (error) {
        logger.debug('SYSTEM', 'Failed to remove socket file during cleanup', { socketPath }, error as Error);
      }
    }
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to enumerate sockets directory for cleanup', {}, error as Error);
  }
}

/**
 * Prepare a socket path for listening: ensure directory exists and remove stale file.
 * Must be called before `server.listen(socketPath)`.
 */
export function prepareSocketForListening(socketPath: string): void {
  ensureSocketsDirectory();

  // Remove any existing socket file (stale from a previous crash)
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
      logger.debug('SYSTEM', 'Removed existing socket file before listen', { socketPath });
    } catch (error) {
      logger.warn('SYSTEM', 'Failed to remove existing socket file', { socketPath }, error as Error);
    }
  }
}

/**
 * Resolve the worker address based on settings and platform capabilities.
 *
 * Priority:
 *   1. CLAUDE_MEM_WORKER_TRANSPORT env var or settings.json field → force mode
 *   2. Platform detection → UDS if supported, TCP otherwise
 *   3. For TCP fallback, uses CLAUDE_MEM_WORKER_PORT / CLAUDE_MEM_WORKER_HOST
 */
export function resolveWorkerAddress(
  settingsOverride?: { port?: number; host?: string; transport?: WorkerAddressType }
): WorkerAddress {
  // Check for explicit transport preference
  const envTransport = process.env.CLAUDE_MEM_WORKER_TRANSPORT as WorkerAddressType | undefined;
  const transport = settingsOverride?.transport ?? envTransport ?? readTransportSetting();

  if (transport === 'tcp') {
    return buildTcpAddress(settingsOverride?.port, settingsOverride?.host);
  }

  if (transport === 'socket' || !transport) {
    // Auto-detect or explicit socket mode
    if (platformSupportsUnixSockets()) {
      ensureSocketsDirectory();
      return {
        type: 'socket',
        socketPath: getWorkerSocketPath()
      };
    }

    // Platform doesn't support UDS — fall back to TCP
    if (transport === 'socket') {
      logger.warn('SYSTEM', 'Unix domain sockets requested but not supported on this platform, falling back to TCP');
    }
    return buildTcpAddress(settingsOverride?.port, settingsOverride?.host);
  }

  // Unknown transport value — default to auto-detect
  return buildTcpAddress(settingsOverride?.port, settingsOverride?.host);
}

/**
 * Build a TCP address from port/host, reading from settings if not provided.
 */
function buildTcpAddress(port?: number, host?: string): TcpAddress {
  // Lazy-import to avoid circular dependencies at module load time
  const { SettingsDefaultsManager } = require('../shared/SettingsDefaultsManager.js');
  const { join } = require('path');

  const settingsPath = join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

  return {
    type: 'tcp',
    host: host ?? settings.CLAUDE_MEM_WORKER_HOST,
    port: port ?? parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10)
  };
}

/**
 * Check if the worker socket file exists (quick existence check, not connectivity).
 */
export function workerSocketExists(): boolean {
  return existsSync(getWorkerSocketPath());
}

/**
 * Reset the platform support cache (for testing).
 */
export function resetPlatformSupportCache(): void {
  platformSupportsSocketsCached = null;
}
