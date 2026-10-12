/**
 * Keeps the precomputed SessionStart blocks fresh (liveness plan, Phase 6).
 *
 * A variant (project keys + platform source + colors) is learned the first time
 * the live route renders it, and remembered in an index file so a booting
 * worker re-renders every known variant. After that, any write that changes
 * what a variant shows (shared/context-invalidation.ts) re-renders it once the
 * writes settle for CONTEXT_CACHE_RENDER_DEBOUNCE_MS.
 *
 * A block that carries the observer/sync health banner is not cached: the
 * banner's own durations and expiry are time-dependent, so its file is removed
 * and the hook takes the live path until the banner clears.
 *
 * No cached block carries the prior session's reply ("Include last message"):
 * that reply is chosen by excluding the session that asks, and any session may
 * read a cached block. With the setting on, the live route answers with the
 * reply and only warms the variant (warmVariant); the hook falls back on the
 * cached block, rendered without it, while the worker is down.
 *
 * A 'removal' invalidation (delete, merge, import, pulled tombstone or remap)
 * removes the matched files synchronously, before the writer's emit returns,
 * so the hook never serves deleted memory while the re-render is pending. A
 * render that was already in flight when a removal landed is discarded (and
 * re-queued) instead of writing pre-removal content back.
 *
 * Local-first: the files are servable with or without cloud sync. The local db
 * is the source of truth; sync applies other devices' ops in the background and
 * every applied op invalidates the files. setServable(false) removes every file
 * and none is written (the hook takes the live path); setServable(true)
 * re-renders all.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  contextCacheDir,
  readContextCache,
  contextCacheVariantId,
  listContextCacheFiles,
  removeContextCache,
  writeContextCache,
  type ContextCacheKeys,
} from '../../shared/context-cache.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { onContextInvalidation, type ContextInvalidation } from '../../shared/context-invalidation.js';
import { logger } from '../../utils/logger.js';

export const CONTEXT_CACHE_RENDER_DEBOUNCE_MS = 2_000;
/** Variants kept fresh at once; the oldest-learned one past this is dropped (and its file removed). */
export const CONTEXT_CACHE_MAX_VARIANTS = 64;
const CONTEXT_CACHE_INDEX_FILENAME = 'variants.json';

export interface ContextVariantRender {
  /** The block with its time placeholders, exactly as the live route fills and sends it. */
  body: string;
  /** False when the block must stay live (health banner, or a reply chosen for the asking session). */
  cacheable: boolean;
}

export interface ContextCacheServiceOptions {
  renderVariant: (keys: ContextCacheKeys) => Promise<ContextVariantRender>;
  /** Every stored key a read of `projects` matches (projectReadKeys). */
  expandProjectReadKeys: (projects: string[]) => string[];
  debounceMs?: number;
  maxVariants?: number;
  /** False keeps the files unservable until setServable(true). Default true. */
  initiallyServable?: boolean;
  now?: () => number;
}

interface KnownVariant {
  keys: ContextCacheKeys;
  learnedAtEpochMs: number;
  /** Lower-cased projectReadKeys of keys.projects, refreshed on every render. */
  readKeys: Set<string>;
}

interface PersistedVariantIndex {
  variants: Array<{ keys: ContextCacheKeys; learnedAtEpochMs: number }>;
}

export class ContextCacheService {
  private readonly variants = new Map<string, KnownVariant>();
  private readonly pendingVariantIds = new Set<string>();
  private readonly activeVariantIds = new Set<string>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderChain: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  /** Bumped by every 'removal' invalidation; a render that saw it change mid-flight is not persisted. */
  private removalGeneration = 0;
  private servable: boolean;
  private readonly debounceMs: number;
  private readonly maxVariants: number;
  private readonly now: () => number;

  constructor(private readonly options: ContextCacheServiceOptions) {
    this.debounceMs = options.debounceMs ?? CONTEXT_CACHE_RENDER_DEBOUNCE_MS;
    this.maxVariants = options.maxVariants ?? CONTEXT_CACHE_MAX_VARIANTS;
    this.now = options.now ?? Date.now;
    this.servable = options.initiallyServable ?? true;
  }

  /** Load the known variants, drop orphaned files, listen for writes, and re-render everything once. */
  start(): void {
    for (const entry of this.readIndex().variants) {
      this.variants.set(contextCacheVariantId(entry.keys), {
        keys: entry.keys,
        learnedAtEpochMs: entry.learnedAtEpochMs,
        readKeys: new Set(),
      });
    }
    this.removeOrphanedFiles();
    // Sync on but Realtime not joined yet: a previous worker's files may predate remote ops.
    if (!this.servable) for (const variant of this.variants.values()) this.removeFile(variant.keys);
    this.unsubscribe = onContextInvalidation(invalidation => this.handleInvalidation(invalidation));
    // The database may have changed while no worker was running.
    for (const variantId of this.variants.keys()) this.pendingVariantIds.add(variantId);
    if (this.pendingVariantIds.size > 0) this.scheduleRender();
    logger.info('CONTEXT_CACHE', 'Context cache started', { knownVariants: this.variants.size });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    // A pending variant's file predates a write (possibly a delete) it will now
    // never re-render for; served until the next worker boots, it could show
    // deleted memory. Remove it so the hook takes the live path instead.
    for (const variantId of new Set([...this.pendingVariantIds, ...this.activeVariantIds])) {
      const variant = this.variants.get(variantId);
      if (variant) this.removeFile(variant.keys);
    }
    this.pendingVariantIds.clear();
  }

  /**
   * The live route rendered `keys`: write (or remove) its file and learn the
   * variant so later writes keep it fresh.
   */
  recordLiveRender(
    keys: ContextCacheKeys,
    render: ContextVariantRender,
    renderedAtEpochMs: number,
    /** removalGenerationNow() taken before the render began; omitted = no removal check. */
    removalGenerationAtRenderStart?: number,
  ): void {
    if (this.stopped) return;
    const variantId = contextCacheVariantId(keys);
    if (!this.variants.has(variantId)) {
      this.variants.set(variantId, { keys, learnedAtEpochMs: this.now(), readKeys: new Set() });
      this.evictOldestVariants();
      this.writeIndex();
      logger.debug('CONTEXT_CACHE', 'Learned a SessionStart context variant', { variantId, keys });
    }
    this.refreshReadKeys(variantId);
    if (removalGenerationAtRenderStart !== undefined && removalGenerationAtRenderStart !== this.removalGeneration) {
      // A delete landed while this render ran: its body may show what is gone.
      this.requeueAfterRemoval(variantId);
      return;
    }
    this.persistRender(keys, render, renderedAtEpochMs);
  }

  /**
   * The live route answered `keys` with a block it must not persist (it carries
   * the asking session's prior reply). Learn the variant anyway and, when no
   * fresh file is on disk, render its cached block (which has no reply) through
   * the render queue, so the hook has it to fall back on while the worker is down.
   */
  warmVariant(keys: ContextCacheKeys): void {
    if (this.stopped) return;
    const variantId = contextCacheVariantId(keys);
    if (!this.variants.has(variantId)) {
      this.recordLiveRender(keys, { body: '', cacheable: false }, this.now());
    }
    if (readContextCache(keys, this.now())) return;
    this.pendingVariantIds.add(variantId);
    this.scheduleRender();
  }

  /** Pass to recordLiveRender to discard a render that a removal overtook. */
  removalGenerationNow(): number {
    return this.removalGeneration;
  }

  /** Render everything pending now (tests, shutdown). */
  async flushPendingRenders(): Promise<void> {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
      this.enqueuePendingRender();
    }
    await this.renderChain;
  }

  /**
   * Cloud sync's Realtime channel joined and caught up (true — SyncClient's
   * onRealtimeCaughtUpChange(true)), or dropped or fell behind an announced
   * head (false). Dropping removes every cached file now; catching up
   * re-renders every known variant.
   */
  setServable(servable: boolean): void {
    if (this.servable === servable) return;
    this.servable = servable;
    logger.info('CONTEXT_CACHE', servable
      ? 'Sync live updates joined; serving precomputed SessionStart context again'
      : 'Sync live updates down; SessionStart takes the live path (pulls first) until they rejoin', { knownVariants: this.variants.size });
    if (!servable) {
      for (const variant of this.variants.values()) this.removeFile(variant.keys);
      return;
    }
    for (const variantId of this.variants.keys()) this.pendingVariantIds.add(variantId);
    if (this.pendingVariantIds.size > 0) this.scheduleRender();
  }

  knownVariantCount(): number {
    return this.variants.size;
  }

  private handleInvalidation(invalidation: ContextInvalidation): void {
    const removal = invalidation.kind === 'removal';
    if (removal) this.removalGeneration++;
    let matched = 0;
    for (const [variantId, variant] of this.variants) {
      if (invalidation.scope === 'all' || invalidation.scope.projects.some(project => variant.readKeys.has(project.toLowerCase()))) {
        this.pendingVariantIds.add(variantId);
        // Synchronous: the writer's HTTP route responds only after this returns.
        if (removal) this.removeFile(variant.keys);
        matched++;
      }
    }
    if (matched === 0) return;
    logger.debug('CONTEXT_CACHE', 'Context invalidated', { reason: invalidation.reason, kind: invalidation.kind, variants: matched });
    this.scheduleRender();
  }

  private requeueAfterRemoval(variantId: string): void {
    logger.debug('CONTEXT_CACHE', 'Discarded a render a removal overtook; re-rendering', { variantId });
    this.pendingVariantIds.add(variantId);
    this.scheduleRender();
  }

  /**
   * Coalesce: the first invalidation starts the timer and later ones join it,
   * so a steady stream of writes still re-renders every debounce interval.
   */
  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.enqueuePendingRender();
    }, this.debounceMs);
    this.renderTimer.unref?.();
  }

  private enqueuePendingRender(): void {
    this.renderChain = this.renderChain.then(() => this.renderPending());
  }

  private async renderPending(): Promise<void> {
    const variantIds = [...this.pendingVariantIds];
    this.pendingVariantIds.clear();
    for (const variantId of variantIds) {
      // Each render is mostly synchronous SQLite work; yield to the event loop
      // between variants so a boot (up to maxVariants renders) never starves HTTP.
      await new Promise<void>(resolve => setImmediate(resolve));
      const variant = this.variants.get(variantId);
      if (!variant) continue;
      if (this.stopped) {
        // Shutting down (the database may already be closed): same as stop() for pending variants.
        this.removeFile(variant.keys);
        continue;
      }
      const renderedAtEpochMs = this.now();
      const removalGenerationAtStart = this.removalGeneration;
      this.activeVariantIds.add(variantId);
      try {
        this.refreshReadKeys(variantId);
        const render = await this.options.renderVariant(variant.keys);
        // A queued render owns this exact registry entry. Teardown or eviction
        // can remove it while the renderer awaits, and a later live request
        // may already have learned a replacement with the same cache key.
        if (this.stopped || this.variants.get(variantId) !== variant) continue;
        if (removalGenerationAtStart !== this.removalGeneration) {
          this.requeueAfterRemoval(variantId);
          continue;
        }
        this.persistRender(variant.keys, render, renderedAtEpochMs);
      } catch (error) {
        // The old file would now be wrong; remove it so the hook takes the live path.
        logger.error('CONTEXT_CACHE', 'Context re-render failed; removing the cached block', { variantId, keys: variant.keys },
          error instanceof Error ? error : new Error(String(error)));
        if (this.variants.get(variantId) === variant) this.removeFile(variant.keys);
      } finally {
        this.activeVariantIds.delete(variantId);
      }
    }
  }

  private persistRender(keys: ContextCacheKeys, render: ContextVariantRender, renderedAtEpochMs: number): void {
    if (!render.cacheable || !this.servable) {
      this.removeFile(keys);
      return;
    }
    try {
      writeContextCache(keys, render.body, renderedAtEpochMs);
    } catch (error) {
      logger.error('CONTEXT_CACHE', 'Failed to write the cached context block', { keys },
        error instanceof Error ? error : new Error(String(error)));
      this.removeFile(keys);
    }
  }

  private removeFile(keys: ContextCacheKeys): void {
    try {
      removeContextCache(keys);
    } catch (error) {
      logger.error('CONTEXT_CACHE', 'Failed to remove a cached context block', { keys },
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  private refreshReadKeys(variantId: string): void {
    const variant = this.variants.get(variantId);
    if (!variant) return;
    variant.readKeys = new Set(
      [...variant.keys.projects, ...this.options.expandProjectReadKeys(variant.keys.projects)]
        .map(project => project.toLowerCase())
    );
  }

  private evictOldestVariants(): void {
    while (this.variants.size > this.maxVariants) {
      let oldestId: string | null = null;
      let oldestEpoch = Number.POSITIVE_INFINITY;
      for (const [variantId, variant] of this.variants) {
        if (variant.learnedAtEpochMs < oldestEpoch) {
          oldestEpoch = variant.learnedAtEpochMs;
          oldestId = variantId;
        }
      }
      if (oldestId === null) return;
      const evicted = this.variants.get(oldestId)!;
      this.variants.delete(oldestId);
      this.pendingVariantIds.delete(oldestId);
      // An unrefreshed file would be served stale; remove it with its index entry.
      this.removeFile(evicted.keys);
    }
  }

  private removeOrphanedFiles(): void {
    for (const fileName of listContextCacheFiles()) {
      const variantId = fileName.replace(/\.json$/, '');
      if (this.variants.has(variantId)) continue;
      try {
        unlinkSync(join(contextCacheDir(), fileName));
      } catch (error) {
        logger.warn('CONTEXT_CACHE', 'Failed to remove an orphaned cached context block', { fileName },
          error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private indexPath(): string {
    return join(contextCacheDir(), CONTEXT_CACHE_INDEX_FILENAME);
  }

  private readIndex(): PersistedVariantIndex {
    const indexPath = this.indexPath();
    if (!existsSync(indexPath)) return { variants: [] };
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as Partial<PersistedVariantIndex>;
      const variants = Array.isArray(parsed.variants) ? parsed.variants : [];
      return {
        variants: variants.filter(entry =>
          entry && Array.isArray(entry.keys?.projects) && typeof entry.keys.platformSource === 'string'
          && typeof entry.keys.colors === 'boolean' && typeof entry.learnedAtEpochMs === 'number'
          && (entry.keys.cwd === undefined || typeof entry.keys.cwd === 'string')),
      };
    } catch (error) {
      // Variants are re-learned from the next live requests; orphaned files are removed in start().
      logger.warn('CONTEXT_CACHE', 'Context cache index unreadable; starting with no known variants', { indexPath },
        error instanceof Error ? error : new Error(String(error)));
      return { variants: [] };
    }
  }

  private writeIndex(): void {
    const index: PersistedVariantIndex = {
      variants: [...this.variants.values()].map(variant => ({
        keys: variant.keys,
        learnedAtEpochMs: variant.learnedAtEpochMs,
      })),
    };
    try {
      writeJsonFileAtomic(this.indexPath(), index);
    } catch (error) {
      logger.error('CONTEXT_CACHE', 'Failed to write the context cache index', { indexPath: this.indexPath() },
        error instanceof Error ? error : new Error(String(error)));
    }
  }
}
