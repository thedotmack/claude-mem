import type { Database } from 'bun:sqlite';
export class SharedLedgerAdapter {
  constructor(db: Database, options: { directory: string; deviceId: string; project?: string; notify?: (change?: { rules?: boolean }) => void });
  beforeWrite(name: string, value: unknown): ((() => void) & { value?: unknown }) | null;
  saveFile(name: string, value: unknown): void;
  publish(updates: Array<{ kind: string; key: string; value?: unknown; deleted?: boolean }>): number;
  reconcile(options?: { captureActivity?: boolean }): { pending: number; invalid: number; unsupported: number; conflicts: unknown[]; files: Array<{ file: string; message: string }> };
}
