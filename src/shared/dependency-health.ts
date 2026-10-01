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
   * The resolved executable path that failed, when the failure was a spawn
   * error (a .cmd/.bat shim the SDK cannot launch, or a missing binary). The
   * setup-recheck gate uses it to avoid re-running a query against the same
   * unspawnable path that discovery still resolves.
   */
  executablePath?: string;
}

export const CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS = 30_000;

export const CLAUDE_CLI_SETUP_REMEDIATION =
  'Install or update Claude Code CLI, then restart claude-mem. Try `claude update`, ' +
  '`npm install -g @anthropic-ai/claude-code@latest`, or set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json.';

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
  executablePath?: string,
): DependencyStatus {
  const status: DependencyStatus = {
    dependency,
    kind,
    message,
    ...(remediation ? { remediation } : {}),
    recordedAtMs: Date.now(),
    ...(executablePath ? { executablePath } : {}),
  };
  statuses.set(dependency, status);
  return status;
}

export function recordClaudeCliSetupRequired(message: string, executablePath?: string): DependencyStatus {
  return recordDependencyStatus('claude_cli', 'setup_required', message, CLAUDE_CLI_SETUP_REMEDIATION, executablePath);
}

/**
 * Book a Claude generator start that failed on setup under what is actually
 * missing, so the recheck before the next start probes that and the
 * remediation names it. An unusable observer working directory is not a
 * Claude CLI problem: booked as one, the CLI probe passed, the status cleared,
 * and every recheck spawned a generator (and read the keychain) only to fail
 * on the directory again (#4117).
 */
export function recordClaudeSetupRequired(error: { message: string; code?: string }): DependencyStatus {
  if (error.code === OBSERVER_DIR_UNUSABLE_CODE) {
    return recordDependencyStatus('observer_dir', 'setup_required', error.message, OBSERVER_DIR_SETUP_REMEDIATION);
  }
  return recordClaudeCliSetupRequired(error.message);
}

export function recordCodexCliSetupRequired(message: string): DependencyStatus {
  return recordDependencyStatus('codex_cli', 'setup_required', message, CODEX_CLI_SETUP_REMEDIATION);
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
