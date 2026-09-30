import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { logger } from '../utils/logger.js';

/**
 * Windows HANDLE_FLAG_INHERIT — when set, CreateProcess with
 * bInheritHandles=TRUE duplicates the handle into every child. Bun/Node
 * listening sockets are inheritable by default, so a chroma-mcp / SDK child
 * that outlives a crashed worker keeps port 37800 LISTENING under the dead
 * parent PID (claude-mem#3300).
 */
const HANDLE_FLAG_INHERIT = 0x00000001;

/** Upper bound for brute-force HANDLE scan (handles are typically multiples of 4). */
const MAX_HANDLE_SCAN = 0x4000;

interface ListenHandle {
  fd?: number;
}

function loadWinApis(): {
  setHandleInformation: (handle: number, mask: number, flags: number) => number;
  getsockname: (
    socket: number | bigint,
    name: ReturnType<typeof import('bun:ffi').ptr>,
    namelen: ReturnType<typeof import('bun:ffi').ptr>,
  ) => number;
  ntohs: (netshort: number) => number;
  ptr: typeof import('bun:ffi').ptr;
} | null {
  try {
    const { dlopen, FFIType, ptr, suffix } = require('bun:ffi') as typeof import('bun:ffi');
    const kernel32Mod = dlopen(`kernel32.${suffix}`, {
      SetHandleInformation: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
      },
    });
    const ws2Mod = dlopen(`ws2_32.${suffix}`, {
      getsockname: {
        args: [FFIType.u64, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      ntohs: {
        args: [FFIType.u16],
        returns: FFIType.u16,
      },
    });
    return {
      setHandleInformation: kernel32Mod.symbols.SetHandleInformation as (
        handle: number,
        mask: number,
        flags: number,
      ) => number,
      getsockname: ws2Mod.symbols.getsockname as (
        socket: number | bigint,
        name: ReturnType<typeof import('bun:ffi').ptr>,
        namelen: ReturnType<typeof import('bun:ffi').ptr>,
      ) => number,
      ntohs: ws2Mod.symbols.ntohs as (netshort: number) => number,
      ptr,
    };
  } catch {
    return null;
  }
}

function readListenPort(server: Server): number | null {
  const addr = server.address();
  if (!addr || typeof addr === 'string') return null;
  return (addr as AddressInfo).port;
}

/**
 * Prefer the public `_handle.fd` when Bun/Node exposes it (net.Server).
 * Bun's http.Server does not expose `_handle`, so fall back to scanning this
 * process's HANDLEs with getsockname for one bound to `port`.
 */
function resolveListenSocketHandle(
  server: Server,
  port: number,
  apis: NonNullable<ReturnType<typeof loadWinApis>>,
): number | null {
  const handle = (server as Server & { _handle?: ListenHandle | null })._handle;
  const fd = handle?.fd;
  if (typeof fd === 'number' && fd > 0) return fd;

  const addr = new Uint8Array(28);
  const addrLen = new Int32Array([16]);
  for (let h = 4; h < MAX_HANDLE_SCAN; h += 4) {
    addrLen[0] = 16;
    addr.fill(0);
    const rc = apis.getsockname(h, apis.ptr(addr), apis.ptr(addrLen));
    if (rc !== 0) continue;
    const portHost = apis.ntohs(addr[2] | (addr[3] << 8));
    if (portHost === port) return h;
  }
  return null;
}

/**
 * Clear HANDLE_FLAG_INHERIT on the HTTP listen socket so Windows children
 * cannot keep the worker port bound after the daemon exits.
 *
 * No-op on non-Windows. Best-effort: failures log and return false so a
 * missing bun:ffi / odd handle shape never blocks listen().
 */
export function clearWindowsListenSocketInherit(server: Server): boolean {
  if (process.platform !== 'win32') return false;

  const port = readListenPort(server);
  if (port === null || port <= 0) {
    logger.debug('SYSTEM', 'Windows listen socket inherit clear skipped: no bound port');
    return false;
  }

  const apis = loadWinApis();
  if (!apis) {
    logger.warn('SYSTEM', 'Windows listen socket inherit clear skipped: bun:ffi unavailable');
    return false;
  }

  const socketHandle = resolveListenSocketHandle(server, port, apis);
  if (socketHandle === null) {
    logger.warn('SYSTEM', 'Windows listen socket inherit clear skipped: listen handle not found', { port });
    return false;
  }

  try {
    const ok = apis.setHandleInformation(socketHandle, HANDLE_FLAG_INHERIT, 0);
    if (!ok) {
      logger.warn('SYSTEM', 'SetHandleInformation failed to clear HANDLE_FLAG_INHERIT on listen socket', {
        port,
        socketHandle,
      });
      return false;
    }
    logger.debug('SYSTEM', 'Cleared HANDLE_FLAG_INHERIT on Windows listen socket', { port, socketHandle });
    return true;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Failed to clear Windows listen socket inherit flag', { port, socketHandle }, err);
    return false;
  }
}
