// SPDX-License-Identifier: Apache-2.0

export type ExternalMemoryKind = 'observation' | 'summary';

export interface ExternalMemoryWriteResult {
  id: number;
  createdAtEpoch: number;
}

export interface ExternalMemoryCacheItem {
  id: number;
  project: string;
  kind: ExternalMemoryKind;
  content: string;
  createdAtEpoch: number;
}

export interface ExternalObservationInput {
  sqliteId?: number | null;
  memorySessionId: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  promptNumber?: number | null;
  discoveryTokens?: number;
  createdAtEpoch: number;
  embedding?: number[] | null;
  metadata?: Record<string, unknown>;
}

export interface ExternalSummaryInput {
  sqliteId?: number | null;
  memorySessionId: string;
  project: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
  notes: string | null;
  promptNumber?: number | null;
  discoveryTokens?: number;
  createdAtEpoch: number;
  embedding?: number[] | null;
  metadata?: Record<string, unknown>;
}

export interface ExternalMemorySearchResult {
  id: number;
  content: string;
  createdAtEpoch: number;
}
