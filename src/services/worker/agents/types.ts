import type { MediaManifest } from '../../../shared/media-contract.js';

export interface WorkerRef {
  sseBroadcaster?: {
    broadcast(event: SSEEventPayload): void;
  };
  broadcastProcessingStatus?: () => void;
  recordAiInteraction?: (result: { success: boolean; error?: string; provider: string }) => void;
}

export interface ObservationSSEPayload {
  id: number;
  memory_session_id: string | null;
  session_id: string;
  content_session_id: string;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string;  
  concepts: string;  
  files_read: string;  
  files_modified: string;  
  project: string;
  prompt_number: number;
  created_at_epoch: number;
  /** Validated media refs, identical to the paged/by-id feeds; absent for image-free rows. */
  media?: MediaManifest;
}

export interface SummarySSEPayload {
  id: number;
  session_id: string;
  platform_source: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  project: string;
  prompt_number: number;
  created_at_epoch: number;
}

export type SSEEventPayload =
  | { type: 'new_observation'; observation: ObservationSSEPayload }
  | { type: 'new_summary'; summary: SummarySSEPayload };

export interface StorageResult {
  observationIds: number[];
  /**
   * Parallel to observationIds: true where a Tier-0 dedup merge (#3038) reused
   * an existing row instead of storing a new one. Absent = nothing merged.
   */
  mergedIntoExisting?: boolean[];
  /** The ids this turn actually inserted (no duplicates or Tier-0 merges of earlier rows). */
  insertedObservationIds?: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}
