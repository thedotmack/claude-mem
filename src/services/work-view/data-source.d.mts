export interface WorkViewRequest extends Record<string, unknown> {
  id: string;
  lifecycle?: { explicit?: boolean; complete?: boolean; status?: string } | null;
  contentFingerprint?: string;
  review?: { checked: boolean; checkedAtEpoch: number | null; actor: 'local-user' | null; available: boolean };
}
export interface WorkViewSnapshot extends Record<string, unknown> {
  revision: number | string;
  source: { connected: boolean; error?: string | null; [key: string]: unknown };
  humanRequests: WorkViewRequest[];
}
export class WorkStateSource {
  localDeviceId: string;
  constructor(options?: { databasePath?: string; currentProject?: string; parentProject?: string; titleCachePath?: string | null; ledgerDir?: string | null; pollIntervalMs?: number; localDeviceId?: string });
  read(): { agentView: WorkViewSnapshot; [key: string]: unknown };
  evidence(kind: string, id: number): Record<string, unknown> | null;
  file(kind: string, id: number, index: number): string | null;
  /** The bucket copy a deliverables row names, while it exists: its path, title and kind; null otherwise. */
  deliverable(id: number): { id: number; title: string; kind: string; path: string } | null;
  close(): void;
}
export function reduceWorkState(entries: Array<Record<string, any>>, options?: Record<string, any>): any;
