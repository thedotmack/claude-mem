export type NormalizedAbortReason =
  | 'idle'
  | 'shutdown'
  | 'overflow'
  | 'restart_guard'
  | 'quota'
  | 'drift'
  | 'none';

export const PRESERVING_ABORT_CATEGORIES = new Set(['quota', 'auth', 'drift'] as const);

export function abortCategoryOf(reason: string | null | undefined): string {
  return (reason ?? '').split(':')[0];
}

export function normalizeAbortReason(reason: string | null | undefined): NormalizedAbortReason {
  switch (abortCategoryOf(reason)) {
    case 'idle': return 'idle';
    case 'shutdown': return 'shutdown';
    case 'overflow': return 'overflow';
    case 'restart-guard': return 'restart_guard';
    case 'quota': return 'quota';
    case 'drift': return 'drift';
    default: return 'none';
  }
}
