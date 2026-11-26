// Node consumable boundary. The rich record codecs keep their native wire fields.
export interface CloudWorkDocument {
  id: string;
  kind: 'prompt' | 'observation' | 'summary' | 'work_state';
  numeric_id: number;
  session_db_id: number | null;
  origin_device_id: string;
  origin_local_id: string;
  entity_rev: string;
  project: string;
  merged_into_project: string | null;
  memory_session_id: string;
  content_session_id: string;
  platform_source: string;
  created_at: string;
  created_at_epoch: number;
  payload: Record<string, unknown>;
}
export interface SharedRecord {
  kind: string; key: string; value: unknown; deleted: boolean; revision: string;
  writer: string; hash: string; batchId: string; base: string | null; valueHash: string;
}
export interface BatchDiagnostics { pending: number; invalid: number; unsupported: number }
export interface SharedWorkRow {
  id: number; list_name: string; fields: string | Record<string, unknown>;
  origin_device_id: string; origin_local_id: string; sync_rev?: string;
}
export function foldCloudBatch(rows: SharedWorkRow[]): BatchDiagnostics & {
  members: Array<SharedRecord & { sourceId: number }>;
};
export interface RenderInput {
  now: number; revision: string; documents?: CloudWorkDocument[];
  sessions?: { id: number; platform_source: string; content_session_id: string }[];
  sharedHeads?: SharedRecord[]; diagnostics?: Partial<BatchDiagnostics>;
}
type JsonRecord = Record<string, unknown>;
interface RequestModel extends JsonRecord { id: string; contentFingerprint: string; detailRevision: string }
export function renderCloudWorkView(input: RenderInput): {
  overview: { version: 1; revision: string; agentQuietAt: Record<string, number>; generatedAt: string; source: JsonRecord; model: JsonRecord & { requests: RequestModel[] } };
  details: { id: string; detail: { version: 1; revision: string; request: RequestModel } }[];
  editContext: JsonRecord & { revision: string; project: string };
  evidence: { kind: string; id: number; value: unknown }[];
};

type RowFields = Record<string, string | number | boolean | null>;
interface SharedEntryFields {
  version: 1; record: 'entry'; batch: string; writer: string; kind: string; key: string;
  revision: string; base: string | null; deleted: boolean; payload: string; hash: string;
}
export function createSharedEntry(input: {
  batchId: string; writer: string; kind: string; key: string; revision: string;
  base?: string | null; value: unknown; deleted?: boolean;
}): SharedEntryFields;
export function createSharedBatch(entries: SharedEntryFields[], options: { batchId: string; writer: string }):
  Array<{ listName: string; fields: RowFields }>;
export function isSharedProjectionValue(kind: string, key: string, value: unknown, deleted?: boolean, writer?: string): boolean;
export function isSharedReviewValue(kind: string, key: string, value: unknown, deleted?: boolean): boolean;

interface FocusArea {
  focusAreaId: string; name: string; goal: string | null; about?: string | null;
  status: 'suggested' | 'kept' | 'dismissed' | 'done';
  source: 'owner-goals' | 'clustering' | 'promotion' | 'seed' | 'owner';
  decidedBy: 'owner' | 'system' | 'owner-restore'; priorityRank: number | null; ownerRank: number | null;
  mergedInto: string | null; evidence: string | null;
}
export function focusAreaRowFields(area: FocusArea): RowFields;
export function placementRowFields(placement: {
  anchorConversationKey: string; focusAreaId: string; placedBy: 'router' | 'owner';
  confidence?: number | null; basis?: string | null; evidence?: string | null;
}): RowFields;
type VersionArea = Omit<FocusArea, 'focusAreaId' | 'decidedBy' | 'evidence'> & ({ id: string } | { focusAreaId: string });
export function focusChangeVersion(change: { action: string; focusAreaId?: string; requestId?: string },
  areas: readonly VersionArea[], requests: readonly { id: string; focusAreaId?: string }[]): string | null;
export function navWordIn(name: string): string | null;
export function ruleRowFields(rule: {
  ruleId: string; scopeTier: 'everywhere' | 'project' | 'situation'; scopeName: string;
  when: string; then: string; setBy: 'owner' | 'approved' | 'learned'; status: 'on' | 'off' | 'suggested' | 'replaced' | 'dismissed';
  source: string; timesSeen: number; latestAt: string | null; replacedBy: string | null; replacedAt: string | null;
  quotes: { at: string | null; quote: string; kind: string }[]; quotesTotal?: number; quotesOmitted?: number;
}): RowFields;
export function agentStopFields(input: {
  platformSource: string | null; contentSessionId: string; agentId: string; agentType?: string | null;
  stoppedAtEpoch: number; stopSource: 'subagent-stop-hook' | 'owner-marked-finished';
}): RowFields;
export function groupIdFor(anchor: string): string;
export function placeholderTitleFromAsk(ask: string | null | undefined): string;
export function applyGroupDecisions(stored: JsonRecord, decisions: { groups: JsonRecord[]; ignored?: string[] },
  now?: number, options?: { projectOf?: Map<string, string> }): JsonRecord;
export function sharedSuggestionDescriptor(state: {
  records: Map<string, SharedRecord>; heads: Map<string, SharedRecord[]>;
  diagnostics: BatchDiagnostics & { conflicts: Array<{ kind: string; key: string; revision: string; writers: string[] }> };
} | null, conversationKey: string): { hash: string | null; conflict: boolean; groupKeys: string[]; targetId?: string; suggestion?: JsonRecord };
