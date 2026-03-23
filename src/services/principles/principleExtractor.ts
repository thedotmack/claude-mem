/**
 * Principle Extractor
 * Two extraction paths:
 *   A) Frequency-based: auto-promote when correction count >= threshold
 *   B) SDK auto-extract: parse <principles> XML from summary SDK response
 *
 * Quality gates (cherry-picked from self-evolving-skill):
 *   - Specificity check: reject vague / too-short rules
 *   - Text dedup: fuzzy match against existing principles (>0.85 similarity → merge)
 *   - Low initial confidence: auto-extracted principles start at 0.3
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import {
  getUnpromotedCountByPattern,
  markPromoted,
  getRecentUnpromotedCorrections,
} from '../sqlite/corrections/store.js';
import {
  storePrinciple,
  getPrinciples,
  updatePrincipleStatus,
  incrementFrequency,
} from '../sqlite/principles/store.js';

// ── Quality Gate helpers ──────────────────────────────────────────────

/** Words that make a rule too vague to be useful */
const VAGUE_PATTERNS = [
  /^(be|do|use|try|make|keep|write|follow|ensure|maintain)\s+(good|better|best|nice|clean|proper|correct|right|appropriate)\b/i,
  /^always (be|do|try)\s/i,
];

/**
 * Check if a rule is specific enough to be useful.
 * Rejects overly short or generic rules.
 */
function isSpecificEnough(rule: string): boolean {
  // Must be at least 8 chars (EN) or 4 chars (CN — shorter due to density)
  const hasChinese = /[\u4e00-\u9fff]/.test(rule);
  const minLen = hasChinese ? 4 : 8;
  if (rule.length < minLen) return false;

  // Must contain at least one concrete noun / keyword (not just verbs + adjectives)
  for (const vague of VAGUE_PATTERNS) {
    if (vague.test(rule)) return false;
  }

  return true;
}

/**
 * Simple word-overlap similarity (Jaccard on tokens).
 * Returns 0..1. Good enough for dedup without embedding dependency.
 */
function textSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, ' ').trim();
  const tokensA = new Set(normalize(a).split(/\s+/).filter(Boolean));
  const tokensB = new Set(normalize(b).split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  return intersection / (tokensA.size + tokensB.size - intersection);
}

/**
 * Find a near-duplicate principle (similarity > threshold).
 * Returns the id if found, null otherwise.
 */
function findDuplicate(
  db: Database,
  rule: string,
  threshold: number = 0.7
): { id: number; rule: string } | null {
  const existing = getPrinciples(db, undefined, 200);
  for (const p of existing) {
    if (textSimilarity(rule, p.rule) > threshold) {
      return { id: p.id, rule: p.rule };
    }
  }
  return null;
}

// ── Forced extraction tracking (in-process, no DB needed) ────────────

/** Session IDs that should force principle extraction on the next response */
const forceExtractionSessions = new Set<number>();

/**
 * Mark a session to force principle extraction on its next agent response.
 * Used by the 'reflect' trigger mode.
 */
export function markForForcedExtraction(sessionDbId: number): void {
  forceExtractionSessions.add(sessionDbId);
  logger.info('PRINCIPLES', `Marked session ${sessionDbId} for forced extraction`);
}

/**
 * Check and consume the forced extraction flag for a session.
 * Returns true (and clears the flag) if the session was marked.
 */
export function consumeForcedExtraction(sessionDbId: number): boolean {
  if (forceExtractionSessions.has(sessionDbId)) {
    forceExtractionSessions.delete(sessionDbId);
    logger.info('PRINCIPLES', `Consumed forced extraction for session ${sessionDbId}`);
    return true;
  }
  return false;
}

// ── Conditional extraction check ─────────────────────────────────────

/**
 * Determine whether principle extraction should run for this response.
 * Inspired by self-evolving-skill's adaptive reflection trigger:
 * only extract when there's a genuine learning signal.
 */
export function shouldExtractPrinciples(
  summaryLearned: string | null | undefined,
  hasCorrection: boolean
): boolean {
  // Always extract if user explicitly corrected something
  if (hasCorrection) return true;

  // Extract if summary.learned field has meaningful content
  if (summaryLearned && summaryLearned.trim().length > 10) return true;

  // Otherwise skip — avoid noisy extraction on routine summaries
  return false;
}

// ── Path A: Frequency-based promotion ────────────────────────────────

/**
 * Path A: Frequency-based promotion
 * Called after a correction is stored. If the detected_pattern has been seen
 * >= threshold times (unpromoted), auto-create a confirmed principle.
 */
export function checkFrequencyPromotion(
  db: Database,
  detectedPattern: string | null,
  userMessage: string,
  threshold: number = 3
): number | null {
  if (!detectedPattern) return null;

  const count = getUnpromotedCountByPattern(db, detectedPattern);
  if (count < threshold) return null;

  // Check for near-duplicate principle
  const dup = findDuplicate(db, userMessage);
  if (dup) {
    // Merge: just increment the existing principle's frequency
    incrementFrequency(db, dup.id);
    markPromoted(db, detectedPattern, dup.id);
    logger.info('PRINCIPLES', `Merged correction into existing principle | id=${dup.id} | pattern=${detectedPattern}`);
    return dup.id;
  }

  // Specificity gate
  if (!isSpecificEnough(userMessage)) {
    logger.debug('PRINCIPLES', `Skipped promotion: rule too vague | pattern=${detectedPattern} | msg=${userMessage.slice(0, 50)}`);
    return null;
  }

  // Auto-create principle as 'confirmed'
  const principleId = storePrinciple(db, userMessage, 'correction', 0.7, 'general');
  updatePrincipleStatus(db, principleId, 'confirmed');

  // Mark all matching corrections as promoted
  markPromoted(db, detectedPattern, principleId);

  logger.info('PRINCIPLES', `Auto-promoted principle from ${count} corrections | id=${principleId} | pattern=${detectedPattern}`);
  return principleId;
}

// ── Path B: SDK auto-extract with quality gate ───────────────────────

/**
 * Store principles parsed from SDK response into the database.
 * Applies quality gates:
 *   1. Specificity check — reject vague rules
 *   2. Text dedup — merge into existing principle if similarity > 0.7
 *   3. Low initial confidence — start at 0.3 (needs repeated extraction to reach injection threshold)
 */
export function storeExtractedPrinciples(
  db: Database,
  principles: Array<{ rule: string; confidence: number; category: string }>
): void {
  let stored = 0;
  let merged = 0;
  let rejected = 0;

  for (const p of principles) {
    // Gate 1: specificity
    if (!isSpecificEnough(p.rule)) {
      rejected++;
      logger.debug('PRINCIPLES', `Rejected vague principle: "${p.rule.slice(0, 50)}"`);
      continue;
    }

    // Gate 2: dedup — merge if near-duplicate exists
    const dup = findDuplicate(db, p.rule);
    if (dup) {
      incrementFrequency(db, dup.id);
      merged++;
      logger.debug('PRINCIPLES', `Merged into existing principle id=${dup.id}: "${p.rule.slice(0, 50)}"`);
      continue;
    }

    // Gate 3: lower initial confidence for auto-extracted (must earn trust)
    const dampedConfidence = Math.min(p.confidence, 0.3);
    storePrinciple(db, p.rule, 'auto_extract', dampedConfidence, p.category);
    stored++;
  }

  if (stored + merged > 0) {
    logger.info('PRINCIPLES', `Auto-extract results: ${stored} stored, ${merged} merged, ${rejected} rejected`);
  }
}

/**
 * Store a single principle from an explicit trigger phrase.
 * Bypasses quality gates — the user explicitly requested this rule.
 * Stored as 'confirmed' with high confidence.
 */
export function storeTriggerPrinciple(
  db: Database,
  rule: string,
  category: string = 'general'
): number {
  // Still check for near-duplicates to avoid exact copies
  const dup = findDuplicate(db, rule);
  if (dup) {
    incrementFrequency(db, dup.id);
    // Promote if still candidate
    updatePrincipleStatus(db, dup.id, 'confirmed');
    logger.info('PRINCIPLES', `Trigger phrase merged into existing principle id=${dup.id}`);
    return dup.id;
  }

  const id = storePrinciple(db, rule, 'manual', 0.9, category);
  updatePrincipleStatus(db, id, 'confirmed');
  logger.info('PRINCIPLES', `Trigger phrase created principle id=${id}: "${rule.slice(0, 60)}"`);
  return id;
}

// ── Review mode: batch-process recent corrections ─────────────────────

/**
 * Review recent unpromoted corrections and batch-promote recurring patterns.
 * Used by the 'review' trigger mode.
 *
 * Groups corrections by detected_pattern (or text similarity for unpattern'd ones),
 * then promotes clusters of 2+ into confirmed principles.
 */
export function reviewRecentCorrections(
  db: Database,
  limit: number = 50
): { promoted: number; details: Array<{ id: number; rule: string }> } {
  const rows = getRecentUnpromotedCorrections(db, limit);
  if (rows.length === 0) {
    logger.info('PRINCIPLES', 'Review: no unpromoted corrections found');
    return { promoted: 0, details: [] };
  }

  // Group by detected_pattern
  const patternGroups = new Map<string, typeof rows>();
  const noPattern: typeof rows = [];

  for (const r of rows) {
    if (r.detected_pattern) {
      const group = patternGroups.get(r.detected_pattern) || [];
      group.push(r);
      patternGroups.set(r.detected_pattern, group);
    } else {
      noPattern.push(r);
    }
  }

  const promoted: Array<{ id: number; rule: string }> = [];

  // Promote pattern groups with 2+ corrections (lower threshold than normal 3)
  for (const [pattern, group] of patternGroups) {
    if (group.length < 2) continue;

    const rule = group[0].user_message;
    if (!isSpecificEnough(rule)) continue;

    const dup = findDuplicate(db, rule);
    if (dup) {
      incrementFrequency(db, dup.id);
      markPromoted(db, pattern, dup.id);
      promoted.push({ id: dup.id, rule: dup.rule });
    } else {
      const id = storePrinciple(db, rule, 'review', 0.6, group[0].category);
      updatePrincipleStatus(db, id, 'confirmed');
      markPromoted(db, pattern, id);
      promoted.push({ id, rule });
    }
  }

  // Cluster no-pattern corrections by text similarity (>0.5)
  const used = new Set<number>();
  for (let i = 0; i < noPattern.length; i++) {
    if (used.has(i)) continue;
    const cluster = [noPattern[i]];
    used.add(i);

    for (let j = i + 1; j < noPattern.length; j++) {
      if (used.has(j)) continue;
      if (textSimilarity(noPattern[i].user_message, noPattern[j].user_message) > 0.5) {
        cluster.push(noPattern[j]);
        used.add(j);
      }
    }

    if (cluster.length < 2) continue;

    const rule = cluster[0].user_message;
    if (!isSpecificEnough(rule)) continue;

    const dup = findDuplicate(db, rule);
    if (dup) {
      incrementFrequency(db, dup.id);
      promoted.push({ id: dup.id, rule: dup.rule });
    } else {
      const id = storePrinciple(db, rule, 'review', 0.6, cluster[0].category);
      updatePrincipleStatus(db, id, 'confirmed');
      promoted.push({ id, rule });
    }
  }

  logger.info('PRINCIPLES', `Review completed: ${promoted.length} principles promoted from ${rows.length} corrections`);
  return { promoted: promoted.length, details: promoted };
}
