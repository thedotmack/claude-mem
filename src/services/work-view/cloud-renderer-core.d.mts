import type { SharedRecord, SharedWorkRow } from './shared-record-store.mjs';
import type { WorkViewOverview, WorkViewRequestDetail } from '../../ui/my-work/src/live/work-view-overview.js';

export interface CloudWorkDocument {
  id: string; kind: 'prompt' | 'observation' | 'summary' | 'work_state';
  numeric_id: number; session_db_id: number | null; origin_device_id: string; origin_local_id: string;
  entity_rev: string; project: string; merged_into_project: string | null; memory_session_id: string;
  content_session_id: string; platform_source: string; created_at: string; created_at_epoch: number;
  payload: Record<string, unknown>;
}
export interface BatchDiagnostics { pending: number; invalid: number; unsupported: number }
export function foldCloudBatch(rows: (SharedWorkRow & { id: number })[]): BatchDiagnostics & { members: (SharedRecord & { sourceId: number })[] };
export function renderCloudWorkView(input: { now: number; revision: string; documents?: CloudWorkDocument[];
  sessions?: { id: number; platform_source: string; content_session_id: string }[];
  sharedHeads?: SharedRecord[]; diagnostics?: Partial<BatchDiagnostics> }): {
  overview: WorkViewOverview & { agentQuietAt: Record<string, number> }; details: { id: string; detail: WorkViewRequestDetail }[];
  editContext: Record<string, unknown>; evidence: { kind: string; id: number; value: unknown }[];
};
export { applyGroupDecisions } from './request-groups.mjs';
