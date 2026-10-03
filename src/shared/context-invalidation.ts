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

export interface ContextInvalidation {
  scope: ContextInvalidationScope;
  /** Which write, for logs: 'storeObservations', 'observer-health', ... */
  reason: string;
}

type ContextInvalidationListener = (invalidation: ContextInvalidation) => void;

const listeners = new Set<ContextInvalidationListener>();

export function onContextInvalidation(listener: ContextInvalidationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitContextInvalidation(scope: ContextInvalidationScope, reason: string): void {
  for (const listener of listeners) {
    listener({ scope, reason });
  }
}
