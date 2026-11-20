import type { Database } from 'bun:sqlite';
import type { SharedRecordState } from './shared-record-store.mjs';
export type PortableEvidenceRef = { kind: string; conversation?: string; device?: string; row?: string };
export type SharedProjectionDiagnostics = SharedRecordState['diagnostics'] & { membershipConflicts: Array<{
  kind: 'group-membership'; key: string; revision: string; writers: string[]; groups: string[]; selectedGroup: string;
}> };
export function sharedPublishedUrl(value: unknown): string | null;
export function sharedProjectKey(value: unknown): string | null;
export function isSharedProjectionValue(kind: string, key: string, value: unknown, deleted?: boolean, writer?: string): boolean;
export function stableEvidenceRef(database: Database, kind: string, id: unknown, deviceId: string): PortableEvidenceRef | null;
export function resolveEvidenceRef(database: Database, ref: PortableEvidenceRef, deviceId: string): number | null;
export function portableWorkValue(database: Database, value: unknown, deviceId: string): any;
export function localWorkValue(database: Database, value: unknown, deviceId: string): any;
export function buildSharedProjectionUpdates(database: Database, options: {
  ledger?: any; records?: any; view?: any; deviceId: string; copyEntries?: Map<string, any> | Record<string, any>;
}): Array<{ kind: string; key: string; value: any }>;
export function applySharedProjection(database: Database, shared: SharedRecordState | null, options?: {
  ledger?: any; records?: any; deviceId?: string;
}): { ledger: any; records: any; copyEntries: Map<string, any>; diagnostics: SharedProjectionDiagnostics };
export function decorateSharedView<T>(view: T, options?: { database?: Database; deviceId?: string; records?: any; copyEntries?: Map<string, any> }): T;
