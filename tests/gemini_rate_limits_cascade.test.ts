import { describe, it, expect, beforeEach } from 'bun:test';
import { DynamicModelRegistry } from '../src/services/worker/gemini/DynamicModelRegistry.js';
import { RateLimitTracker } from '../src/services/worker/gemini/RateLimitTracker.js';
import { DEFAULT_MODEL_CASCADE, classifyModelCategory, getTierLimits } from '../src/services/worker/gemini/model-cascade.js';

describe('Gemini Dynamic Engine & Rate Limiter', () => {
  describe('Model Cascade and Classification', () => {
    it('classifies models into accurate categories', () => {
      expect(classifyModelCategory('gemini-pro-latest')).toBe('pro');
      expect(classifyModelCategory('gemini-3.1-pro-preview')).toBe('pro');
      expect(classifyModelCategory('gemini-flash-latest')).toBe('flash');
      expect(classifyModelCategory('gemini-3.7-flash')).toBe('flash');
      expect(classifyModelCategory('gemma-4-31b-it')).toBe('gemma');
      expect(classifyModelCategory('gemma-2-27b-it')).toBe('gemma');
      expect(classifyModelCategory('gemini-omni-1.1-flash')).toBe('omni');
      expect(classifyModelCategory('gemini-flash-lite-latest')).toBe('lite');
      expect(classifyModelCategory('gemini-3.1-flash-lite')).toBe('lite');
    });

    it('orders models strictly from most powerful to least powerful (Pro -> Flash -> Gemma -> Omni -> Lite)', () => {
      const cascade = DEFAULT_MODEL_CASCADE;
      expect(cascade.length).toBeGreaterThanOrEqual(20);

      // Verify Tier 1 starts with Pro
      expect(cascade[0].category).toBe('pro');
      expect(cascade[0].rank).toBe(1);

      // Verify Ranks are contiguous 1..N
      for (let i = 0; i < cascade.length; i++) {
        expect(cascade[i].rank).toBe(i + 1);
      }

      // Verify Pro models precede Flash models
      const firstProIndex = cascade.findIndex(m => m.category === 'pro');
      const firstFlashIndex = cascade.findIndex(m => m.category === 'flash');
      const firstGemmaIndex = cascade.findIndex(m => m.category === 'gemma');
      const firstOmniIndex = cascade.findIndex(m => m.category === 'omni');
      const firstLiteIndex = cascade.findIndex(m => m.category === 'lite');

      expect(firstProIndex).toBeLessThan(firstFlashIndex);
      expect(firstFlashIndex).toBeLessThan(firstGemmaIndex);
      expect(firstGemmaIndex).toBeLessThan(firstOmniIndex);
      expect(firstOmniIndex).toBeLessThan(firstLiteIndex);
    });

    it('identifies perpetual aliases and previews correctly', () => {
      const registry = DynamicModelRegistry.getInstance();
      const proLatest = registry.getModel('gemini-pro-latest');
      expect(proLatest?.isPerpetualAlias).toBe(true);

      const flashPreview = registry.getModel('gemini-3-flash-preview');
      expect(flashPreview?.isPreview).toBe(true);
    });
  });

  describe('RateLimitTracker', () => {
    let tracker: RateLimitTracker;

    beforeEach(() => {
      tracker = RateLimitTracker.getInstance();
      tracker.resetAllCounters();
      tracker.setAutoFallback(true);
    });

    it('tracks sliding 60-second window for RPM and records success', () => {
      const model = 'gemini-3.7-flash';
      expect(tracker.getRpmUsed(model)).toBe(0);

      tracker.recordRequestSuccess(model, 500);
      expect(tracker.getRpmUsed(model)).toBe(1);
      expect(tracker.getTpmUsed(model)).toBe(500);
      expect(tracker.getRpdUsed(model)).toBe(1);

      tracker.recordRequestSuccess(model, 1500);
      expect(tracker.getRpmUsed(model)).toBe(2);
      expect(tracker.getTpmUsed(model)).toBe(2000);
      expect(tracker.getRpdUsed(model)).toBe(2);
    });

    it('predictively demotes to next model when preferred model hits RPM limit', () => {
      const preferred = 'gemini-3.7-flash';
      const info = DynamicModelRegistry.getInstance().getModel(preferred)!;

      // Fill RPM to limit
      for (let i = 0; i < info.rpmLimit; i++) {
        tracker.recordRequestSuccess(preferred, 100);
      }

      // Check execution of preferred model
      const check = tracker.canExecute(preferred, 100);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('RPM limit reached');

      // Cascade selection should proactively switch to next available model
      const selection = tracker.selectBestAvailableModel(preferred, 100);
      expect(selection.selectedModel.id).not.toBe(preferred);
      expect(selection.willFallback).toBe(true);
    });

    it('handles reactive failure and sets cooldown', () => {
      const model = 'gemini-3.7-flash';
      const result = tracker.recordRequestFailure(model, 429, 'Resource exhausted');

      expect(result.fallbackRecommended).toBe(true);
      expect(result.nextModel).toBeDefined();
      expect(result.nextModel?.id).not.toBe(model);

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('cooldown');
    });

    it('marks models with 404 as unsupported', () => {
      const model = 'gemini-retired-model';
      tracker.recordRequestFailure(model, 404, 'models/gemini-retired-model not found');

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('unsupported');
    });

    it('handles HTTP 422 schema/parameter incompatibility with cooldown and fallback', () => {
      const model = 'gemma-4-31b-it';
      const result = tracker.recordRequestFailure(model, 422, 'Unprocessable Entity: system_instruction is not supported');

      expect(result.fallbackRecommended).toBe(true);
      expect(result.nextModel).toBeDefined();
      expect(result.nextModel?.id).not.toBe(model);
      expect(result.reason).toContain('422');

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('cooldown');
      expect(status.reason).toContain('Incompatible');
    });

    it('handles HTTP 400 model unsupported for generation', () => {
      const model = 'gemini-embedding-001';
      const result = tracker.recordRequestFailure(model, 400, 'Model not supported for generateContent');

      expect(result.fallbackRecommended).toBe(true);
      expect(result.nextModel?.id).not.toBe(model);
      expect(result.reason).toContain('400');

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('unsupported');
    });

    it('handles HTTP 400 context limit exceeded with cooldown and fallback', () => {
      const model = 'gemini-flash-lite-latest';
      const result = tracker.recordRequestFailure(model, 400, 'Context limit exceeded: prompt is too long for this model');

      expect(result.fallbackRecommended).toBe(true);
      expect(result.nextModel?.id).not.toBe(model);
      expect(result.reason).toContain('Context limit exceeded');

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('cooldown');
    });

    it('handles HTTP 503 model overloaded with 60s cooldown and immediate cascade', () => {
      const model = 'gemini-pro-latest';
      const result = tracker.recordRequestFailure(model, 503, 'The model is overloaded. Please try again later.');

      expect(result.fallbackRecommended).toBe(true);
      expect(result.nextModel?.id).not.toBe(model);
      expect(result.reason).toContain('503');

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('cooldown');
      expect(status.cooldownUntilMs).toBeGreaterThan(Date.now());
    });

    it('handles HTTP 403 model-specific restriction by marking only that model unsupported', () => {
      const model = 'gemini-exp-restricted';
      const result = tracker.recordRequestFailure(model, 403, 'User location is not supported for this model');

      expect(result.fallbackRecommended).toBe(true);
      expect(result.nextModel?.id).not.toBe(model);
      expect(result.reason).toContain('403');

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('unsupported');
    });

    it('handles safety block with cooldown and cascade', () => {
      const model = 'gemini-3.7-flash';
      const result = tracker.recordRequestFailure(model, 200, 'Blocked by safety filters');

      expect(result.fallbackRecommended).toBe(true);
      expect(result.nextModel?.id).not.toBe(model);
      expect(result.reason).toBe('Blocked by safety filters');

      const status = tracker.getModelStatus(model);
      expect(status.status).toBe('cooldown');
    });

    it('generates real-time status snapshot for UI and SSE', () => {
      tracker.updateQueueState({ depth: 3, isProcessing: true });
      const status = tracker.getStatus();

      expect(status.activeModel).toBeDefined();
      expect(status.cascade.length).toBeGreaterThan(15);
      expect(status.queue.depth).toBe(3);
      expect(status.queue.isProcessing).toBe(true);
      expect(status.autoFallback).toBe(true);
      expect(status.models[status.activeModel]).toBeDefined();
    });

    it('sets accurate baseline limits for Flash-Lite (500 RPD) and Flash Preview (500 RPD)', () => {
      const registry = DynamicModelRegistry.getInstance();
      const flashLiteLatest = registry.getModel('gemini-flash-lite-latest')!;
      expect(flashLiteLatest.rpdLimit).toBe(500);

      const flashLite35 = registry.getModel('gemini-3.5-flash-lite')!;
      expect(flashLite35.rpdLimit).toBe(500);

      const flashPreview = registry.getModel('gemini-3-flash-preview')!;
      expect(flashPreview.rpdLimit).toBe(500);
      expect(flashPreview.rpmLimit).toBe(10);
    });

    it('calculates accurate tier limits with getTierLimits for free vs payg', () => {
      const registry = DynamicModelRegistry.getInstance();
      const flashLite = registry.getModel('gemini-flash-lite-latest')!;
      const pro = registry.getModel('gemini-pro-latest')!;

      const liteFree = getTierLimits(flashLite, 'free');
      expect(liteFree.rpdLimit).toBe(500);

      const litePayg = getTierLimits(flashLite, 'payg');
      expect(litePayg.rpdLimit).toBe(4000);

      const proFree = getTierLimits(pro, 'free');
      expect(proFree.rpdLimit).toBe(50);
      expect(proFree.rpmLimit).toBe(2);

      const proPayg = getTierLimits(pro, 'payg');
      expect(proPayg.rpdLimit).toBe(1000);
      expect(proPayg.rpmLimit).toBe(15);
    });

    it('calibrates RPD manually and persists count', () => {
      const model = 'gemini-flash-lite-latest';
      tracker.calibrateRpd(model, 340);
      expect(tracker.getRpdUsed(model)).toBe(340);

      const status = tracker.getStatus();
      expect(status.models[model].rpdUsed).toBe(340);
    });

    it('allows toggling plan tier between free and payg', () => {
      tracker.setTier('payg');
      expect(tracker.getTier()).toBe('payg');
      const statusPayg = tracker.getStatus();
      expect(statusPayg.tier).toBe('payg');
      expect(statusPayg.models['gemini-flash-lite-latest'].rpdLimit).toBe(4000);

      tracker.setTier('free');
      expect(tracker.getTier()).toBe('free');
      const statusFree = tracker.getStatus();
      expect(statusFree.tier).toBe('free');
      expect(statusFree.models['gemini-flash-lite-latest'].rpdLimit).toBe(500);
    });

    it('auto-calibrates RPD count to limit upon receiving daily quota exhausted error', () => {
      const model = 'gemini-flash-lite-latest';
      tracker.calibrateRpd(model, 250);
      expect(tracker.getRpdUsed(model)).toBe(250);

      tracker.recordRequestFailure(model, 429, 'Resource has been exhausted (e.g. check quota): daily requests per day exceeded');
      expect(tracker.getRpdUsed(model)).toBe(500);
      expect(tracker.getModelStatus(model).status).toBe('exhausted');
    });

    it('sweeps stale sliding-window records and expired cooldowns from RAM', () => {
      const now = Date.now();
      const modelA = 'test-model-a';
      const modelB = 'test-model-b';

      // Old request (90 seconds ago)
      tracker.recordRequestSuccess(modelA, 1000, now - 90_000);
      // Recent request (10 seconds ago)
      tracker.recordRequestSuccess(modelB, 1000, now - 10_000);

      // Cooldown expired 10s ago
      tracker.setCooldown(modelA, 1000, 'test expired', now - 11_000);
      // Cooldown active for next 60s
      tracker.setCooldown(modelB, 60_000, 'test active', now);

      tracker.sweepStaleRecords(now);

      // Model A records should be purged from memory
      expect(tracker.getRpmUsed(modelA, now)).toBe(0);
      expect(tracker.getModelStatus(modelA, now).status).toBe('ready');

      // Model B records should remain
      expect(tracker.getRpmUsed(modelB, now)).toBe(1);
      expect(tracker.getModelStatus(modelB, now).status).toBe('cooldown');
    });
  });
});
