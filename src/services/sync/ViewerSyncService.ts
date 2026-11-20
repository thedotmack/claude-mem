import type { CloudSync, CloudSyncStatus } from './CloudSync.js';
import type { SyncClient } from './SyncClient.js';
import { onContextInvalidation } from '../../shared/context-invalidation.js';
import { composeViewerSyncStatus, type ViewerSyncStatus } from '../../shared/viewer-sync-status.js';

type Cloud = Pick<CloudSync, 'status' | 'statusWithHubProbe' | 'historicalExcludedCount'>;

/** One shared observational probe, never a slow probe in the one-second view read. */
export class ViewerSyncService {
  private cached: CloudSyncStatus | null = null;
  private excluded: number | null = null;
  private refreshStartedAt: number | null = null;
  private refreshing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private signature = '';
  private closed = false;
  private localDirty = true;
  private localCheckedAt: number | null = null;
  private readonly unsubscribe = onContextInvalidation(() => { this.localDirty = true; });

  constructor(private readonly options: {
    cloud: () => Cloud | null;
    pull: () => Pick<SyncClient, 'status'> | null;
    hasViewers?: () => boolean;
    onChange?: (value: ViewerSyncStatus) => void;
    now?: () => number;
    refreshMs?: number;
  }) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      if (this.options.hasViewers?.()) this.publish();
    }, 5_000);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot(): ViewerSyncStatus {
    void this.refresh();
    const now = this.now();
    if (!this.closed && (this.localDirty || this.localCheckedAt === null || now < this.localCheckedAt || now - this.localCheckedAt >= 5000)) {
      this.cached = this.options.cloud()?.status() ?? null;
      this.localCheckedAt = now;
      this.localDirty = false;
    }
    let download = null;
    try { download = this.options.pull()?.status() ?? null; } catch { /* A closed/unreadable local cursor is unknown, never current. */ }
    return composeViewerSyncStatus(this.cached, download, this.excluded, this.now());
  }

  async statusWithProbe(): Promise<CloudSyncStatus & { sync: ViewerSyncStatus } | { configured: false }> {
    await this.refresh(true);
    // getSnapshot can observe a commit that arrived during the probe. Compose
    // first, then copy that same local state into the legacy response fields.
    const sync = this.getSnapshot();
    return this.cached ? { ...this.cached, sync } : { configured: false };
  }

  private publish(): void {
    const value = this.getSnapshot();
    const signature = JSON.stringify({ ...value, observedAt: 0 });
    if (signature === this.signature) return;
    this.signature = signature;
    try { this.options.onChange?.(value); } catch { /* Diagnostic delivery must not fail sync. */ }
  }

  private refresh(force = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const now = this.now();
    if (!force && this.refreshStartedAt !== null && now >= this.refreshStartedAt && now - this.refreshStartedAt < (this.options.refreshMs ?? 30_000)) return Promise.resolve();
    this.refreshStartedAt = now;
    const cloud = this.options.cloud();
    if (!cloud) { this.cached = null; this.excluded = null; return Promise.resolve(); }
    this.cached = cloud.status();
    // Inventory runs in its own read-only worker and must never hold up a
    // status response or get ahead of the projection reader's first request.
    void cloud.historicalExcludedCount(now).then(count => {
      if (this.closed || this.options.cloud() !== cloud) return;
      this.excluded = count;
      this.publish();
    }).catch(() => { /* Unknown scope remains explicit until the next inventory. */ });
    this.refreshing = cloud.statusWithHubProbe().then(status => {
      if (this.closed || this.options.cloud() !== cloud) return;
      // A viewer may have already consumed a local invalidation while this
      // network probe was pending. Only its hub evidence is safe to reuse.
      this.cached = { ...cloud.status(), hub: status.hub };
    }).catch(() => {
      // CloudSync retains its sanitized observational error. Do not mutate its retry state here.
      if (!this.closed && this.options.cloud() === cloud) this.cached = cloud.status();
    }).finally(() => {
      this.refreshing = null;
      if (!this.closed) this.publish();
    });
    return this.refreshing;
  }
}

export const VIEWER_ACTIVITY_TTL_MS = 45_000;

/** Bounded per-tab leases, including short-lived invisible tombstones for reordered POSTs. */
export class ViewerActivity {
  private readonly leases = new Map<string, { sequence: number; visible: boolean; expiresAt: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  constructor(private readonly changed: (active: boolean) => void, private readonly now = () => performance.now(), private readonly leaseMs = VIEWER_ACTIVITY_TTL_MS) {}

  update(viewerId: string, visible: boolean, sequence: number): boolean {
    this.prune();
    const current = this.leases.get(viewerId);
    if (current && sequence <= current.sequence) return true;
    if (!current && this.leases.size >= 256) return false;
    this.leases.set(viewerId, { sequence, visible, expiresAt: this.now() + this.leaseMs });
    this.reconcile();
    return true;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.leases.clear();
    if (this.active) this.changed(false);
    this.active = false;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
  }

  private reconcile(): void {
    this.prune();
    const active = [...this.leases.values()].some(lease => lease.visible);
    if (active !== this.active) { this.active = active; this.changed(active); }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.leases.size) {
      const next = Math.min(...[...this.leases.values()].map(lease => lease.expiresAt));
      this.timer = setTimeout(() => this.reconcile(), Math.max(1, next - this.now()));
      this.timer.unref?.();
    }
  }
}
