export const SHARED_WORK_PREFIX: string;
export const SHARED_WORK_VERSION: 1;
export const SHARED_WORK_MAX_VALUE_BYTES: number;
export const SHARED_WORK_MAX_MANIFEST_BYTES: number;
export const SHARED_WORK_MAX_ROW_BYTES: number;
export const SHARED_WORK_MAX_UPDATES: number;
export const SHARED_WORK_MAX_PARTS: number;
export function isSharedWorkList(value: unknown): boolean;
export function sharedRecordKey(kind: string, key: string): string;
export function sharedIdentity(kind: string, key: string): string;
export function sharedWriter(value: string): string;
export function sharedValueHash(kind: string, key: string, value: unknown, deleted?: boolean): string;
export interface SharedEntryFields {
  version: 1; record: 'entry'; batch: string; writer: string; kind: string; key: string;
  revision: string; base: string | null; deleted: boolean; payload: string; hash: string;
}
export function createSharedEntry(input: {
  batchId: string; writer: string; kind: string; key: string; revision: string;
  base?: string | null; value: unknown; deleted?: boolean;
}): SharedEntryFields;
export function sharedEntryRef(entry: SharedEntryFields): { kind: string; key: string; revision: string; hash: string; entryHash: string };
export function createSharedBatch(entries: SharedEntryFields[], options: { batchId: string; writer: string }): Array<{ listName: string; fields: Record<string, string | number | boolean | null> }>;
export function parseSharedRow(row: { id?: string | number; list_name: string; fields: string | Record<string, unknown>; origin_device_id?: string | null; origin_local_id?: string | number; sync_rev?: string }, localDeviceId: string, options?: { redactionReceipt?: Record<string, unknown> | null }): unknown;
