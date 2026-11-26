// The install funnel's state, shared by the worker (which the setup page talks to) and the installer (which waits
// on it). One file per machine: the funnel shows until `status` is `complete`, for new installs and upgrades alike.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isCmemGatewayUrl } from './cmem-gateway.js';
import { resolveDataDir } from './paths.js';
import { randomUUID } from 'node:crypto';
import type { SetupInstallState } from './setup-install.js';
import {
  isSetupId, type SetupBranch, type SetupCheckoutState, type SetupCloudSyncOffer, type SetupInstallerStage, type SetupMemoryBilling,
  type SetupStatus, type SetupTelemetryContext,
} from './setup-funnel.js';

// The states themselves are defined in setup-funnel.ts, which the setup page can also load.
export type { SetupBranch, SetupCheckoutState, SetupInstallerStage, SetupMemoryBilling, SetupStatus };

export interface SetupChoice {
  branch: SetupBranch;
  memoryBilling: SetupMemoryBilling;
  cloudSyncOffer?: SetupCloudSyncOffer;
  /** The owner chose the standalone offer that includes sharing the Work View board. */
  shareWorkView?: true;
  chosenAt: string;
}
export interface SetupInstallerReport { stage: SetupInstallerStage; error: string | null; updatedAt: string }
/**
 * The pairing's device code while its checkout waits: cmem.ai asks for it once the person has started the trial or
 * checkout. `expiresAt` (ISO) is when the installer stops waiting on that pairing, or null when cmem.ai gave no expiry.
 */
export interface SetupDeviceCode { userCode: string; expiresAt: string | null }
export interface SetupCheckout {
  state: SetupCheckoutState; requests: number; error: string | null; updatedAt: string;
  /** Only while `waiting`, from the installer that holds the pairing. Never in GET /api/setup/state (SetupCheckoutServed). */
  deviceCode?: SetupDeviceCode;
}
/**
 * The checkout as GET /api/setup/state and its `setup-state` event frame serve it. Any localhost page can read those,
 * so the code itself stays behind the origin-guarded GET /api/setup/checkout/device-code; this only says one waits.
 */
export type SetupCheckoutServed = Omit<SetupCheckout, 'deviceCode'> & { deviceCodeWaiting?: true };

export interface SetupStateFile {
  status: SetupStatus;
  /** Present when the installer offers agent and integration configuration in the browser. */
  install?: SetupInstallState | null;
  choice: SetupChoice | null;
  installer: SetupInstallerReport | null;
  checkout: SetupCheckout | null;
  /** Finish Setup's picked tools (SETUP_TOOLS ids); the installer sets up local ones it did not install yet. */
  tools: string[] | null;
  completedAt: string | null;
}

/** What GET /api/setup/state answers: the file plus what the page needs to pre-select. */
export interface SetupStateView extends Omit<SetupStateFile, 'checkout'> {
  checkout: SetupCheckoutServed | null;
  /** This machine already has a CMEM Pro configuration: On The Go is pre-selected and checkout is skipped. */
  alreadyPro: boolean;
  /**
   * The observer already writes memories on cmem.ai (hasHostedObserver), the hosted half of `alreadyPro`. Work View's
   * hosted offer leaves these people out. Older workers do not send it.
   */
  hostedObserver?: boolean;
  /** This machine's own observation history (Finish Setup's import offer); null when the worker cannot read it. */
  history?: { projects: number; sessions: number; observations: number } | null;
  /**
   * The sync hub has acknowledged at least one observation or summary written on this computer, after the launch
   * baseline (ownMemorySynced). Read from the database, so it survives worker restarts; Work View's hosted offer waits
   * on it. Older workers do not send it.
   */
  memorySynced?: boolean;
  /** The running or last history import (worker memory only). */
  historyImport?: unknown;
  /** Long work this worker is doing now that a restart would kill: the extraction run (the automatic refresh) and the
   * history import. The installer waits for it to finish before any restart. */
  backgroundWorkRunning?: Array<'extraction' | 'history-import'>;
}

export const INITIAL_SETUP_STATE: SetupStateFile = { status: 'pending', choice: null, installer: null, checkout: null, tools: null, completedAt: null };

/** Resolved at call time so a CLAUDE_MEM_DATA_DIR set after import is honored (installer tests, clean-HOME runs). */
export function setupStatePath(): string {
  return join(resolveDataDir(), 'setup-state.json');
}

/** Saved progress outlives the installer. Only its separate live session pauses local work. */
export function setupSessionPath(statePath: string = setupStatePath()): string {
  return join(dirname(statePath), 'setup-session.json');
}

export function startSetupSession(statePath: string = setupStatePath(), alreadyPro = false): void {
  writeJsonAtomically(setupSessionPath(statePath), { pid: process.pid, setup_flow_id: randomUUID(), already_pro: alreadyPro });
}

/** One non-secret episode id per live installer, never the worker's persistent identity. */
export function readSetupTelemetryContext(statePath: string = setupStatePath()): SetupTelemetryContext | null {
  try {
    const value = JSON.parse(readFileSync(setupSessionPath(statePath), 'utf8'));
    if (!isSetupId(value.setup_flow_id) || typeof value.already_pro !== 'boolean' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    process.kill(value.pid, 0);
    return { setup_flow_id: value.setup_flow_id, already_pro: value.already_pro };
  } catch { return null; }
}

export function endSetupSession(statePath: string = setupStatePath()): void {
  rmSync(setupSessionPath(statePath), { force: true });
}

/** No age limit: a live installer may wait for the browser indefinitely; a killed installer stops pausing work. */
export function hasActiveSetupSession(statePath: string = setupStatePath()): boolean {
  const path = setupSessionPath(statePath);
  let saved: string;
  try { saved = readFileSync(path, 'utf8'); }
  catch (error) {
    // The installer can finish between worker ticks; a removed session is inactive.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const { pid } = JSON.parse(saved) as { pid?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new Error(`Setup session at ${path} has no valid installer PID.`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

/** A missing file is a machine that has not finished setup. A corrupt one is an error, not a silent reset. */
export function readSetupState(path: string = setupStatePath()): SetupStateFile {
  if (!existsSync(path)) return { ...INITIAL_SETUP_STATE };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SetupStateFile>;
  if (parsed.status !== 'pending' && parsed.status !== 'complete') {
    throw new Error(`Setup state at ${path} has no valid status.`);
  }
  return {
    status: parsed.status,
    ...(parsed.install ? { install: parsed.install } : {}),
    choice: parsed.choice ?? null,
    installer: parsed.installer ?? null,
    checkout: parsed.checkout ?? null,
    tools: Array.isArray(parsed.tools) ? parsed.tools.filter((tool): tool is string => typeof tool === 'string') : null,
    completedAt: parsed.completedAt ?? null,
  };
}

/** Writes through a temp file beside it, so a reader never sees half a file. */
export function writeSetupState(state: SetupStateFile, path: string = setupStatePath()): void {
  writeJsonAtomically(path, state);
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    // A failed write or rename (Windows EPERM/EBUSY while the target is held)
    // would otherwise leave this randomly named temp behind on every attempt.
    try { unlinkSync(temp); } catch { /* the temp may not exist */ }
    throw error;
  }
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/** The observer writes memories on the cmem.ai gateway (CMEM Pro's hosted memory writing), not on the person's own provider. */
export function hasHostedObserver(settings: Record<string, unknown>): boolean {
  return settings.CLAUDE_MEM_PROVIDER === 'openrouter'
    && filled(settings.CLAUDE_MEM_OPENROUTER_API_KEY)
    && isCmemGatewayUrl(String(settings.CLAUDE_MEM_OPENROUTER_BASE_URL ?? ''));
}

/** CMEM Pro observer on the cmem.ai gateway, or a configured cloud sync connection. */
export function hasProConfiguration(settings: Record<string, unknown>): boolean {
  const proObserver = hasHostedObserver(settings);
  const cloudSync = ['CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID', 'CLAUDE_MEM_CLOUD_SYNC_HUB_URL']
    .every((key) => filled(settings[key]));
  return proObserver || cloudSync;
}
