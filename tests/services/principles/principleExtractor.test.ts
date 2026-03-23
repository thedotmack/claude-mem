/**
 * Principle Extractor Tests
 *
 * Tests quality gates, forced extraction tracking, frequency promotion,
 * reviewRecentCorrections batch processing, and storeTriggerPrinciple.
 * Uses in-memory SQLite database (no mocks for DB layer).
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { logger } from '../../../src/utils/logger.js';
import type { Database } from 'bun:sqlite';
import {
  shouldExtractPrinciples,
  checkFrequencyPromotion,
  storeExtractedPrinciples,
  storeTriggerPrinciple,
  markForForcedExtraction,
  consumeForcedExtraction,
  reviewRecentCorrections,
} from '../../../src/services/principles/principleExtractor.js';
import { storeCorrection } from '../../../src/services/sqlite/corrections/store.js';
import { getPrinciples } from '../../../src/services/sqlite/principles/store.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('principleExtractor', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    db.close();
    for (const spy of loggerSpies) spy.mockRestore();
  });

  // ── shouldExtractPrinciples ───────────────────────────────────────

  describe('shouldExtractPrinciples', () => {
    it('should return true if hasCorrection is true', () => {
      expect(shouldExtractPrinciples(null, true)).toBe(true);
    });

    it('should return true if summaryLearned has meaningful content', () => {
      expect(shouldExtractPrinciples('The user prefers TypeScript over JavaScript for all projects', false)).toBe(true);
    });

    it('should return false if summaryLearned is short and no correction', () => {
      expect(shouldExtractPrinciples('ok', false)).toBe(false);
    });

    it('should return false if summaryLearned is null and no correction', () => {
      expect(shouldExtractPrinciples(null, false)).toBe(false);
    });

    it('should return false if summaryLearned is empty string', () => {
      expect(shouldExtractPrinciples('', false)).toBe(false);
    });

    it('should return false if summaryLearned is whitespace only', () => {
      expect(shouldExtractPrinciples('      ', false)).toBe(false);
    });
  });

  // ── Forced extraction tracking ────────────────────────────────────

  describe('markForForcedExtraction / consumeForcedExtraction', () => {
    it('should return false for unmarked sessions', () => {
      expect(consumeForcedExtraction(99999)).toBe(false);
    });

    it('should return true after marking and consume the flag', () => {
      markForForcedExtraction(42);
      expect(consumeForcedExtraction(42)).toBe(true);
      // Second consume should return false (flag consumed)
      expect(consumeForcedExtraction(42)).toBe(false);
    });

    it('should not cross-contaminate between sessions', () => {
      markForForcedExtraction(100);
      expect(consumeForcedExtraction(101)).toBe(false);
      expect(consumeForcedExtraction(100)).toBe(true);
    });

    it('should handle marking the same session twice', () => {
      markForForcedExtraction(50);
      markForForcedExtraction(50);
      expect(consumeForcedExtraction(50)).toBe(true);
      expect(consumeForcedExtraction(50)).toBe(false);
    });
  });

  // ── storeTriggerPrinciple ─────────────────────────────────────────

  describe('storeTriggerPrinciple', () => {
    it('should create a confirmed principle with high confidence', () => {
      const id = storeTriggerPrinciple(db, 'Always use bun instead of npm');
      expect(id).toBeGreaterThan(0);

      const principles = getPrinciples(db);
      const p = principles.find(p => p.id === id);
      expect(p).toBeDefined();
      expect(p!.status).toBe('confirmed');
      expect(p!.confidence).toBeGreaterThanOrEqual(0.9);
      expect(p!.source).toBe('manual');
    });

    it('should merge into existing principle if near-duplicate', () => {
      const id1 = storeTriggerPrinciple(db, 'Always use bun instead of npm');
      const id2 = storeTriggerPrinciple(db, 'Always use bun instead of npm');
      expect(id1).toBe(id2);

      // Frequency should have increased
      const principles = getPrinciples(db);
      const p = principles.find(p => p.id === id1);
      expect(p!.frequency).toBeGreaterThan(1);
    });

    it('should store with specified category', () => {
      const id = storeTriggerPrinciple(db, 'Use prettier for formatting', 'tool_usage');
      const principles = getPrinciples(db);
      const p = principles.find(p => p.id === id);
      expect(p!.category).toBe('tool_usage');
    });
  });

  // ── storeExtractedPrinciples (quality gates) ──────────────────────

  describe('storeExtractedPrinciples', () => {
    it('should store principles that pass quality gates', () => {
      storeExtractedPrinciples(db, [
        { rule: 'Use TypeScript strict mode for all new files', confidence: 0.9, category: 'code_style' },
      ]);
      const principles = getPrinciples(db);
      expect(principles.length).toBe(1);
      expect(principles[0].rule).toBe('Use TypeScript strict mode for all new files');
      // Confidence should be damped to 0.3 max for auto-extract
      expect(principles[0].confidence).toBeLessThanOrEqual(0.3);
    });

    it('should reject vague rules (specificity gate)', () => {
      storeExtractedPrinciples(db, [
        { rule: 'Be good', confidence: 0.9, category: 'general' },
        { rule: 'Do better', confidence: 0.8, category: 'general' },
      ]);
      const principles = getPrinciples(db);
      expect(principles.length).toBe(0);
    });

    it('should reject rules shorter than 8 chars (EN)', () => {
      storeExtractedPrinciples(db, [
        { rule: 'use npm', confidence: 0.9, category: 'general' },
      ]);
      const principles = getPrinciples(db);
      expect(principles.length).toBe(0);
    });

    it('should allow short Chinese rules (4+ chars)', () => {
      storeExtractedPrinciples(db, [
        { rule: '永远用bun', confidence: 0.9, category: 'workflow' },
      ]);
      const principles = getPrinciples(db);
      expect(principles.length).toBe(1);
    });

    it('should merge near-duplicate principles (dedup gate)', () => {
      // Pre-store a principle
      storeTriggerPrinciple(db, 'Always use bun for packages');

      // Auto-extract a near-duplicate (Jaccard > 0.7 with original)
      storeExtractedPrinciples(db, [
        { rule: 'Always use bun for packages instead', confidence: 0.9, category: 'workflow' },
      ]);

      // Should still be 1 principle (merged), not 2
      const principles = getPrinciples(db);
      expect(principles.length).toBe(1);
      expect(principles[0].frequency).toBeGreaterThan(1);
    });
  });

  // ── checkFrequencyPromotion ───────────────────────────────────────

  describe('checkFrequencyPromotion', () => {
    it('should return null when count is below threshold', () => {
      storeCorrection(db, 'session-1', 'Use bun instead', 'prefer_bun', 'workflow');
      storeCorrection(db, 'session-1', 'Use bun instead', 'prefer_bun', 'workflow');

      const result = checkFrequencyPromotion(db, 'prefer_bun', 'Use bun instead of npm', 3);
      expect(result).toBeNull();
    });

    it('should promote when count reaches threshold', () => {
      storeCorrection(db, 'session-1', 'Use bun instead of npm for installs', 'prefer_bun', 'workflow');
      storeCorrection(db, 'session-2', 'Use bun instead of npm for installs', 'prefer_bun', 'workflow');
      storeCorrection(db, 'session-3', 'Use bun instead of npm for installs', 'prefer_bun', 'workflow');

      const result = checkFrequencyPromotion(db, 'prefer_bun', 'Use bun instead of npm for installs', 3);
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);

      // Verify principle was created
      const principles = getPrinciples(db);
      expect(principles.length).toBe(1);
      expect(principles[0].status).toBe('confirmed');
    });

    it('should return null if pattern is null', () => {
      const result = checkFrequencyPromotion(db, null, 'some message', 3);
      expect(result).toBeNull();
    });

    it('should skip vague messages even above threshold', () => {
      storeCorrection(db, 'session-1', 'Be good', 'vague_pattern', 'general');
      storeCorrection(db, 'session-2', 'Be good', 'vague_pattern', 'general');
      storeCorrection(db, 'session-3', 'Be good', 'vague_pattern', 'general');

      const result = checkFrequencyPromotion(db, 'vague_pattern', 'Be good', 3);
      expect(result).toBeNull();
    });
  });

  // ── reviewRecentCorrections ───────────────────────────────────────

  describe('reviewRecentCorrections', () => {
    it('should return 0 promoted when no corrections exist', () => {
      const result = reviewRecentCorrections(db);
      expect(result.promoted).toBe(0);
      expect(result.details).toEqual([]);
    });

    it('should promote recurring pattern-based corrections (2+ occurrences)', () => {
      // Store 3 corrections with same pattern
      storeCorrection(db, 'session-a', 'Always use bun instead of npm for installs', 'prefer_bun', 'workflow');
      storeCorrection(db, 'session-b', 'Always use bun instead of npm for installs', 'prefer_bun', 'workflow');
      storeCorrection(db, 'session-c', 'Always use bun instead of npm for installs', 'prefer_bun', 'workflow');

      const result = reviewRecentCorrections(db);
      expect(result.promoted).toBe(1);
      expect(result.details.length).toBe(1);
      expect(result.details[0].rule).toContain('bun');
    });

    it('should not promote single-occurrence corrections', () => {
      storeCorrection(db, 'session-a', 'Use TypeScript strict mode for all modules', 'pattern_a', 'code_style');
      storeCorrection(db, 'session-b', 'Prefer functional programming style for utils', 'pattern_b', 'code_style');

      const result = reviewRecentCorrections(db);
      expect(result.promoted).toBe(0);
    });

    it('should cluster similar messages without patterns', () => {
      // Store corrections without detected_pattern but with similar text
      storeCorrection(db, 'session-a', 'Don\'t add comments to my functions please', null, 'code_style');
      storeCorrection(db, 'session-b', 'Don\'t add comments to my functions', null, 'code_style');

      const result = reviewRecentCorrections(db);
      expect(result.promoted).toBe(1);
    });

    it('should not promote already-promoted corrections', () => {
      // Store and promote via trigger first
      storeCorrection(db, 'session-a', 'Use bun for everything in this project', 'use_bun', 'workflow');
      storeCorrection(db, 'session-b', 'Use bun for everything in this project', 'use_bun', 'workflow');
      storeCorrection(db, 'session-c', 'Use bun for everything in this project', 'use_bun', 'workflow');

      // First review should promote
      const result1 = reviewRecentCorrections(db);
      expect(result1.promoted).toBe(1);

      // Second review should find nothing (all marked promoted)
      const result2 = reviewRecentCorrections(db);
      expect(result2.promoted).toBe(0);
    });

    it('should respect limit parameter', () => {
      // Store 5 corrections
      for (let i = 0; i < 5; i++) {
        storeCorrection(db, `session-${i}`, 'Prefer bun over npm for all commands', 'prefer_bun', 'workflow');
      }

      // With limit=2, should only look at last 2 corrections
      const result = reviewRecentCorrections(db, 2);
      expect(result.promoted).toBe(1);
    });

    it('should merge into existing principle if near-duplicate found', () => {
      // Pre-create a principle
      storeTriggerPrinciple(db, 'Always use bun instead of npm');

      // Store corrections with similar text
      storeCorrection(db, 'session-a', 'Always use bun instead of npm for installs', 'use_bun', 'workflow');
      storeCorrection(db, 'session-b', 'Always use bun instead of npm for installs', 'use_bun', 'workflow');

      const result = reviewRecentCorrections(db);
      expect(result.promoted).toBe(1);

      // Should still be 1 principle total (merged, not new)
      const principles = getPrinciples(db);
      expect(principles.length).toBe(1);
      expect(principles[0].frequency).toBeGreaterThan(1);
    });
  });
});
