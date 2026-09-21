/**
 * Types and interfaces for the Gemini dynamic model cascade,
 * real-time rate limit tracking (RPM, TPM, RPD), and SSE events.
 */

export type ModelCategory = 'pro' | 'flash' | 'gemma' | 'omni' | 'lite';

export type ModelStatus = 'active' | 'ready' | 'cooldown' | 'exhausted' | 'unsupported';

export interface GeminiModelInfo {
  id: string;
  displayName: string;
  category: ModelCategory;
  rank: number; // Lower rank = higher priority (1 = most powerful)
  rpmLimit: number;
  tpmLimit: number;
  rpdLimit: number;
  contextWindow: number;
  outputLimit: number;
  supportedGenerationMethods?: string[];
  description?: string;
  isPerpetualAlias?: boolean;
  isPreview?: boolean;
}

export interface ModelUsageState {
  rpmUsed: number;
  rpmLimit: number;
  tpmUsed: number;
  tpmLimit: number;
  rpdUsed: number;
  rpdLimit: number;
  status: ModelStatus;
  cooldownUntilMs?: number;
  cooldownReason?: string;
  lastUsedAt?: number;
  totalRequestsServed: number;
}

export interface QueueState {
  depth: number;
  isProcessing: boolean;
  isWaitingForQuota: boolean;
  quotaWaitRemainingMs: number;
  lastEvent?: string;
}

export interface GeminiRateLimitsStatus {
  provider: 'gemini';
  activeModel: string;
  autoFallback: boolean;
  tier?: 'free' | 'payg';
  models: Record<string, ModelUsageState>;
  cascade: GeminiModelInfo[];
  queue: QueueState;
  lastUpdated: number;
  lastSwitchEvent?: {
    fromModel: string;
    toModel: string;
    reason: string;
    timestamp: number;
  };
}

export interface TokenReservation {
  id: string;
  model: string;
  estimatedTokens: number;
  timestamp: number;
}
