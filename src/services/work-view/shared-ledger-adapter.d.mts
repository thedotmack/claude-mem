import type { Database } from 'bun:sqlite';
export interface StagedSharedFile {
  name: string; value: unknown; updates: Array<{ kind: string; key: string; value?: unknown; deleted?: boolean }>;
  changed: { rules: boolean } | null; notified: boolean;
}
export class SharedLedgerAdapter {
  constructor(db: Database, options: { directory: string; deviceId: string; project?: string; notify?: (change?: { rules?: boolean }) => void });
  beforeWrite(name: string, value: unknown, options?: { resolveKeys?: string[]; resolutionBaseline?: unknown }): ((() => void) & { value?: unknown }) | null;
  stageFile(name: string, value: unknown, options?: { resolveKeys?: string[]; resolutionBaseline?: unknown }): StagedSharedFile | null;
  materializeFile(stage: StagedSharedFile | null): { materialization: 'complete' | 'pending' };
  pendingMaterialization(): number;
  saveFile(name: string, value: unknown, options?: { resolveKeys?: string[]; resolutionBaseline?: unknown }): void;
  publish(updates: Array<{ kind: string; key: string; value?: unknown; deleted?: boolean }>): number;
  reconcile(options?: { captureActivity?: boolean }): { pending: number; invalid: number; unsupported: number; conflicts: unknown[]; files: Array<{ file: string; message: string }> };
}
