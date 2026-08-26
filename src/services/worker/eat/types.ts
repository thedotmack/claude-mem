export type EatSourceKind = 'file' | 'directory' | 'url' | 'feed' | 'stdin' | 'text' | 'mcp';
export interface EatSource { kind: EatSourceKind; locator: string; contentType?: string }
export interface EatChunk { index: number; text: string; source: EatSource }
export interface EatDigestResult { observations: EatObservationDraft[]; model: string }
export interface EatObservationDraft { type: string; title: string; subtitle: string; facts: string[]; narrative: string; concepts: string[] }
export interface EatReport { request_id: string; source: EatSource; chunks: number; observation_ids: number[]; drafts?: EatObservationDraft[]; rejected: number }
export interface EatPipelineResult { source: EatSource; chunks: number; drafts: EatObservationDraft[]; rejected: number; model: string }
