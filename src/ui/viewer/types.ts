export interface Observation {
  id: number;
  memory_session_id: string;
  content_session_id: string;
  project: string;
  merged_into_project?: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
  /** Validated `metadata.cmem_media_v1` refs; absent for image-free rows. Readiness is not in here. */
  media?: ObservationMedia;
}

/** Copy of MediaAttachmentRef (src/shared/media-contract.ts): IDs and labels only. */
export interface ObservationMediaRef {
  id: string;
  label: string;
  inspection: 'inspected' | 'uninspected';
}

export interface ObservationMedia {
  version: 1;
  attachments: ObservationMediaRef[];
  /** More refs remain on the source event because the row reached its bound. */
  overflow?: boolean;
}

export interface MediaVariantDescriptor {
  sha256: string;
  width: number;
  height: number;
  byteLength: number;
  mimeType: 'image/webp';
}

/** GET /api/media/:id: safe metadata only (MediaRoutes.safeMetadata). */
export interface MediaMetadataResponse {
  id: string;
  state: 'converting' | 'ready' | 'failed' | 'unresolved_replica';
  recipe: 'screenshot-v1' | 'photo-v1';
  encoderVersion: string | null;
  viewer: MediaVariantDescriptor | null;
  llm: MediaVariantDescriptor | null;
  failureCode: string | null;
  capturedAt: number;
}

/** GET /api/media/:id/details: owner-only, fetched only on explicit request. */
export interface MediaOwnerDetailsResponse {
  id: string;
  platform: string | null;
  sourceShape: string | null;
  sourceLocatorPath: string | null;
  sourceAvailability: 'converted_only' | 'file_present' | 'file_missing';
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  platform_source: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export interface SessionCatalogEntry {
  content_session_id: string;
  project: string;
  platform_source: string;
  custom_title: string | null;
  started_at_epoch: number;
  item_count: number;
}

export type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

export type FeedItemType = 'observation' | 'summary' | 'prompt';

export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status' | 'item_deleted' | 'session_deleted';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
  itemType?: FeedItemType;
  id?: number;
  /** session_deleted */
  platformSource?: string;
  contentSessionId?: string;
}

export interface ProjectCatalog {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
}

export interface Settings {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES?: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;

  CLAUDE_MEM_PROVIDER?: string;  
  CLAUDE_MEM_CODEX_MODEL?: string;
  CLAUDE_MEM_GEMINI_API_KEY?: string;
  CLAUDE_MEM_GEMINI_API_KEYS?: string;
  CLAUDE_MEM_GEMINI_MODEL?: string;  
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: string;  
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_API_KEYS?: string;
  CLAUDE_MEM_OPENROUTER_BASE_URL?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL?: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME?: string;
  CLAUDE_MEM_OPENROUTER_REASONING_EFFORT?: string;
  CLAUDE_MEM_OPENAI_COMPAT_PRESET?: string;
  CLAUDE_MEM_OPENAI_COMPAT_API_KEY?: string;
  CLAUDE_MEM_OPENAI_COMPAT_API_KEYS?: string;
  CLAUDE_MEM_OPENAI_COMPAT_BASE_URL?: string;
  CLAUDE_MEM_OPENAI_COMPAT_MODEL?: string;
  CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER?: string;
  CLAUDE_MEM_QUOTA_FALLBACK_MODEL?: string;

  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;

  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;

  /** File/env only — shown read-only. Not written via POST /api/settings. */
  CLAUDE_CODE_PATH?: string;
}
