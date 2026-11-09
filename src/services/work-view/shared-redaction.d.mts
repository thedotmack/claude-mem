import type { Database } from 'bun:sqlite';
export interface SharedRedactionReceipt { stored_fields_hash: string; original_ref_json: string }
export function assertSharedMetadataRedactionSafe(fields: Record<string, unknown>, project?: string): void;
export function redactSharedInboundRow(row: { id?: string | number; project?: string; list_name: string; fields: string | Record<string, unknown>; origin_device_id?: string | null; origin_local_id?: string | number; sync_rev?: string }, localDeviceId: string): { fields: string; receipt: SharedRedactionReceipt | null } | null;
export function saveSharedRedactionReceipt(db: Database, row: { id: string | number; origin_device_id: string; origin_local_id: string; sync_rev: string }, receipt: SharedRedactionReceipt | null): void;
export function readSharedRedactionReceipts(db: Database): Map<string, Record<string, unknown>>;
export function redactSharedValue<T>(value: T): T;
