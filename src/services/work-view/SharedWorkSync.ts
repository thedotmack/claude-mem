import type { Database } from 'bun:sqlite';
import type { Worker } from 'node:worker_threads';
import { createWorkViewReadWorker } from './WorkViewReadWorkerClient.js';
import { SharedLedgerAdapter } from './shared-ledger-adapter.mjs';
import { registerSharedFileWriter } from './shared-file-hooks.mjs';
import { emitContextInvalidation } from '../../shared/context-invalidation.js';
import { MY_RULES_LIST } from './my-rules.mjs';
import { publishSharedReview, getSharedReviews, sharedSuggestionDescriptor, type SharedReviewDescriptor } from './shared-reviews.mjs';
import { decideSuggestion } from './request-judge.mjs';
import { applySharedProjection, localWorkValue } from './shared-projection.mjs';
import { sharedRecordKey } from './shared-records.mjs';
import { groupIdFor } from './request-groups.mjs';

type SharedOptions = { databasePath: string; directory: string; deviceId: string; notify: () => void; intervalMs?: number; enabled?: boolean };

/** Owns local compatibility writers and a separate background import/capture worker. */
export class SharedWorkSync {
  private readonly adapter: SharedLedgerAdapter | null;
  private worker: Worker | null = null;
  private pending: Promise<void> | null = null;
  private finish: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopWriter: (() => void) | null = null;
  private closed = false;
  private diagnostic: unknown = null;

  constructor(private readonly db: Database, private readonly options: SharedOptions) {
    this.adapter = options.enabled === true
      ? new SharedLedgerAdapter(db, { directory: options.directory, deviceId: options.deviceId, notify: change => this.changed(change?.rules) }) : null;
  }

  start(): void {
    if (!this.adapter || this.stopWriter || this.closed) return;
    const adapter = this.adapter;
    this.stopWriter = registerSharedFileWriter(this.options.directory, (name, value) => adapter.beforeWrite(name, value));
    const interval = this.options.intervalMs ?? 5_000;
    this.timer = setInterval(() => { void this.reconcile(); }, interval);
    this.timer.unref?.();
    void this.reconcile();
  }

  saveFile(name: string, value: unknown): void {
    if (!this.adapter) throw new Error('Shared My Work state is not enabled.');
    this.adapter.saveFile(name, value);
  }

  persistCopy(requestId: string, entry: unknown): void {
    if (!this.adapter) throw new Error('Shared My Work state is not enabled.');
    this.adapter.publish([{ kind: 'copy', key: requestId, value: entry }]);
  }

  saveReview(input: { descriptor: SharedReviewDescriptor; checked: boolean; expectedHash: string | null }): { changed: number } {
    if (!this.adapter) throw new Error('Shared My Work state is not enabled.');
    const result = publishSharedReview(this.db, { ...input, deviceId: this.options.deviceId, project: '__my_work__' });
    if (result.changed) this.changed();
    return result;
  }

  /** Settle compatibility files before an owner decision; never read stale file bytes as authority. */
  async prepareOwnerAction(): Promise<void> {
    if (!this.adapter) return;
    await this.reconcile();
    const diagnostic = this.adapter.reconcile({ captureActivity: false });
    if (diagnostic.files?.length) throw new Error('Shared My Work has a conflicting local file; reload after resolving it.');
  }

  answerSuggestion(conversationKey: string, action: 'join' | 'not-this', expectedHash: string | null): unknown {
    if (!this.adapter) throw new Error('Shared My Work state is not enabled.');
    const adapter = this.adapter;
    let staged: ReturnType<SharedLedgerAdapter['stageFile']> = null;
    const outcome = this.db.transaction(() => {
      const shared = getSharedReviews(this.db, this.options.deviceId, { includeHistory: true });
      const descriptor = sharedSuggestionDescriptor(shared, conversationKey);
      if (!descriptor.hash || descriptor.hash !== expectedHash) throw new Error('Shared My Work: changed since read');
      const ledger = applySharedProjection(this.db, shared, { deviceId: this.options.deviceId }).ledger;
      if (descriptor.conflict && descriptor.targetId) {
        const targetKey = sharedRecordKey('group', descriptor.targetId);
        const target = shared.records.get(targetKey);
        if (!target || target.deleted) {
          const live = shared.heads.get(targetKey)?.find(head => !head.deleted && (head.value as any)?.suggestions?.[conversationKey]);
          if (!live) throw new Error('Shared My Work: conflicting target is unavailable');
          const restored = { ...shared, records: new Map(shared.records).set(targetKey, live) };
          Object.assign(ledger, applySharedProjection(this.db, restored, { deviceId: this.options.deviceId }).ledger);
        }
        // A joined winner may have tombstoned the candidate's own request.
        // Recover its last complete metadata and members still in that target;
        // preserve any member independently moved to another current group.
        const ownId = groupIdFor(conversationKey);
        const ownHistory = shared.history?.get(sharedRecordKey('group', ownId)) ?? [];
        const priorOwn = [...ownHistory].reverse().find(record => !record.deleted && (record.value as any)?.group?.anchor === conversationKey);
        if (priorOwn && ownId !== descriptor.targetId) {
          const value = localWorkValue(this.db, priorOwn.value, this.options.deviceId) as any;
          const restoredMembers = (value.members as string[]).filter(member => member === conversationKey
            || !ledger.groups.conversations[member] || [ownId, descriptor.targetId].includes(ledger.groups.conversations[member]));
          const members = new Set(restoredMembers);
          ledger.groups.groups[ownId] = { ...value.group, links: (value.group.links ?? []).filter((link: any) => link.conversations.every((member: string) => members.has(member))) };
          for (const member of restoredMembers) ledger.groups.conversations[member] = ownId;
          for (const [id, group] of Object.entries(ledger.groups.groups) as Array<[string, any]>) if (id !== ownId && descriptor.groupKeys.includes(id)) {
            group.links = (group.links ?? []).filter((link: any) => !link.conversations.some((member: string) => members.has(member)));
          }
        }
      }
      const resolutionBaseline = descriptor.conflict ? structuredClone(ledger.groups) : undefined;
      return decideSuggestion({ dir: this.options.directory, database: this.db, conversationKey, action,
        ledger, ...(descriptor.conflict ? { resolution: { suggestion: descriptor.suggestion, groupKeys: descriptor.groupKeys } } : {}),
        writeGroups: (value: unknown) => { staged = adapter.stageFile('request-groups.json', value, { resolveKeys: descriptor.conflict ? descriptor.groupKeys : [], resolutionBaseline }); } });
    })();
    // Only the outer transaction establishes durability. A released nested
    // savepoint can still be rolled back by a deferred constraint at COMMIT.
    if (!outcome) return outcome;
    return { ...outcome, ...adapter.materializeFile(staged) };
  }

  status(): Record<string, unknown> {
    return { ...(this.diagnostic && typeof this.diagnostic === 'object' ? this.diagnostic : {}), enabled: this.adapter !== null,
      ...(this.adapter?.pendingMaterialization() ? { pendingLocalMaterialization: true } : {}) };
  }

  reconcile(): Promise<void> {
    if (!this.adapter || this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = new Promise(resolve => { this.finish = resolve; });
    try {
      const worker = this.worker ?? createWorkViewReadWorker({ kind: 'shared-work-sync', databasePath: this.options.databasePath,
        directory: this.options.directory, deviceId: this.options.deviceId });
      if (!this.worker) {
        this.worker = worker;
        worker.on('message', (reply: { changed?: boolean; rulesChanged?: boolean; diagnostic?: unknown }) => {
          if (this.worker !== worker) return;
          this.diagnostic = reply.diagnostic ?? null;
          if (reply.changed) this.changed(reply.rulesChanged);
          worker.unref();
          this.settle();
        });
        worker.on('error', () => this.failed(worker));
        worker.on('exit', () => this.failed(worker));
      }
      worker.ref();
      worker.postMessage('reconcile');
    } catch { this.settle(); }
    return this.pending ?? Promise.resolve();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.stopWriter?.();
    const worker = this.worker;
    this.worker = null;
    this.settle();
    if (worker) void worker.terminate();
  }

  private changed(rules = false): void {
    this.options.notify();
    emitContextInvalidation('all', 'SharedWorkSync.changed', 'additive', { kinds: ['work_state'], workStateLists: ['__my_work_v1:records', ...(rules ? [MY_RULES_LIST] : [])] });
  }

  private settle(): void {
    const finish = this.finish;
    this.finish = null; this.pending = null;
    finish?.();
    // The periodic check handles external/Python writers and avoids a capture
    // feedback loop from its own SQLite commits. One in-flight pass at a time.
  }

  private failed(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.diagnostic = { error: 'Shared work could not be refreshed; retrying.' };
    this.settle();
    void worker.terminate();
  }
}
