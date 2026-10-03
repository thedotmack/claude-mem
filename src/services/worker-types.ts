import type { MediaManifest } from '../shared/media-contract.js';

import type { Response } from 'express';
import type { MediaAttachmentRef, MediaFailureDescriptor } from '../shared/media-contract.js';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Set on a generation's init or continuation prompt (openObserverGeneration).
   * HTTP providers send its instructions as the system message (#3868).
   */
  framing?: boolean;
}

export interface ActiveSession {
  sessionDbId: number;
  contentSessionId: string;      
  memorySessionId: string | null; 
  project: string;
  platformSource: string;
  userPrompt: string;
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number;
  startTime: number;
  cumulativeInputTokens: number;   
  cumulativeOutputTokens: number;  
  earliestPendingTimestamp: number | null;  
  claimedMessageIds: number[];
  conversationHistory: ConversationMessage[];  
  currentProvider: 'claude' | 'gemini' | 'openrouter' | 'codex' | 'openai-compatible' | null;
  /**
   * Claude account (config-dir profile key) the latest Claude generator was
   * spawned under. Its env, and so its billing account, is fixed at spawn, so
   * a quota refusal it hits is armed under this account even if the setting
   * changed while it ran.
   */
  observerProfile?: string;
  consecutiveRestarts: number;
  /**
   * Rejected replies (neither observation/summary XML nor the
   * `<skip_summary />` sentinel) to the batch named by `invalidOutputBatchKey`.
   * The first earns the batch one retry in a fresh generation; the second drops
   * it with an error (OutputRecovery). A skip is a valid answer and is never
   * counted, so skip acknowledgements cannot accumulate the respawn debt this
   * counter once caused. Hard rejections (overflow, quota, auth, transport) are
   * not counted here either; they pause on their own terms.
   */
  consecutiveInvalidOutputs: number;
  /** The claimed message ids `consecutiveInvalidOutputs` counts against. */
  invalidOutputBatchKey?: string | null;
  /**
   * Replies in a row that drifted off the observation schema and were salvaged
   * (#3461). Reaching ResponseProcessor's limit ends the generation so the next
   * one starts clean; a clean reply resets it.
   */
  consecutiveSchemaDrifts?: number;
  /** Set by a drifted reply: the next observation prompt restates the schema once. */
  observerSchemaReminder?: boolean;
  /**
   * Consecutive "prompt too long" rejections on this session's conversation.
   *
   * Unlike a skip, an overflow rejection is not a no-op: the conversation has
   * outgrown the model's context window and every later request re-sends it at
   * full cost and fails identically. Counting these drives conversation recycle
   * and, if recycling does not help, a hard pause (#3800).
   */
  consecutiveContextOverflows: number;
  /**
   * Epoch ms until which observer restarts are withheld after recycling failed
   * to produce a conversation that fits. Without this gate the next captured
   * tool call spawns a generator that can only abort on the same budget check.
   */
  overflowPausedUntilMs?: number;
  /**
   * Consecutive generations that ended because a prompt went unanswered
   * ('transport:response_stall'). Bounds their automatic resume; reset when a
   * queued-work turn is answered (#4066).
   */
  consecutiveResponseStalls?: number;
  /**
   * Consecutive rate-limit pauses this session resumed from on its own, after
   * the provider's Retry-After. Bounds those resumes before the provider
   * breaker takes over; reset when a queued-work turn is answered.
   */
  consecutiveRateLimitResumes?: number;
  /**
   * Consecutive unattended resumes — transport backoff, rate-limit
   * Retry-After, or the move to the Anthropic plan after a cmem fallback —
   * scheduled while memory is on the cmem gateway. Bounds them at
   * MAX_UNATTENDED_GATEWAY_RESUMES (plan tokens); reset when a queued-work turn
   * is answered.
   */
  consecutiveUnattendedGatewayResumes?: number;
  /**
   * The delayed resume a response stall scheduled. Any generator start cancels
   * it, so a stale timer never restarts a session a newer generation paused.
   */
  stallResumeTimer?: ReturnType<typeof setTimeout>;
  /**
   * The resume a pause scheduled for itself: after a rate limit's Retry-After,
   * or at once after a cmem fallback or a recycle. The periodic sweep leaves
   * the session to it while it is pending, and any generator start cancels it.
   */
  scheduledResumeTimer?: ReturnType<typeof setTimeout>;
  forceInit?: boolean;
  idleTimedOut?: boolean;  
  lastGeneratorActivity: number;
  modelOverride?: string;
  lastSummaryStored?: boolean;
  pendingAgentId?: string | null;
  pendingAgentType?: string | null;
  abortReason?: 'idle' | 'shutdown' | 'overflow' | 'restart-guard' | 'quota' | 'provider_switch' | string | null;
  /** Why buffered work was last parked after a generator exit. */
  pausedReason?: string | null;
  respawnTimer?: ReturnType<typeof setTimeout>;
  /** When the latest compression prompt was dispatched to the model — telemetry compression_ms. */
  lastPromptSentAt?: number | null;
  /** Real token usage and provider-reported cost from the latest model response (never estimated) — telemetry tokens_input/output/cost_usd. */
  lastUsage?: { input: number; output: number; costUsd?: number } | null;
  /** What triggered the running generator ('init' | 'ingest' | 'summarize') — telemetry hook. */
  lastGeneratorSource?: string;
  /** Model id resolved when the generator started — error-path telemetry, where no response model exists. */
  lastModelId?: string;
  /** Model the OBSERVED IDE session is running (from its transcript) — telemetry observed_model. Not the observer model. */
  observedModel?: string;
  /** Billing posture of the observed Claude Code session (closed enum, see observed-billing.ts) — telemetry observed_billing. */
  observedBilling?: string;
  /** Whether the OpenRouter provider targets openrouter.ai or a custom OpenAI-compatible gateway — telemetry endpoint_class. */
  endpointClass?: 'openrouter' | 'custom';
  /**
   * The observer model's context window in tokens, resolved once per
   * generation at generator start (#3625). The generation budget and the
   * per-field cap scale with it.
   */
  observerContextWindowTokens?: number;
  /**
   * The context the model actually read on the last answered turn of this
   * generation, in tokens, as the provider reported it: the Claude result
   * frame's input + cache writes + cache reads, or an HTTP provider's prompt
   * tokens. Unlike the character proxy it counts the system prompt and tool
   * schemas a provider adds. Reset at every generation start; an init turn's
   * reading is never recorded (#2957).
   */
  lastContextTokens?: number;
  /**
   * The finish reason an HTTP provider reported for the reply about to be
   * processed ('length' / 'MAX_TOKENS' = cut off at the output-token cap).
   * processAgentResponse consumes and clears it, so it never outlives the
   * reply that set it (#3868).
   */
  lastFinishReason?: string | null;
  /**
   * session_compressed properties stashed by ResponseProcessor on the claude
   * path: the streamed assistant message's output_tokens is an early-streaming
   * placeholder, so the event waits for the SDK result message's finalized
   * per-turn usage before ClaudeProvider fires it.
   */
  pendingCompressionEvent?: Record<string, unknown> | null;
  /** Cumulative total_cost_usd from the SDK's latest result message — per-compression cost is the delta between results. */
  lastResultTotalCostUsd?: number | null;
  /**
   * Cumulative cache_read_input_tokens across the session. Kept apart from
   * cumulativeInputTokens because discovery_tokens is the delta of that
   * counter; on a long observer session this is where most of the context the
   * model re-reads shows up, so it is the number that makes resend growth
   * visible.
   */
  cumulativeCacheReadTokens?: number;
  /** SessionEnd requested one Telegram wrap-up after the latest summary lands. */
  telegramWrapupRequestedAt?: number | null;
  /** One-shot grace timer for a SessionEnd wrap-up request. */
  telegramWrapupTimer?: ReturnType<typeof setTimeout> | null;
}

export interface PendingMessage {
  mediaRefs?: MediaAttachmentRef[];
  mediaEventKey?: string;
  mediaFailures?: MediaFailureDescriptor[];
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt_number?: number;
  cwd?: string;
  last_assistant_message?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface PendingMessageWithId extends PendingMessage {
  _persistentId: number;
  _originalTimestamp: number;
}

export interface ObservationData {
  mediaRefs?: MediaAttachmentRef[];
  mediaEventKey?: string;
  mediaFailures?: MediaFailureDescriptor[];
  tool_name: string;
  tool_input: any;
  tool_response: any;
  prompt_number: number;
  cwd?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface SSEEvent {
  type: string;
  timestamp?: number;
  [key: string]: any;
}

export type SSEClient = Response;

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface ViewerSettings {
  sidebarOpen: boolean;
  selectedProject: string | null;
  theme: 'light' | 'dark' | 'system';
}

export interface Observation {
  id: number;
  memory_session_id: string;
  content_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source: string;
  type: string;
  title: string;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  created_at: string;
  created_at_epoch: number;
  /** Validated `metadata.cmem_media_v1` refs; absent for image-free rows (see media/feed.ts). */
  media?: MediaManifest;
}

export interface Summary {
  id: number;
  session_id: string; 
  project: string;
  platform_source: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  created_at: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;  
  project: string; 
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export interface DBSession {
  id: number;
  content_session_id: string;    
  project: string;
  platform_source: string;
  user_prompt: string;
  memory_session_id: string | null;  
  status: 'active' | 'completed' | 'failed';
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
}

export type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
