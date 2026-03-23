/**
 * Correction Detector Tests
 *
 * Tests the 3-mode trigger phrase system (direct/reflect/review),
 * correction detection, session dedup, and fingerprinting.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  detectTriggerPhrase,
  detectCorrection,
  isDuplicateInSession,
  buildCorrectionFingerprint,
} from '../../../src/services/principles/correctionDetector.js';
import type { TriggerMode } from '../../../src/services/principles/correctionDetector.js';

describe('correctionDetector', () => {
  // ── detectTriggerPhrase: Direct Mode ──────────────────────────────

  describe('detectTriggerPhrase — direct mode', () => {
    it('should detect English direct trigger "remember rule: ..."', () => {
      const result = detectTriggerPhrase('remember rule: always use bun');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('direct');
      expect(result.rule).toBe('always use bun');
    });

    it('should detect Chinese direct trigger "记住规则：..."', () => {
      const result = detectTriggerPhrase('记住规则：永远用bun');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('direct');
      expect(result.rule).toBe('永远用bun');
    });

    it('should detect "#principle: ..."', () => {
      const result = detectTriggerPhrase('#principle: never add docstrings');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('direct');
      expect(result.rule).toBe('never add docstrings');
    });

    it('should detect "new rule: ..."', () => {
      const result = detectTriggerPhrase('new rule: prefer functional style');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('direct');
      expect(result.rule).toBe('prefer functional style');
    });

    it('should detect "添加规则：..."', () => {
      const result = detectTriggerPhrase('添加规则：不要加注释');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('direct');
      expect(result.rule).toBe('不要加注释');
    });

    it('should detect "#规则：..." with Chinese colon', () => {
      const result = detectTriggerPhrase('#规则：用TypeScript');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('direct');
      expect(result.rule).toBe('用TypeScript');
    });

    it('should reject direct trigger with rule shorter than 3 chars', () => {
      const result = detectTriggerPhrase('remember rule: ab');
      expect(result.isTriggered).toBe(false);
    });

    it('should reject empty or very short input', () => {
      expect(detectTriggerPhrase('').isTriggered).toBe(false);
      expect(detectTriggerPhrase('a').isTriggered).toBe(false);
    });
  });

  // ── detectTriggerPhrase: Reflect Mode ─────────────────────────────

  describe('detectTriggerPhrase — reflect mode', () => {
    it('should detect "总结规则"', () => {
      const result = detectTriggerPhrase('总结规则');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('reflect');
      expect(result.rule).toBeNull();
    });

    it('should detect "提取教训"', () => {
      const result = detectTriggerPhrase('提取教训');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('reflect');
    });

    it('should detect "提取原则"', () => {
      const result = detectTriggerPhrase('提取原则');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('reflect');
    });

    it('should detect "#reflect"', () => {
      const result = detectTriggerPhrase('#reflect');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('reflect');
    });

    it('should detect "extract principles"', () => {
      const result = detectTriggerPhrase('extract principles');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('reflect');
    });

    it('should detect "extract lessons"', () => {
      const result = detectTriggerPhrase('extract lessons');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('reflect');
    });

    it('should detect with trailing whitespace', () => {
      const result = detectTriggerPhrase('总结规则  ');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('reflect');
    });
  });

  // ── detectTriggerPhrase: Review Mode ──────────────────────────────

  describe('detectTriggerPhrase — review mode', () => {
    it('should detect "回顾反馈"', () => {
      const result = detectTriggerPhrase('回顾反馈');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('review');
      expect(result.rule).toBeNull();
    });

    it('should detect "回顾最近的反馈"', () => {
      const result = detectTriggerPhrase('回顾最近的反馈');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('review');
    });

    it('should detect "回顾最近反馈"', () => {
      const result = detectTriggerPhrase('回顾最近反馈');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('review');
    });

    it('should detect "#review-principles"', () => {
      const result = detectTriggerPhrase('#review-principles');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('review');
    });

    it('should detect "review feedback"', () => {
      const result = detectTriggerPhrase('review feedback');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('review');
    });

    it('should detect "review recent feedback"', () => {
      const result = detectTriggerPhrase('review recent feedback');
      expect(result.isTriggered).toBe(true);
      expect(result.mode).toBe('review');
    });
  });

  // ── detectTriggerPhrase: Non-triggers ─────────────────────────────

  describe('detectTriggerPhrase — should NOT trigger', () => {
    it('should not trigger on normal conversation', () => {
      expect(detectTriggerPhrase('help me fix this bug').isTriggered).toBe(false);
    });

    it('should not trigger on partial matches', () => {
      // "review" alone should not trigger — needs "review feedback"
      expect(detectTriggerPhrase('please review this code').isTriggered).toBe(false);
    });

    it('should not trigger on "remember" without "rule:"', () => {
      expect(detectTriggerPhrase('remember to test this later').isTriggered).toBe(false);
    });
  });

  // ── detectCorrection ──────────────────────────────────────────────

  describe('detectCorrection', () => {
    it('should detect English correction "don\'t add comments"', () => {
      const result = detectCorrection("don't add comments to my code");
      expect(result.isCorrection).toBe(true);
      expect(result.patterns.length).toBeGreaterThan(0);
    });

    it('should detect English correction "should be X"', () => {
      const result = detectCorrection('the variable name should be camelCase');
      expect(result.isCorrection).toBe(true);
      expect(result.category).toBe('behavioral');
    });

    it('should detect "always use bun"', () => {
      const result = detectCorrection('always use bun instead of npm');
      expect(result.isCorrection).toBe(true);
      expect(result.category).toBe('tool_usage');
    });

    it('should detect Chinese correction "不要加注释"', () => {
      const result = detectCorrection('不要加注释');
      expect(result.isCorrection).toBe(true);
    });

    it('should detect Chinese correction "错了，应该用bun"', () => {
      const result = detectCorrection('错了，应该用bun');
      expect(result.isCorrection).toBe(true);
    });

    it('should detect "use X instead"', () => {
      const result = detectCorrection('use prettier instead of eslint for formatting');
      expect(result.isCorrection).toBe(true);
      expect(result.category).toBe('tool_usage');
    });

    it('should return isCorrection=false for normal messages', () => {
      const result = detectCorrection('can you help me create a function?');
      expect(result.isCorrection).toBe(false);
      expect(result.patterns).toEqual([]);
    });

    it('should return isCorrection=false for very short input', () => {
      expect(detectCorrection('hi').isCorrection).toBe(false);
      expect(detectCorrection('').isCorrection).toBe(false);
    });
  });

  // ── Session Dedup ─────────────────────────────────────────────────

  describe('isDuplicateInSession', () => {
    it('should return false on first occurrence', () => {
      const sessionId = `dedup-test-${Date.now()}`;
      const fingerprint = 'pattern-a|pattern-b';
      expect(isDuplicateInSession(sessionId, fingerprint)).toBe(false);
    });

    it('should return true on second occurrence in same session', () => {
      const sessionId = `dedup-test2-${Date.now()}`;
      const fingerprint = 'pattern-x';
      isDuplicateInSession(sessionId, fingerprint); // first call registers
      expect(isDuplicateInSession(sessionId, fingerprint)).toBe(true);
    });

    it('should not cross-contaminate between sessions', () => {
      const session1 = `dedup-s1-${Date.now()}`;
      const session2 = `dedup-s2-${Date.now()}`;
      const fingerprint = 'shared-pattern';

      isDuplicateInSession(session1, fingerprint);
      // Same fingerprint in different session should NOT be duplicate
      expect(isDuplicateInSession(session2, fingerprint)).toBe(false);
    });

    it('should allow different fingerprints in same session', () => {
      const sessionId = `dedup-multi-${Date.now()}`;
      isDuplicateInSession(sessionId, 'fp-1');
      expect(isDuplicateInSession(sessionId, 'fp-2')).toBe(false);
    });
  });

  // ── buildCorrectionFingerprint ────────────────────────────────────

  describe('buildCorrectionFingerprint', () => {
    it('should produce deterministic output regardless of input order', () => {
      const fp1 = buildCorrectionFingerprint(['b', 'a', 'c']);
      const fp2 = buildCorrectionFingerprint(['c', 'a', 'b']);
      expect(fp1).toBe(fp2);
    });

    it('should produce pipe-delimited string', () => {
      const fp = buildCorrectionFingerprint(['alpha', 'beta']);
      expect(fp).toBe('alpha|beta');
    });

    it('should handle single pattern', () => {
      const fp = buildCorrectionFingerprint(['only']);
      expect(fp).toBe('only');
    });

    it('should handle empty array', () => {
      const fp = buildCorrectionFingerprint([]);
      expect(fp).toBe('');
    });
  });
});
