import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// This sidecar is deliberately separate from the synced memory database.
// Human review acknowledges one version; it never changes agent completion.
export interface LocalReview {
  checked: boolean;
  checkedAtEpoch: number | null;
  actor: 'local-user' | null;
  available: boolean;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function contentFingerprint(request: Record<string, unknown>): string {
  // Omit transport health, clock labels and generated summaries. Only recorded
  // request content invalidates a review. The selected fields include source
  // links and lifecycle evidence as well as the displayed outcome.
  const fields = ['id', 'original', 'explicitRequestText', 'scopeUpdates', 'title', 'projects', 'agentIds', 'items', 'lifecycle', 'afterShip', 'shipEstimate', 'stageSourceText', 'sourceContentHashes'];
  const content = Object.fromEntries(fields.map(key => [key, request[key]]));
  return createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex');
}

export class LocalReviewStore {
  private db: Database | null = null;

  constructor(path: string) {
    // A damaged optional review sidecar must never stop the memory worker.
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path, { create: true });
      this.db.exec('PRAGMA busy_timeout = 1500');
      this.db.exec(`CREATE TABLE IF NOT EXISTS work_view_reviews (
      request_id TEXT PRIMARY KEY,
      content_fingerprint TEXT NOT NULL,
      checked_at_epoch INTEGER NOT NULL,
      actor TEXT NOT NULL CHECK (actor = 'local-user')
      )`);
    } catch {
      try { this.db?.close(); } catch { /* failed optional database */ }
      this.db = null;
    }
  }

  read(requestId: string, fingerprint: string): LocalReview {
    try {
      if (!this.db) throw new Error('Review storage unavailable');
      const row = this.db.prepare('SELECT checked_at_epoch FROM work_view_reviews WHERE request_id = ? AND content_fingerprint = ?').get(requestId, fingerprint) as { checked_at_epoch: number } | null;
      return row
        ? { checked: true, checkedAtEpoch: row.checked_at_epoch, actor: 'local-user', available: true }
        : { checked: false, checkedAtEpoch: null, actor: null, available: true };
    } catch {
      return { checked: false, checkedAtEpoch: null, actor: null, available: false };
    }
  }

  set(requestId: string, fingerprint: string, checked: boolean): void {
    if (!this.db) throw new Error('Local review storage is unavailable. Your source work is unchanged.');
    if (checked) {
      this.db.prepare(`INSERT INTO work_view_reviews (request_id, content_fingerprint, checked_at_epoch, actor)
        VALUES (?, ?, ?, 'local-user') ON CONFLICT(request_id) DO UPDATE SET
        content_fingerprint = excluded.content_fingerprint, checked_at_epoch = excluded.checked_at_epoch, actor = excluded.actor`)
        .run(requestId, fingerprint, Date.now());
    } else {
      this.db.prepare('DELETE FROM work_view_reviews WHERE request_id = ? AND content_fingerprint = ?').run(requestId, fingerprint);
    }
  }

  close(): void { this.db?.close(); }
}
