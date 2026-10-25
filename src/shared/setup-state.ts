// The install funnel's state, shared by the worker (which the setup page talks to) and the installer (which waits
// on it). One file per machine: the funnel shows until `status` is `complete`, for new installs and upgrades alike.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isCmemGatewayUrl } from './cmem-gateway.js';
import { resolveDataDir } from './paths.js';

export type SetupBranch = 'home' | 'go';
/** Who generates memories: CMEM Pro (hosted) or the person's own token plan. */
export type SetupMemoryBilling = 'hosted' | 'existing';

/**
 * What the installer has done with the browser's choice. Phase 8 (checkout) picks up from `go-awaiting-checkout`:
 * the installer holds the started pairing in memory and waits for the checkout request.
 */
export type SetupInstallerStage =
  | 'waiting-for-choice'
  | 'home-ready'
  | 'go-kept-existing-pro'
  | 'go-awaiting-checkout'
  | 'failed';

export interface SetupChoice { branch: SetupBranch; memoryBilling: SetupMemoryBilling; chosenAt: string }
export interface SetupInstallerReport { stage: SetupInstallerStage; error: string | null; updatedAt: string }

/**
 * On The Go checkout (funnel Phase 8). The page asks (`requested`, counted so a second ask reopens the checkout);
 * the installer runs the existing pairing checkout and reports `waiting`, then `paid` or `failed`.
 */
export type SetupCheckoutState = 'requested' | 'waiting' | 'paid' | 'failed';
export interface SetupCheckout { state: SetupCheckoutState; requests: number; error: string | null; updatedAt: string }

export interface SetupStateFile {
  status: 'pending' | 'complete';
  choice: SetupChoice | null;
  installer: SetupInstallerReport | null;
  checkout: SetupCheckout | null;
  /** Finish Setup's picked tools (SETUP_TOOLS ids); the installer sets up local ones it did not install yet. */
  tools: string[] | null;
  completedAt: string | null;
}

/** What GET /api/setup/state answers: the file plus what the page needs to pre-select. */
export interface SetupStateView extends SetupStateFile {
  /** This machine already has a CMEM Pro configuration: On The Go is pre-selected and checkout is skipped. */
  alreadyPro: boolean;
  /** This machine's own observation history (Finish Setup's import offer); null when the worker cannot read it. */
  history?: { projects: number; sessions: number; observations: number } | null;
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

export function startSetupSession(statePath: string = setupStatePath()): void {
  writeJsonAtomically(setupSessionPath(statePath), { pid: process.pid });
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
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/** CMEM Pro observer on the cmem.ai gateway, or a configured cloud sync connection. */
export function hasProConfiguration(settings: Record<string, unknown>): boolean {
  const proObserver = settings.CLAUDE_MEM_PROVIDER === 'openrouter'
    && filled(settings.CLAUDE_MEM_OPENROUTER_API_KEY)
    && isCmemGatewayUrl(String(settings.CLAUDE_MEM_OPENROUTER_BASE_URL ?? ''));
  const cloudSync = ['CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID', 'CLAUDE_MEM_CLOUD_SYNC_HUB_URL']
    .every((key) => filled(settings[key]));
  return proObserver || cloudSync;
}
