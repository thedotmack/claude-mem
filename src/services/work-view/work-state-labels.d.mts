import type { LedgerDatabase } from './request-groups.mjs';
import type { JevClient } from './request-judge.mjs';

export const WORK_STATE_LABELS_FILE: string;
/** The states Jev picks from: the keys of JUDGED_WORK_STATES. */
export type JudgedWorkState = 'working' | 'not_started' | 'waiting_on_person' | 'waiting_on_other' | 'finished' | 'abandoned';
export const JUDGED_WORK_STATES: Record<JudgedWorkState, { criterion: string; recordedStatus: string }>;
export const LABEL_THRESHOLD: number;
export const LABEL_CALL_INTERVAL_MS: number;

export interface WorkStateLabel {
  at: string;
  model: string;
  state: JudgedWorkState;
  stateP: number;
  /** The note field that says what is next or what came out; null when Jev picked none or was not asked. */
  nextField: string | null;
  nextP: number | null;
  resultField: string | null;
  resultP: number | null;
  /** Present when the item had more note fields than one choice takes, so the field questions were not asked. */
  fieldsNotAsked?: string;
}
/** Keyed by the item's latest work-state entry id: one label per item version. */
export interface WorkStateLabelsFile { schemaVersion: 1; labels: Record<string, WorkStateLabel>; failures: Record<string, { at: string; error: string }> }
/** serviceFailure: the message when the service refused or failed a call (not a 400); that item counts as not reached. */
export interface LabelRunResult { open: number; labeled: number; removed: number; notReached: number; failed: { entryId: number; at: string; error: string } | null; serviceFailure: string | null }

export function workStateItems(state: any): any[];
export function readWorkStateLabels(dir: string): WorkStateLabelsFile;
export function labelItem(client: JevClient, item: any, now: number): Promise<WorkStateLabel>;
export function labelOpenWorkState(options: { dir: string; database: LedgerDatabase; client: JevClient; now?: () => number; intervalMs?: number; wait?: (ms: number) => Promise<void> }): Promise<LabelRunResult>;
export function appliedLabel(item: { latestEntryId: number; status: string }, labels: Record<string, WorkStateLabel> | null | undefined, threshold?: number): { judgedStatus: string | null; nextField: string | null; resultField: string | null; label: WorkStateLabel | null };
export function judgedStatusFor(recordedStatus: string | null | undefined, judgedState: JudgedWorkState): string | null;
