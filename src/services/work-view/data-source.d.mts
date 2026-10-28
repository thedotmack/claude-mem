export interface WorkViewRequest extends Record<string, unknown> {
  id: string;
  lifecycle?: { explicit?: boolean; complete?: boolean; status?: string } | null;
  contentFingerprint?: string;
  review?: { checked: boolean; checkedAtEpoch: number | null; actor: 'local-user' | null; available: boolean };
  /** The conversation its my-focus placement is keyed by (my-focus.mjs placeRequests). */
  anchorConversationKey?: string | null;
}
export interface WorkViewSnapshot extends Record<string, unknown> {
  revision: number | string;
  source: { connected: boolean; error?: string | null; [key: string]: unknown };
  humanRequests: WorkViewRequest[];
  /** The judge's open suggestions (request-groups.mjs openSuggestions); each is also on its conversation's request as `suggestion`. */
  suggestions?: import('./request-groups.mjs').RequestSuggestion[];
}
export class WorkStateSource {
  localDeviceId: string;
  constructor(options?: { databasePath?: string; currentProject?: string; parentProject?: string; titleCachePath?: string | null; ledgerDir?: string | null; pollIntervalMs?: number; localDeviceId?: string });
  read(options?: { maxActivityAgeMs?: number }): { agentView: WorkViewSnapshot; [key: string]: unknown };
  evidence(kind: string, id: number): Record<string, unknown> | null;
  file(kind: string, id: number, index: number): string | null;
  /** The bucket copy a deliverables row names, while it exists: its path, title and kind; null otherwise. */
  deliverable(id: number): { id: number; title: string; kind: string; path: string } | null;
  close(): void;
}
export function reduceWorkState(entries: Array<Record<string, any>>, options?: Record<string, any>): any;
export { readFocus, readFocusAreas } from './my-focus.mjs';
