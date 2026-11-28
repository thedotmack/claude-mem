import type { Database } from 'bun:sqlite';
export interface StagedSharedFile {
  name: string; value: unknown; updates: Array<{ kind: string; key: string; value?: unknown; deleted?: boolean }>;
  changed: { rules: boolean } | null; notified: boolean;
}
/** 'pending': the decision is saved and the file is left for the reconciler, with why (busy database, failed rename). */
export type SharedFileMaterialization = { materialization: 'complete' } | { materialization: 'pending'; reason?: string };
type StageOptions = {
  resolveKeys?: string[]; resolutionBaseline?: unknown;
  /** The hash of the file the value was built from (request-groups.mjs readHashOf): refused when the file changed since. */
  readHash?: string;
};
export class SharedLedgerAdapter {
  constructor(db: Database, options: { directory: string; deviceId: string; project?: string; notify?: (change?: { rules?: boolean }) => void });
  /** Commits the shared records; the returned finish writes the file under the write lock (finishWrite). */
  beforeWrite(name: string, value: unknown, options?: StageOptions): (((options?: { writeFile?: boolean }) => SharedFileMaterialization) & { value?: unknown }) | null;
  /** Never throws: the decision is already saved when it runs. */
  finishWrite(stage: StagedSharedFile, options?: { writeFile?: boolean }): SharedFileMaterialization;
  stageFile(name: string, value: unknown, options?: StageOptions): StagedSharedFile | null;
  materializeFile(stage: StagedSharedFile | null): { materialization: 'complete' | 'pending' };
  pendingMaterialization(): number;
  saveFile(name: string, value: unknown, options?: StageOptions): SharedFileMaterialization;
  publish(updates: Array<{ kind: string; key: string; value?: unknown; deleted?: boolean }>): number;
  /** Whether this database holds a row the activity capture could publish for (a local tool call, deliverable, observation or prompt). */
  ownsActivity(): boolean;
  reconcile(options?: { captureActivity?: boolean }): { pending: number; invalid: number; unsupported: number; conflicts: unknown[]; files: Array<{ file: string; message: string }> };
}
