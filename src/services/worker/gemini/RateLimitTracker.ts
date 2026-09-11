import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../../utils/logger.js';
import { paths } from '../../../shared/paths.js';
import type {
  GeminiModelInfo,
  ModelUsageState,
  GeminiRateLimitsStatus,
  QueueState,
  ModelStatus,
} from './types.js';
import { DynamicModelRegistry } from './DynamicModelRegistry.js';
import { getTierLimits } from './model-cascade.js';

interface PersistedRpdData {
  date: string; // YYYY-MM-DD UTC
  counts: Record<string, number>;
  tier?: 'free' | 'payg';
}

export class RateLimitTracker {
  private static instance: RateLimitTracker | null = null;

  // Sliding 60-second window of request timestamps per model: modelId -> timestamp[]
  private rpmTimestamps = new Map<string, number[]>();

  // Sliding 60-second window of tokens used per model: modelId -> { timestamp, tokens }[]
  private tpmRecords = new Map<string, Array<{ timestamp: number; tokens: number }>>();

  // Persisted daily request counts (RPD) and user plan tier
  private rpdCounts: Record<string, number> = {};
  private currentUtcDate: string = '';
  private tier: 'free' | 'payg' = 'free';

  // Cooldown status per model
  private cooldowns = new Map<string, { untilMs: number; reason: string }>();

  // Permanent/unsupported status per model (e.g. 404 or Pro unavailable on current key)
  private unsupportedModels = new Set<string>();

  // Total requests served in current worker session
  private lifetimeRequests = new Map<string, number>();

  // Active preferred model
  private activeModelId: string = 'gemini-3.7-flash';
  private autoFallbackEnabled: boolean = true;

  // Queue state reference
  private queueState: QueueState = {
    depth: 0,
    isProcessing: false,
    isWaitingForQuota: false,
    quotaWaitRemainingMs: 0,
  };

  // Last model switch event for UI
  private lastSwitchEvent?: {
    fromModel: string;
    toModel: string;
    reason: string;
    timestamp: number;
  };

  // Callback to broadcast updates via SSE
  private onStatusChange?: (status: GeminiRateLimitsStatus) => void;
  private sweepIntervalTimer?: ReturnType<typeof setInterval>;

  private constructor() {
    this.currentUtcDate = this.getTodayUtcString();
    this.loadPersistedRpd();
    this.sweepIntervalTimer = setInterval(() => {
      try {
        this.sweepStaleRecords();
      } catch (err) {
        logger.warn('GEMINI', 'Error sweeping stale rate limit records', { err });
      }
    }, 60_000);
    if (typeof this.sweepIntervalTimer.unref === 'function') {
      this.sweepIntervalTimer.unref();
    }
  }

  public static getInstance(): RateLimitTracker {
    if (!RateLimitTracker.instance) {
      RateLimitTracker.instance = new RateLimitTracker();
    }
    return RateLimitTracker.instance;
  }

  public setStatusChangeHandler(handler: (status: GeminiRateLimitsStatus) => void): void {
    this.onStatusChange = handler;
  }

  public setAutoFallback(enabled: boolean): void {
    this.autoFallbackEnabled = enabled;
    this.notifyChange();
  }

  public setTier(tier: 'free' | 'payg'): void {
    this.tier = tier;
    this.persistRpd();
    logger.info('GEMINI', `User plan tier set to: ${tier}`);
    this.notifyChange();
  }

  public getTier(): 'free' | 'payg' {
    return this.tier;
  }

  public calibrateRpd(modelId: string, count: number): void {
    this.ensureDateRollover();
    this.rpdCounts[modelId] = Math.max(0, Math.floor(count));
    this.persistRpd();
    logger.info('GEMINI', `Manual RPD calibrated for ${modelId}: ${this.rpdCounts[modelId]}`);
    this.notifyChange();
  }

  public setActiveModel(modelId: string): void {
    this.activeModelId = modelId;
    this.notifyChange();
  }

  public getActiveModel(): string {
    return this.activeModelId;
  }

  public updateQueueState(partial: Partial<QueueState>): void {
    this.queueState = { ...this.queueState, ...partial };
    this.notifyChange();
  }

  private getTodayUtcString(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private ensureDateRollover(): void {
    const today = this.getTodayUtcString();
    if (this.currentUtcDate !== today) {
      logger.info('GEMINI', `RPD date rolled over from ${this.currentUtcDate} to ${today}; resetting daily quotas`);
      this.currentUtcDate = today;
      this.rpdCounts = {};
      this.persistRpd();
    }
  }

  private loadPersistedRpd(): void {
    try {
      const filePath = paths.geminiRateLimits();
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as PersistedRpdData;
      if (data && data.date === this.currentUtcDate && data.counts) {
        this.rpdCounts = { ...data.counts };
      } else {
        this.rpdCounts = {};
      }
      if (data && (data.tier === 'free' || data.tier === 'payg')) {
        this.tier = data.tier;
      }
      this.persistRpd();
    } catch (err) {
      logger.warn('GEMINI', 'Could not read persisted rate limits file', {}, err as Error);
      this.rpdCounts = {};
    }
  }

  private persistRpd(): void {
    try {
      const filePath = paths.geminiRateLimits();
      mkdirSync(dirname(filePath), { recursive: true });
      const data: PersistedRpdData = {
        date: this.currentUtcDate,
        counts: this.rpdCounts,
        tier: this.tier,
      };
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      logger.warn('GEMINI', 'Could not persist rate limits file', {}, err as Error);
    }
  }

  public resetAllCounters(): void {
    this.rpmTimestamps.clear();
    this.tpmRecords.clear();
    this.cooldowns.clear();
    this.unsupportedModels.clear();
    this.rpdCounts = {};
    this.lifetimeRequests.clear();
    this.queueState = {
      depth: 0,
      isProcessing: false,
      isWaitingForQuota: false,
      quotaWaitRemainingMs: 0,
    };
    this.lastSwitchEvent = undefined;
  }

  /**
   * Prune requests older than 60 seconds from the sliding window.
   */
  private pruneOldRecords(modelId: string, now: number = Date.now()): void {
    const threshold = now - 60_000;

    const timestamps = this.rpmTimestamps.get(modelId);
    if (timestamps) {
      const filtered = timestamps.filter(t => t > threshold);
      this.rpmTimestamps.set(modelId, filtered);
    }

    const tokenRecords = this.tpmRecords.get(modelId);
    if (tokenRecords) {
      const filteredTokens = tokenRecords.filter(r => r.timestamp > threshold);
      this.tpmRecords.set(modelId, filteredTokens);
    }
  }

  /**
   * Sweeps stale rate limiter records and expired cooldowns from RAM.
   * Cleans up empty timestamp arrays and prevents unbounded Map growth.
   */
  public sweepStaleRecords(now: number = Date.now()): void {
    const threshold = now - 60_000;

    for (const [modelId, timestamps] of this.rpmTimestamps.entries()) {
      const filtered = timestamps.filter(t => t > threshold);
      if (filtered.length === 0) {
        this.rpmTimestamps.delete(modelId);
      } else {
        this.rpmTimestamps.set(modelId, filtered);
      }
    }

    for (const [modelId, records] of this.tpmRecords.entries()) {
      const filtered = records.filter(r => r.timestamp > threshold);
      if (filtered.length === 0) {
        this.tpmRecords.delete(modelId);
      } else {
        this.tpmRecords.set(modelId, filtered);
      }
    }

    for (const [modelId, cd] of this.cooldowns.entries()) {
      if (cd.untilMs <= now) {
        this.cooldowns.delete(modelId);
      }
    }
  }

  public dispose(): void {
    if (this.sweepIntervalTimer) {
      clearInterval(this.sweepIntervalTimer);
      this.sweepIntervalTimer = undefined;
    }
  }

  public getRpmUsed(modelId: string, now: number = Date.now()): number {
    this.pruneOldRecords(modelId, now);
    return this.rpmTimestamps.get(modelId)?.length ?? 0;
  }

  public getTpmUsed(modelId: string, now: number = Date.now()): number {
    this.pruneOldRecords(modelId, now);
    const records = this.tpmRecords.get(modelId);
    if (!records) return 0;
    return records.reduce((sum, r) => sum + r.tokens, 0);
  }

  public getRpdUsed(modelId: string): number {
    this.ensureDateRollover();
    return this.rpdCounts[modelId] ?? 0;
  }

  public getModelStatus(modelId: string, now: number = Date.now()): { status: ModelStatus; cooldownUntilMs?: number; reason?: string } {
    if (this.unsupportedModels.has(modelId)) {
      return { status: 'unsupported', reason: 'Not supported or not enabled for current API key' };
    }

    const cd = this.cooldowns.get(modelId);
    if (cd && cd.untilMs > now) {
      return { status: 'cooldown', cooldownUntilMs: cd.untilMs, reason: cd.reason };
    }

    const registry = DynamicModelRegistry.getInstance();
    const info = registry.getModel(modelId);
    if (info) {
      const limits = getTierLimits(info, this.tier);
      const rpdUsed = this.getRpdUsed(modelId);
      if (rpdUsed >= limits.rpdLimit) {
        return { status: 'exhausted', reason: `Daily limit reached (${rpdUsed}/${limits.rpdLimit} RPD)` };
      }
    }

    return { status: 'ready' };
  }

  /**
   * Check if a model can execute a request with estimated token count.
   */
  public canExecute(modelId: string, estimatedTokens: number = 2000, now: number = Date.now()): {
    allowed: boolean;
    waitMs: number;
    reason?: string;
  } {
    this.ensureDateRollover();
    this.pruneOldRecords(modelId, now);

    const statusObj = this.getModelStatus(modelId, now);
    if (statusObj.status === 'unsupported') {
      return { allowed: false, waitMs: Infinity, reason: 'unsupported' };
    }
    if (statusObj.status === 'exhausted') {
      // Calculate ms until midnight UTC
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);
      return { allowed: false, waitMs: tomorrow.getTime() - now, reason: statusObj.reason };
    }
    if (statusObj.status === 'cooldown' && statusObj.cooldownUntilMs) {
      return { allowed: false, waitMs: Math.max(0, statusObj.cooldownUntilMs - now), reason: statusObj.reason };
    }

    const registry = DynamicModelRegistry.getInstance();
    const info = registry.getModel(modelId);
    if (!info) {
      return { allowed: true, waitMs: 0 };
    }

    const limits = getTierLimits(info, this.tier);

    // Check RPD
    const rpdUsed = this.getRpdUsed(modelId);
    if (rpdUsed >= limits.rpdLimit) {
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);
      return { allowed: false, waitMs: tomorrow.getTime() - now, reason: 'rpd_limit' };
    }

    // Check RPM
    const timestamps = this.rpmTimestamps.get(modelId) ?? [];
    if (timestamps.length >= limits.rpmLimit) {
      const oldest = timestamps[0] ?? now;
      const waitMs = Math.max(100, oldest + 60_000 - now + 50);
      return { allowed: false, waitMs, reason: `RPM limit reached (${timestamps.length}/${limits.rpmLimit})` };
    }

    // Check TPM
    const tpmUsed = this.getTpmUsed(modelId, now);
    if (tpmUsed + estimatedTokens > limits.tpmLimit) {
      const records = this.tpmRecords.get(modelId) ?? [];
      const oldestRecord = records[0];
      const waitMs = oldestRecord ? Math.max(100, oldestRecord.timestamp + 60_000 - now + 50) : 5000;
      return { allowed: false, waitMs, reason: `TPM limit reached (${tpmUsed + estimatedTokens}/${limits.tpmLimit})` };
    }

    return { allowed: true, waitMs: 0 };
  }

  /**
   * Select the best available model from the cascade.
   * If the preferred model has capacity, it is returned.
   * If not (due to rate limits), dynamically cascades down to the next capable model.
   */
  public selectBestAvailableModel(preferredModel: string, estimatedTokens: number = 2000): {
    selectedModel: GeminiModelInfo;
    willFallback: boolean;
    waitMs: number;
    reason?: string;
  } {
    const now = Date.now();
    const registry = DynamicModelRegistry.getInstance();
    const cascade = registry.getCascade();

    if (cascade.length === 0) {
      throw new Error('Gemini model cascade is empty.');
    }

    // If preferredModel is 'auto', we start from rank 1
    const isAuto = preferredModel === 'auto' || !preferredModel;
    const startIndex = isAuto
      ? 0
      : Math.max(0, cascade.findIndex(m => m.id === preferredModel));

    // Try preferred model first
    if (!isAuto && startIndex !== -1) {
      const candidate = cascade[startIndex];
      const check = this.canExecute(candidate.id, estimatedTokens, now);
      if (check.allowed) {
        return { selectedModel: candidate, willFallback: false, waitMs: 0 };
      }
    }

    // If auto-fallback is enabled, cascade through remaining models in rank order
    if (this.autoFallbackEnabled || isAuto) {
      for (const candidate of cascade) {
        if (this.unsupportedModels.has(candidate.id)) continue;
        const check = this.canExecute(candidate.id, estimatedTokens, now);
        if (check.allowed) {
          const willFallback = candidate.id !== preferredModel;
          if (willFallback) {
            logger.info('GEMINI', `Cascade routed request to ${candidate.id} (preferred: ${preferredModel})`);
          }
          return { selectedModel: candidate, willFallback, waitMs: 0 };
        }
      }
    }

    // If all models are currently constrained by sliding 60s windows,
    // find the one with the shortest wait time
    let minWaitMs = Infinity;
    let bestCandidate = cascade[0];

    for (const candidate of cascade) {
      if (this.unsupportedModels.has(candidate.id)) continue;
      const check = this.canExecute(candidate.id, estimatedTokens, now);
      if (check.waitMs < minWaitMs) {
        minWaitMs = check.waitMs;
        bestCandidate = candidate;
      }
    }

    return {
      selectedModel: bestCandidate,
      willFallback: bestCandidate.id !== preferredModel,
      waitMs: minWaitMs === Infinity ? 10_000 : minWaitMs,
      reason: 'all_rate_limited',
    };
  }

  /**
   * Directly set cooldown on a model (used by handlers and tests).
   */
  public setCooldown(modelId: string, durationMs: number, reason: string, now: number = Date.now()): void {
    this.cooldowns.set(modelId, { untilMs: now + durationMs, reason });
    this.notifyChange();
  }

  /**
   * Record successful request execution and update metrics.
   */
  public recordRequestSuccess(modelId: string, tokensUsed: number, timestamp?: number): void {
    const now = timestamp ?? Date.now();
    this.ensureDateRollover();

    // RPM
    const timestamps = this.rpmTimestamps.get(modelId) ?? [];
    timestamps.push(now);
    this.rpmTimestamps.set(modelId, timestamps);

    // TPM
    const tpmList = this.tpmRecords.get(modelId) ?? [];
    tpmList.push({ timestamp: now, tokens: tokensUsed });
    this.tpmRecords.set(modelId, tpmList);

    // RPD
    this.rpdCounts[modelId] = (this.rpdCounts[modelId] ?? 0) + 1;
    this.persistRpd();

    // Lifetime
    this.lifetimeRequests.set(modelId, (this.lifetimeRequests.get(modelId) ?? 0) + 1);

    // Clear cooldown if it was active
    this.cooldowns.delete(modelId);

    this.activeModelId = modelId;
    this.notifyChange();
  }

  /**
   * Handle an error response from Gemini and dynamically set model cooldown.
   */
  public recordRequestFailure(
    modelId: string,
    status: number | undefined,
    bodyText: string = '',
    retryAfterMs?: number
  ): { fallbackRecommended: boolean; nextModel?: GeminiModelInfo; reason?: string } {
    const now = Date.now();
    const lower = bodyText.toLowerCase();

    let cooldownMs = retryAfterMs ?? 30_000;
    let reason = 'Rate limit (429)';

    if (status === 404 || lower.includes('no longer available') || lower.includes('not found')) {
      this.unsupportedModels.add(modelId);
      reason = 'Model deprecated / not available';
      logger.warn('GEMINI', `Model ${modelId} marked unsupported (404): ${bodyText.slice(0, 120)}`);
    } else if (status === 422 || lower.includes('unprocessable') || lower.includes('invalid argument')) {
      // HTTP 422: Parameter or schema incompatibility specific to this model (e.g. Gemma, thinking models, or preview schema mismatch)
      this.cooldowns.set(modelId, { untilMs: now + 3600_000, reason: 'Incompatible payload/parameters (422)' });
      reason = 'Incompatible payload/parameters (422)';
      logger.warn('GEMINI', `Model ${modelId} rejected payload as unprocessable (422), cooling down for 1h: ${bodyText.slice(0, 120)}`);
    } else if (
      status === 400 &&
      (lower.includes('not supported for generatecontent') ||
        lower.includes('not supported by this model') ||
        lower.includes('unsupported model') ||
        (lower.includes('models/') && lower.includes('not found')))
    ) {
      // HTTP 400: Model does not support generateContent
      this.unsupportedModels.add(modelId);
      reason = 'Model unsupported for generation (400)';
      logger.warn('GEMINI', `Model ${modelId} marked unsupported for generation (400): ${bodyText.slice(0, 120)}`);
    } else if (
      status === 400 &&
      (lower.includes('context limit') ||
        lower.includes('context length') ||
        lower.includes('too many tokens') ||
        lower.includes('input is too long') ||
        lower.includes('prompt is too long') ||
        lower.includes('payload size exceeds') ||
        (lower.includes('token') && (lower.includes('exceed') || lower.includes('maximum'))))
    ) {
      // HTTP 400: Context limit exceeded for this model
      this.cooldowns.set(modelId, { untilMs: now + 600_000, reason: 'Context limit exceeded (400)' });
      reason = 'Context limit exceeded (400)';
      logger.warn('GEMINI', `Model ${modelId} context limit exceeded (400), cooling down for 10m: ${bodyText.slice(0, 120)}`);
    } else if (
      status === 503 ||
      lower.includes('model is overloaded') ||
      lower.includes('overloaded') ||
      (status !== undefined && status >= 500 && status < 600 && lower.includes('service unavailable'))
    ) {
      // HTTP 503: Model is overloaded on Google servers
      cooldownMs = retryAfterMs ?? 60_000;
      this.cooldowns.set(modelId, { untilMs: now + cooldownMs, reason: 'Model overloaded (503)' });
      reason = 'Model overloaded (503)';
      logger.warn('GEMINI', `Model ${modelId} is overloaded (503), entering cooldown for ${Math.round(cooldownMs / 1000)}s`);
    } else if (
      status === 403 &&
      (lower.includes('location is not supported') ||
        lower.includes('permission denied for models') ||
        lower.includes('not enabled for this model') ||
        lower.includes('restricted') ||
        lower.includes('waitlist'))
    ) {
      // HTTP 403: Model restricted by region or plan (API key itself is valid for standard models)
      this.unsupportedModels.add(modelId);
      reason = 'Model restricted/unavailable (403)';
      logger.warn('GEMINI', `Model ${modelId} is restricted for current key/region (403): ${bodyText.slice(0, 120)}`);
    } else if (lower.includes('safety') && (lower.includes('blocked') || lower.includes('filter'))) {
      this.cooldowns.set(modelId, { untilMs: now + 300_000, reason: 'Blocked by safety filters' });
      reason = 'Blocked by safety filters';
      logger.warn('GEMINI', `Model ${modelId} output blocked by safety filters, cooling down for 5m`);
    } else if (lower.includes('daily') || lower.includes('requests per day') || lower.includes('rpd')) {
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);
      cooldownMs = tomorrow.getTime() - now;
      reason = 'Daily quota exhausted';
      const info = DynamicModelRegistry.getInstance().getModel(modelId);
      if (info) {
        const limits = getTierLimits(info, this.tier);
        this.rpdCounts[modelId] = Math.max(this.rpdCounts[modelId] ?? 0, limits.rpdLimit);
        this.persistRpd();
      }
      logger.warn('GEMINI', `Model ${modelId} reached daily quota (auto-calibrated RPD to ${this.rpdCounts[modelId]}). Cooldown until ${tomorrow.toISOString()}`);
    } else if (lower.includes('quota exceeded') && (modelId.includes('pro') || lower.includes('billing'))) {
      // Pro models on free key without billing
      this.cooldowns.set(modelId, { untilMs: now + 3600_000, reason: 'Quota unavailable on current plan' });
      reason = 'Quota unavailable on current plan';
      logger.warn('GEMINI', `Model ${modelId} quota unavailable on free tier; cooled down for 1h`);
    } else {
      // Standard RPM or TPM 429
      if (retryAfterMs) {
        cooldownMs = retryAfterMs;
      } else {
        cooldownMs = Math.min(60_000, Math.max(15_000, 60_000 - (now % 60_000)));
      }
      this.cooldowns.set(modelId, { untilMs: now + cooldownMs, reason });
      logger.warn('GEMINI', `Model ${modelId} entered cooldown for ${(cooldownMs / 1000).toFixed(0)}s (${reason})`);
    }

    // Try to find fallback
    const selection = this.selectBestAvailableModel(modelId);
    if (selection.selectedModel.id !== modelId) {
      this.lastSwitchEvent = {
        fromModel: modelId,
        toModel: selection.selectedModel.id,
        reason,
        timestamp: now,
      };
      this.activeModelId = selection.selectedModel.id;
      logger.info('GEMINI', `Auto-switched model from ${modelId} to ${selection.selectedModel.id} due to ${reason}`);
      this.notifyChange();
      return { fallbackRecommended: true, nextModel: selection.selectedModel, reason };
    }

    this.notifyChange();
    return { fallbackRecommended: false, reason };
  }

  public getStatus(): GeminiRateLimitsStatus {
    const now = Date.now();
    const registry = DynamicModelRegistry.getInstance();
    const rawCascade = registry.getCascade();
    const cascade = rawCascade.map(m => ({ ...m, ...getTierLimits(m, this.tier) }));

    const modelsStatus: Record<string, ModelUsageState> = {};

    for (const info of rawCascade) {
      const limits = getTierLimits(info, this.tier);
      const statusObj = this.getModelStatus(info.id, now);
      const rpmUsed = this.getRpmUsed(info.id, now);
      const tpmUsed = this.getTpmUsed(info.id, now);
      const rpdUsed = this.getRpdUsed(info.id);

      modelsStatus[info.id] = {
        rpmUsed,
        rpmLimit: limits.rpmLimit,
        tpmUsed,
        tpmLimit: limits.tpmLimit,
        rpdUsed,
        rpdLimit: limits.rpdLimit,
        status: statusObj.status === 'ready' && info.id === this.activeModelId ? 'active' : statusObj.status,
        cooldownUntilMs: statusObj.cooldownUntilMs,
        cooldownReason: statusObj.reason,
        totalRequestsServed: this.lifetimeRequests.get(info.id) ?? 0,
      };
    }

    return {
      provider: 'gemini',
      tier: this.tier,
      activeModel: this.activeModelId,
      autoFallback: this.autoFallbackEnabled,
      models: modelsStatus,
      cascade,
      queue: this.queueState,
      lastUpdated: now,
      lastSwitchEvent: this.lastSwitchEvent,
    };
  }

  private notifyChange(): void {
    if (this.onStatusChange) {
      try {
        this.onStatusChange(this.getStatus());
      } catch (err) {
        logger.debug('GEMINI', 'Error notifying status change', err as Error);
      }
    }
  }
}
