import { executableFingerprint } from './executable-fingerprint.js';

export type DependencyStatusKind =
  | 'setup_required'
  | 'vector_search_unavailable';

export type DependencyName = 'claude_cli' | 'codex_cli' | 'observer_dir' | 'uvx' | 'chroma';

export interface DependencyStatus {
  dependency: DependencyName;
  kind: DependencyStatusKind;
  message: string;
  remediation?: string;
  recordedAtMs: number;
  /**
   * The resolved executable a spawn failed to launch (a .cmd/.bat shim the SDK
   * cannot start without a shell, or a binary that vanished), with its
   * fingerprint (executable-fingerprint.ts). The recheck gate skips while
   * discovery still resolves that same, unchanged file.
   */
  executablePath?: string;
  executableFingerprint?: string;
}

export const CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS = 30_000;

export const CLAUDE_CLI_SETUP_REMEDIATION =
  'Install or update Claude Code CLI, then restart claude-mem. Try `claude update`, ' +
  '`npm install -g @anthropic-ai/claude-code@latest`, or set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json.';

/** The Claude observer was pointed at the Codex CLI (CLAUDE_CODE_PATH or PATH). */
export const CLAUDE_CLI_IS_CODEX_REMEDIATION =
  'The Claude observer resolved the Codex CLI, which cannot run it. To run memory on your ChatGPT/Codex ' +
  'subscription, set CLAUDE_MEM_PROVIDER to codex in ~/.claude-mem/settings.json; otherwise point ' +
  'CLAUDE_CODE_PATH at the Claude Code CLI.';

function isCodexExecutable(executablePath: string): boolean {
  const name = executablePath.split(/[\\/]/).pop() ?? '';
  return /^codex(\.(exe|cmd|bat|com|ps1))?$/i.test(name);
}

/**
 * A Codex start that fails on setup (no CLI on PATH, no ChatGPT login, an
 * auth file other users can read) fails the same way on every retry, so
 * Codex starts wait this long before one goes through as the recovery probe.
 */
export const CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS = 5 * 60_000;

export const CODEX_CLI_SETUP_REMEDIATION =
  'Install the Codex CLI and run `codex login` with your ChatGPT account as the user running claude-mem, ' +
  'or set CLAUDE_MEM_CODEX_PATH in ~/.claude-mem/settings.json. Codex starts check again every 5 minutes.';

export const OBSERVER_DIR_SETUP_REMEDIATION =
  'Make the claude-mem data directory (CLAUDE_MEM_DATA_DIR, ~/.claude-mem by default) a writable directory: ' +
  'not a file, and not on a read-only volume. The next captured event checks it again.';

/**
 * Code on the classified `setup_required` error for a Claude observer working
 * directory that cannot be created (ensureObserverSessionsDir), so the failure
 * is booked under 'observer_dir' rather than as a missing Claude CLI.
 */
export const OBSERVER_DIR_UNUSABLE_CODE = 'observer_dir_unusable';

export const UVX_VECTOR_SEARCH_REMEDIATION =
  'Install uv/uvx and make uvx visible to the worker PATH, then restart claude-mem. ' +
  'Try `curl -LsSf https://astral.sh/uv/install.sh | sh` or `brew install uv`.';

export const CHROMA_VECTOR_SEARCH_REMEDIATION =
  'Stop the other claude-mem worker using the same Chroma data directory, or configure a distinct ' +
  'CLAUDE_MEM_DATA_DIR / remote Chroma instance, then restart claude-mem.';

const statuses = new Map<DependencyName, DependencyStatus>();

export interface DependencyHealthSnapshot {
  degraded: boolean;
  statuses: DependencyStatus[];
}

export function recordDependencyStatus(
  dependency: DependencyName,
  kind: DependencyStatusKind,
  message: string,
  remediation?: string,
): DependencyStatus {
  const status: DependencyStatus = {
    dependency,
    kind,
    message,
    ...(remediation ? { remediation } : {}),
    recordedAtMs: Date.now(),
  };
  statuses.set(dependency, status);
  return status;
}

/**
 * `executablePath` is the resolved executable a spawn could not launch; its
 * fingerprint is taken now, so the recheck gate can tell the same file from
 * one repaired in place.
 */
export function recordClaudeCliSetupRequired(message: string, executablePath?: string): DependencyStatus {
  const remediation = executablePath && isCodexExecutable(executablePath)
    ? CLAUDE_CLI_IS_CODEX_REMEDIATION
    : CLAUDE_CLI_SETUP_REMEDIATION;
  const status = recordDependencyStatus('claude_cli', 'setup_required', message, remediation);
  if (executablePath) {
    status.executablePath = executablePath;
    status.executableFingerprint = executableFingerprint(executablePath);
  }
  return status;
}

/**
 * Book a Claude generator start that failed on setup under what is actually
 * missing, so the recheck before the next start probes that and the
 * remediation names it. An unusable observer working directory is not a
 * Claude CLI problem: booked as one, the CLI probe passed, the status cleared,
 * and every recheck spawned a generator (and read the keychain) only to fail
 * on the directory again (#4117).
 */
export function recordClaudeSetupRequired(error: { message: string; code?: string; executablePath?: string }): DependencyStatus {
  if (error.code === OBSERVER_DIR_UNUSABLE_CODE) {
    return recordDependencyStatus('observer_dir', 'setup_required', error.message, OBSERVER_DIR_SETUP_REMEDIATION);
  }
  return recordClaudeCliSetupRequired(error.message, error.executablePath);
}

/**
 * `remediation` is the classified failure's own remedy when it has one (a model
 * or effort Codex does not serve, an isolation it cannot attest); the install
 * and login steps cover the rest.
 */
export function recordCodexCliSetupRequired(message: string, remediation: string = CODEX_CLI_SETUP_REMEDIATION): DependencyStatus {
  return recordDependencyStatus('codex_cli', 'setup_required', message, remediation);
}

export function recordUvxVectorSearchUnavailable(message: string): DependencyStatus {
  return recordDependencyStatus('uvx', 'vector_search_unavailable', message, UVX_VECTOR_SEARCH_REMEDIATION);
}

export function recordChromaVectorSearchUnavailable(message: string): DependencyStatus {
  return recordDependencyStatus('chroma', 'vector_search_unavailable', message, CHROMA_VECTOR_SEARCH_REMEDIATION);
}

export function clearDependencyStatus(dependency: DependencyName): void {
  statuses.delete(dependency);
}

export function getDependencyStatus(dependency: DependencyName): DependencyStatus | null {
  return statuses.get(dependency) ?? null;
}

export function isDependencyStatusInCooldown(
  status: DependencyStatus,
  cooldownMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - status.recordedAtMs < cooldownMs;
}

export function snapshotDependencyHealth(): DependencyHealthSnapshot {
  const currentStatuses = Array.from(statuses.values())
    .map(status => ({ ...status }))
    .sort((a, b) => a.dependency.localeCompare(b.dependency));
  return {
    degraded: currentStatuses.length > 0,
    statuses: currentStatuses,
  };
}

export function resetDependencyStatusesForTesting(): void {
  statuses.clear();
}
