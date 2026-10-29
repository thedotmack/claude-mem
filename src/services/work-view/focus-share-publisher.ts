/**
 * Keeps every shared focus page current from this worker, whether or not My Work is open (R17.3). Each round reads
 * the work view once, maps it the way the viewer does (src/ui/my-work/src/live/to-work-model.ts), turns each shared
 * area into its page (to-shared-focus.ts) and publishes it. FocusShares skips pages that have not changed, so a
 * quiet area sends nothing.
 */
import { toSharedFocusPage, type SharedFocusPage } from '../../ui/my-work/src/live/to-shared-focus.ts';
import { toWorkModel } from '../../ui/my-work/src/live/to-work-model.ts';
import type { WorkViewSnapshot } from './data-source.mjs';
import { FocusShareError, type FocusShareEntry, type FocusShares } from './focus-share.js';

/** How often the worker republishes shared pages. */
export const FOCUS_SHARE_PUBLISH_EVERY_MS = 30_000;
export const NOT_SHAREABLE = 'This area can’t be shared: share a kept or done focus area.';
const LOCAL_WORK_UNAVAILABLE = 'Your local work couldn’t be read, so the page wasn’t updated.';

type ViewerSnapshot = Parameters<typeof toWorkModel>[0];

/** The shared page for one area of a work view snapshot. Null when the area cannot be shared. */
export function sharedFocusPageFrom(snapshot: WorkViewSnapshot, focusAreaId: string, now: number): SharedFocusPage | null {
  return toSharedFocusPage(toWorkModel(snapshot as unknown as ViewerSnapshot, now), focusAreaId, now);
}

export interface FocusSharePublisherOptions {
  shares: Pick<FocusShares, 'connected' | 'list' | 'publish'>;
  /** The work view as My Work would read it. */
  snapshot: () => WorkViewSnapshot;
  everyMs?: number;
  now?: () => number;
}

export class FocusSharePublisher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private round: Promise<void> | null = null;
  /** Why the last publish of an area failed, by area id. */
  private readonly errors = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: FocusSharePublisherOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    const everyMs = this.options.everyMs ?? FOCUS_SHARE_PUBLISH_EVERY_MS;
    if (this.timer || everyMs <= 0) return;
    this.timer = setInterval(() => { void this.publishAll(); }, everyMs);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  errorFor(focusAreaId: string): string | null {
    return this.errors.get(focusAreaId) ?? null;
  }

  /** Shares an area (first call) or publishes its page now, built from the current work view. */
  async publishArea(focusAreaId: string): Promise<{ entry: FocusShareEntry; sent: boolean }> {
    const page = sharedFocusPageFrom(this.readSnapshot(), focusAreaId, this.now());
    if (!page) throw new FocusShareError(NOT_SHAREABLE, 409);
    try {
      const published = await this.options.shares.publish(focusAreaId, page);
      this.errors.delete(focusAreaId);
      return published;
    } catch (error) {
      this.remember(focusAreaId, error);
      throw error;
    }
  }

  /** One round over every shared area. A round already running is joined, not doubled. */
  publishAll(): Promise<void> {
    this.round ??= this.runRound().finally(() => { this.round = null; });
    return this.round;
  }

  private async runRound(): Promise<void> {
    const { shares } = this.options;
    const ids = Object.keys(shares.list());
    if (!ids.length || !shares.connected()) return;
    let snapshot: WorkViewSnapshot;
    try {
      snapshot = this.readSnapshot();
    } catch {
      for (const id of ids) this.errors.set(id, LOCAL_WORK_UNAVAILABLE);
      return;
    }
    const now = this.now();
    let model: ReturnType<typeof toWorkModel>;
    try {
      model = toWorkModel(snapshot as unknown as ViewerSnapshot, now);
    } catch {
      for (const id of ids) this.errors.set(id, LOCAL_WORK_UNAVAILABLE);
      return;
    }
    for (const id of ids) {
      const page = toSharedFocusPage(model, id, now);
      if (!page) { this.errors.set(id, `${NOT_SHAREABLE} The page shows what it had before.`); continue; }
      try {
        await shares.publish(id, page);
        this.errors.delete(id);
      } catch (error) {
        this.remember(id, error);
      }
    }
  }

  private readSnapshot(): WorkViewSnapshot {
    const snapshot = this.options.snapshot();
    if (snapshot.source?.connected !== true) throw new FocusShareError(LOCAL_WORK_UNAVAILABLE, 503);
    return snapshot;
  }

  /** A link stopped elsewhere is forgotten by FocusShares, so its error goes with it. */
  private remember(focusAreaId: string, error: unknown): void {
    if (error instanceof FocusShareError && error.status === 410) this.errors.delete(focusAreaId);
    else this.errors.set(focusAreaId, error instanceof Error ? error.message : String(error));
  }
}
