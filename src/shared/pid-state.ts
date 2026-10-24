// The PID, port and runtime state files a background service keeps beside
// itself (the server runtime and the wire gateway), and the waits around them.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { logger, type Component } from '../utils/logger.js';
import { captureProcessStartToken, verifyPidFileOwnership, type PidInfo } from '../supervisor/process-registry.js';

export interface ServiceStateFiles {
  pidFile: string;
  portFile: string;
  runtimeFile: string;
  /** The mode each file is written with and kept at; undefined leaves the default. */
  fileMode?: number;
}

/** Sets an existing file's mode (not on Windows, which has none). */
export function restrictFileMode(filePath: string, fileMode: number): void {
  if (process.platform !== 'win32' && existsSync(filePath)) chmodSync(filePath, fileMode);
}

/** Writes `content`, applying `fileMode` to an existing file too (writeFileSync's mode applies only when it creates one). */
function writeFileWithMode(filePath: string, content: string, fileMode: number | undefined): void {
  if (fileMode === undefined) {
    writeFileSync(filePath, content);
    return;
  }
  writeFileSync(filePath, content, { mode: fileMode });
  restrictFileMode(filePath, fileMode);
}

/** Writes the PID, port and runtime files; returns what the PID file now says. */
export function writeServiceState(files: ServiceStateFiles, state: { pid: number; port: number; startedAt: string }): PidInfo {
  const pidInfo: PidInfo = {
    pid: state.pid,
    port: state.port,
    startedAt: state.startedAt,
    startToken: captureProcessStartToken(state.pid) ?? undefined,
  };
  writeFileWithMode(files.pidFile, JSON.stringify(pidInfo, null, 2), files.fileMode);
  writeFileWithMode(files.portFile, `${state.port}\n`, files.fileMode);
  writeFileWithMode(files.runtimeFile, JSON.stringify(state, null, 2), files.fileMode);
  return pidInfo;
}

/** A state file's JSON, or null when it is missing or unreadable (logged as "Failed to read <description>"). */
export function readServiceStateFile<T>(filePath: string, component: Component, description: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn(component, `Failed to read ${description}`, { path: filePath }, err);
    return null;
  }
}

export function removeServiceState(files: ServiceStateFiles): void {
  rmSync(files.pidFile, { force: true });
  rmSync(files.portFile, { force: true });
  rmSync(files.runtimeFile, { force: true });
}

/** Polls `check` every `intervalMs` until it holds (true) or `timeoutMs` passes (false). */
export async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** Waits until the process `pidInfo` names is gone (its start token, when it has one, guards against PID reuse). */
export async function waitForPidExit(pidInfo: PidInfo, timeoutMs: number): Promise<void> {
  await pollUntil(() => !verifyPidFileOwnership(pidInfo), timeoutMs);
}
