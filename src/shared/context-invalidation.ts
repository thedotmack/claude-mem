/**
 * One place every write that changes SessionStart context announces itself
 * (liveness plan, Phase 6). The worker's ContextCacheService listens and
 * re-renders the cached blocks that read the written project.
 *
 * In a process with no listener (hooks, CLI, tests) an emit is a no-op, so
 * writers call it unconditionally.
 */

/** The projects a write touched, or 'all' when it can change every block (settings, health banner, merges). */
export type ContextInvalidationScope = { projects: string[] } | 'all';

/**
 * 'additive': the write adds or refreshes memory; the cached block may keep
 * being served (slightly stale) until the debounced re-render replaces it.
 * 'removal': the write deletes, merges, remaps or replaces memory; the cached
 * block may show what is gone, so it is removed before the emit returns (the
 * hook takes the live path until the re-render lands).
 */
export type ContextInvalidationKind = 'additive' | 'removal';

export interface ContextInvalidation {
  scope: ContextInvalidationScope;
  /** Which write, for logs: 'storeObservations', 'observer-health', ... */
  reason: string;
  kind: ContextInvalidationKind;
}

type ContextInvalidationListener = (invalidation: ContextInvalidation) => void;

const listeners = new Set<ContextInvalidationListener>();

export function onContextInvalidation(listener: ContextInvalidationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitContextInvalidation(
  scope: ContextInvalidationScope,
  reason: string,
  kind: ContextInvalidationKind = 'additive',
): void {
  for (const listener of listeners) {
    listener({ scope, reason, kind });
  }
}

// Settings saves (SettingsRoutes) bump this count. A reader that caches a
// settings snapshot for context renders (SearchRoutes) keeps the count it read
// under and reloads when it changes, so the re-render a save schedules never
// renders from the snapshot taken before the save.
let userSettingsSaveCount = 0;

export function noteUserSettingsSaved(): void {
  userSettingsSaveCount++;
}

export function currentUserSettingsSaveCount(): number {
  return userSettingsSaveCount;
}
