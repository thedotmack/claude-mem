export type DependencyStatusKind =
  | 'ok'
  | 'setup_required'
  | 'vector_search_unavailable';

export type DependencyName = 'claude_cli' | 'uvx';

export interface DependencyStatus {
  dependency: DependencyName;
  kind: DependencyStatusKind;
  message: string;
  recordedAtMs: number;
}

export const CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS = 30_000;

const statuses = new Map<DependencyName, DependencyStatus>();

export function recordDependencyStatus(
  dependency: DependencyName,
  kind: Exclude<DependencyStatusKind, 'ok'>,
  message: string,
): DependencyStatus {
  const status: DependencyStatus = {
    dependency,
    kind,
    message,
    recordedAtMs: Date.now(),
  };
  statuses.set(dependency, status);
  return status;
}

export function clearDependencyStatus(dependency: DependencyName): void {
  statuses.delete(dependency);
}

export function getDependencyStatus(dependency: DependencyName): DependencyStatus | null {
  return statuses.get(dependency) ?? null;
}

export function isDependencyBlocked(
  dependency: DependencyName,
  kind?: Exclude<DependencyStatusKind, 'ok'>,
): boolean {
  const status = getDependencyStatus(dependency);
  if (!status) return false;
  return kind ? status.kind === kind : status.kind !== 'ok';
}

export function isDependencyStatusInCooldown(
  status: DependencyStatus,
  cooldownMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - status.recordedAtMs < cooldownMs;
}

export function resetDependencyStatusesForTesting(): void {
  statuses.clear();
}
