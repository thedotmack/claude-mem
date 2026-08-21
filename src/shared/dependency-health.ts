export type DependencyStatusKind = 'setup_required';

export type DependencyName = 'claude_cli';

export interface DependencyStatus {
  dependency: DependencyName;
  kind: DependencyStatusKind;
  message: string;
  remediation?: string;
  recordedAtMs: number;
}

export const CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS = 30_000;

export const CLAUDE_CLI_SETUP_REMEDIATION =
  'Install or update Claude Code CLI, then restart claude-mem. Try `claude update`, ' +
  '`npm install -g @anthropic-ai/claude-code@latest`, or set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json.';

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

export function recordClaudeCliSetupRequired(message: string): DependencyStatus {
  return recordDependencyStatus('claude_cli', 'setup_required', message, CLAUDE_CLI_SETUP_REMEDIATION);
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
