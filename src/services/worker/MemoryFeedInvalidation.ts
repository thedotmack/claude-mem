import { onContextInvalidation, type ContextInvalidation } from '../../shared/context-invalidation.js';
import { logger } from '../../utils/logger.js';
import type { SSEBroadcaster } from './SSEBroadcaster.js';

export const MEMORY_FEED_INVALIDATION_DELAY_MS = 100;
const MAX_PROJECTS = 128;
const MEMORY_KINDS = ['observation', 'summary', 'prompt'] as const;
type MemoryKind = typeof MEMORY_KINDS[number];

// Older local writers announce a reason without the newer content metadata.
// Keep this list explicit: a health/settings invalidation is not a data change.
const LOCAL_KIND: Record<string, MemoryKind> = {
  storeObservations: 'observation',
  importObservation: 'observation',
  storeSummary: 'summary',
  importSessionSummary: 'summary',
  saveUserPrompt: 'prompt',
  saveNativeUserPrompt: 'prompt',
  importUserPrompt: 'prompt',
  'delete-observation': 'observation',
  'delete-summary': 'summary',
  'delete-prompt': 'prompt',
};
const LOCAL_ALL = new Set(['delete-session', 'project-merge', 'import', 'worktree-adoption']);

function memoryKinds(change: ContextInvalidation): MemoryKind[] | 'all' | null {
  if (change.changes) {
    // Mutations can change session titles, ownership and project membership.
    // The HTTP endpoints, not a fabricated new-row event, resolve that state.
    if (change.changes.kinds.includes('mutation')) return 'all';
    const kinds = MEMORY_KINDS.filter(kind => change.changes!.kinds.includes(kind));
    if (kinds.length) return kinds;
    if (change.changes.kinds.every(kind => kind === 'work_state')) return null;
  }
  if (Object.hasOwn(LOCAL_KIND, change.reason)) return [LOCAL_KIND[change.reason]];
  if (LOCAL_ALL.has(change.reason)) return 'all';
  // applyOps may recover an older quarantined record whose kind is unknown.
  // The separately named work-state replay cannot change the memory feed.
  if (change.reason === 'SyncApply.replaySetAsideWorkState') return null;
  return change.reason.startsWith('SyncApply.') ? 'all' : null;
}

/**
 * Bridges the existing post-commit notifications (SyncApply.applyOps and
 * SessionStore writers) to the classic viewer. This is an invalidation hint,
 * not a replay cursor or a copy of memory content. A reconnect must re-read.
 */
export class MemoryFeedInvalidation {
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly kinds = new Set<MemoryKind>();
  private readonly projects = new Set<string>();
  private allKinds = false;
  private allProjects = false;
  private closed = false;

  constructor(
    private readonly broadcaster: Pick<SSEBroadcaster, 'broadcast'>,
    private readonly delayMs = MEMORY_FEED_INVALIDATION_DELAY_MS,
  ) {}

  start(): void {
    if (this.closed || this.unsubscribe) return;
    this.unsubscribe = onContextInvalidation(change => {
      // Invalidations run in the writer's call stack; a viewer must never
      // make an already committed write appear to fail.
      try { this.changed(change); }
      catch (error) { logger.debug('WORKER', 'Memory feed invalidation failed', undefined, error instanceof Error ? error : undefined); }
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.reset();
  }

  private changed(change: ContextInvalidation): void {
    if (this.closed) return;
    const kinds = memoryKinds(change);
    if (kinds === null) return;
    if (kinds === 'all') this.allKinds = true;
    else for (const kind of kinds) this.kinds.add(kind);
    if (change.scope === 'all' || !change.scope.projects.length) this.allProjects = true;
    else if (!this.allProjects) {
      for (const project of change.scope.projects) {
        this.projects.add(project);
        if (this.projects.size > MAX_PROJECTS) {
          this.allProjects = true;
          this.projects.clear();
          break;
        }
      }
    }
    // A fixed window bounds latency during continuous writes; resetting the
    // timeout for every write could postpone the refresh indefinitely.
    if (this.timer !== null) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = null;
    if (this.closed) return;
    const event = {
      type: 'data_changed',
      ...(!this.allKinds ? { kinds: [...this.kinds].sort() } : {}),
      ...(!this.allProjects ? { projects: [...this.projects].sort() } : {}),
    };
    this.reset();
    try { this.broadcaster.broadcast(event); }
    catch (error) { logger.debug('WORKER', 'Memory feed broadcast failed', undefined, error instanceof Error ? error : undefined); }
  }

  private reset(): void {
    this.kinds.clear();
    this.projects.clear();
    this.allKinds = false;
    this.allProjects = false;
  }
}
