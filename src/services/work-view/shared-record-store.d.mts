import type { Database } from 'bun:sqlite';
export interface SharedRecord {
  kind: string; key: string; value: unknown; deleted: boolean; revision: string;
  writer: string; hash: string; batchId: string; base: string | null;
  valueHash: string;
}
export interface SharedRecordState {
  records: Map<string, SharedRecord>;
  /** All complete highest-revision candidates, including losing concurrent heads. */
  heads: Map<string, SharedRecord[]>;
  history?: Map<string, SharedRecord[]>;
  revision: string;
  diagnostics: { pending: number; invalid: number; unsupported: number; conflicts: Array<{ kind: string; key: string; revision: string; writers: string[] }> };
}
export type SharedValueValidator = (kind: string, key: string, value: unknown, deleted: boolean, writer?: string) => boolean;
export interface SharedWorkRow {
  list_name: string; fields: string | Record<string, unknown>; origin_device_id?: string | null;
  origin_local_id?: string | number | null; id?: string | number;
}
export function readSharedRecords(db: Database, options: { deviceId: string; validateValue?: SharedValueValidator; rows?: SharedWorkRow[]; includeHistory?: boolean }): SharedRecordState;
export function publishSharedRecords(db: Database, options: {
  deviceId: string; project: string;
  updates: Array<{ kind: string; key: string; value?: unknown; deleted?: boolean; expectedHash?: string | null }>;
  now?: number;
  validateValue?: SharedValueValidator;
  /** A reader from createSharedRecordReader for this database, deviceId and validateValue; any other throws. */
  reader?: SharedRecordReader;
}): { changed: number; rowIds: number[]; batchId: string | null };
export type SharedRecordReader = () => SharedRecordState;
export function createSharedRecordReader(db: Database, options: { deviceId: string; validateValue?: SharedValueValidator; includeHistory?: boolean }): SharedRecordReader;
/** count:highest id:summed sync_rev of the work_state_entries rows matching the SQL condition `where`. */
export function workStateRowsRevision(db: Database, options?: { where?: string; syncRev?: boolean }): string;
