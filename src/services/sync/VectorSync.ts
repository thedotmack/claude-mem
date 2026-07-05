export interface VectorSearchMetadata {
  [key: string]: unknown;
}

export interface VectorSearchResult {
  ids: number[];
  distances: number[];
  metadatas: VectorSearchMetadata[];
}

export interface VectorSync {
  queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, unknown>
  ): Promise<VectorSearchResult>;
  syncObservation(
    obsId: number,
    memorySessionId: string,
    project: string,
    observation: {
      type: string;
      title?: string | null;
      subtitle?: string | null;
      facts?: string[];
      narrative?: string | null;
      concepts?: string[];
      files_read?: string[];
      files_modified?: string[];
    },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string | null
  ): Promise<void>;
  syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string | null
  ): Promise<void>;
  syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string | null
  ): Promise<void>;
}
