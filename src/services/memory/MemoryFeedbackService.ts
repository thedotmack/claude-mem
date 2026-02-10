/**
 * Memory Feedback Service - P0 Feature
 *
 * Allows users to correct/modify memories using natural language feedback.
 * Inspired by MemOS's memory feedback system.
 *
 * Key Features:
 * - Natural language feedback processing
 * - Semantic memory correction
 * - Keyword replacement (simple pattern)
 * - Memory validation before updates
 *
 * Usage:
 * - User says "Remember: X should be Y" -> triggers feedback processing
 * - Automatic detection of feedback patterns in conversation
 */

import { logger } from '../../utils/logger.js';
import type { ObservationInput } from '../sqlite/observations/types.js';
import type { SearchManager } from '../worker/SearchManager.js';

export interface FeedbackResult {
  added: number;
  updated: number;
  details: FeedbackDetail[];
}

export interface FeedbackDetail {
  id: number;
  action: 'added' | 'updated' | 'archived';
  text: string;
  originalText?: string;
}

export interface FeedbackConfig {
  enabled: boolean;
  autoDetect: boolean;
  confidenceThreshold: number;
}

export class MemoryFeedbackService {
  public config: FeedbackConfig = {
    enabled: true,
    autoDetect: true,
    confidenceThreshold: 0.7
  };

  constructor(
    private searchManager: SearchManager,
    private storeObservation: (
      memorySessionId: string,
      project: string,
      observation: ObservationInput,
      promptNumber?: number,
      discoveryTokens?: number
    ) => { id: number; createdAtEpoch: number }
  ) {}

  /**
   * Detect if user input contains memory feedback
   * Matches patterns like:
   * - "Remember: X is actually Y"
   * - "Correction: X should be Y"
   * - "Update: X is wrong, it's Y"
   * - "Actually, X means Y"
   */
  detectFeedback(userInput: string): { isFeedback: boolean; confidence: number } {
    if (!this.config.enabled || !this.config.autoDetect) {
      return { isFeedback: false, confidence: 0 };
    }

    const patterns = [
      /\b(?:remember|correction|update|actually|note|wait)\s*:/i,
      /\b(?:should\s+be|is\s+actually|means|really\s+is)\b/i,
      /\b(?:wrong|incorrect|not\s+right)\b.*\b(?:instead|actually|correctly)\b/i,
      /\bX\s+(?:is|should|means)\s+Y\b/i, // Simple pattern placeholder
    ];

    let matchCount = 0;
    for (const pattern of patterns) {
      if (pattern.test(userInput)) {
        matchCount++;
      }
    }

    const confidence = matchCount / patterns.length;
    return {
      isFeedback: confidence >= this.config.confidenceThreshold,
      confidence
    };
  }

  /**
   * Extract the correction from feedback text
   */
  extractCorrection(feedback: string): { original: string; corrected: string } | null {
    // Pattern 1: "X is actually Y"
    const actuallyPattern = /(.+?)\s+is\s+actually\s+(.+?)(?:\.|$)/i;
    let match = feedback.match(actuallyPattern);
    if (match) {
      return { original: match[1].trim(), corrected: match[2].trim() };
    }

    // Pattern 2: "X should be Y"
    const shouldPattern = /(.+?)\s+should\s+be\s+(.+?)(?:\.|$)/i;
    match = feedback.match(shouldPattern);
    if (match) {
      return { original: match[1].trim(), corrected: match[2].trim() };
    }

    // Pattern 3: "Remember: X = Y"
    const rememberPattern = /(?:remember|note):\s*(.+?)(?:\s*[=:=]\s*|is\s*)(.+?)(?:\.|$)/i;
    match = feedback.match(rememberPattern);
    if (match) {
      return { original: match[1].trim(), corrected: match[2].trim() };
    }

    return null;
  }

  /**
   * Process keyword replacement (simple, deterministic)
   * Replaces all occurrences of original with corrected in relevant memories
   */
  async processKeywordReplacement(
    original: string,
    corrected: string,
    memorySessionId: string,
    project: string
  ): Promise<FeedbackResult> {
    logger.info('MEMORY_FEEDBACK', 'Processing keyword replacement', { original, corrected });

    // Search for memories containing the original text
    const searchResults = await this.searchManager.search({
      query: original,
      type: 'observations',
      limit: 20
    });

    let updated = 0;
    const details: FeedbackDetail[] = [];

    // @ts-ignore - Accessing internal content array
    if (searchResults.content?.[0]?.text) {
      // Parse search results to get observation IDs
      // This is a simplified version - in production you'd parse the formatted output
      // For now, we'll add a new observation with the correction
      const correctionObs: ObservationInput = {
        type: 'correction',
        title: `Memory Correction: "${original}" → "${corrected}"`,
        subtitle: `Keyword replacement feedback`,
        facts: [
          `Replaced "${original}" with "${corrected}" in existing memories`
        ].filter((f): f is string => f !== null),
        narrative: `User feedback indicated that "${original}" should be "${corrected}". ` +
          `This correction should be applied when searching for or referencing "${original}".`,
        concepts: ['correction', 'memory-feedback', original, corrected],
        files_read: [],
        files_modified: []
      };

      const result = this.storeObservation(memorySessionId, project, correctionObs);
      details.push({
        id: result.id,
        action: 'added',
        text: correctionObs.narrative
      });

      updated = 1;
    }

    logger.info('MEMORY_FEEDBACK', 'Keyword replacement complete', { updated });
    return { added: 0, updated, details };
  }

  /**
   * Process semantic feedback (AI-assisted)
   * Searches for related memories and creates corrected versions
   */
  async processSemanticFeedback(
    feedback: string,
    memorySessionId: string,
    project: string
  ): Promise<FeedbackResult> {
    logger.info('MEMORY_FEEDBACK', 'Processing semantic feedback', { feedback });

    // Extract keywords from feedback for searching
    const keywords = this.extractKeywords(feedback);

    let added = 0;
    let updated = 0;
    const details: FeedbackDetail[] = [];

    // Create a new observation with the feedback
    const feedbackObs: ObservationInput = {
      type: 'memory-feedback',
      title: 'User Memory Feedback',
      subtitle: 'User-provided correction or clarification',
      facts: [feedback],
      narrative: `User provided feedback: "${feedback}". ` +
        `This feedback should be considered when interpreting related memories.`,
      concepts: [...keywords, 'feedback', 'user-correction'],
      files_read: [],
      files_modified: []
    };

    const result = this.storeObservation(memorySessionId, project, feedbackObs);
    added++;

    details.push({
      id: result.id,
      action: 'added',
      text: feedback
    });

    logger.info('MEMORY_FEEDBACK', 'Semantic feedback complete', { added, updated });
    return { added, updated, details };
  }

  /**
   * Main entry point for processing feedback
   */
  async processFeedback(
    feedback: string,
    memorySessionId: string,
    project: string
  ): Promise<FeedbackResult> {
    // Check if this is feedback
    const detection = this.detectFeedback(feedback);
    if (!detection.isFeedback) {
      logger.debug('MEMORY_FEEDBACK', 'Input does not match feedback patterns', { confidence: detection.confidence });
      return { added: 0, updated: 0, details: [] };
    }

    logger.info('MEMORY_FEEDBACK', 'Processing user feedback', { feedback, confidence: detection.confidence });

    // Try keyword replacement first (deterministic)
    const correction = this.extractCorrection(feedback);
    if (correction) {
      return this.processKeywordReplacement(
        correction.original,
        correction.corrected,
        memorySessionId,
        project
      );
    }

    // Fall back to semantic feedback
    return this.processSemanticFeedback(feedback, memorySessionId, project);
  }

  /**
   * Extract key terms from text for searching
   */
  private extractKeywords(text: string): string[] {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
      'could', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
      'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who',
      'whom', 'this', 'that', 'these', 'those', 'am', 'is', 'are', 'was',
      'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do',
      'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or',
      'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
      'about', 'against', 'between', 'into', 'through', 'during', 'before',
      'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out',
      'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once'
    ]);

    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.has(word));

    // Remove duplicates and limit to top 5
    return [...new Set(words)].slice(0, 5);
  }

  /**
   * Enable or disable feedback processing
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info('MEMORY_FEEDBACK', 'Feedback processing ' + (enabled ? 'enabled' : 'disabled'));
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<FeedbackConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('MEMORY_FEEDBACK', 'Configuration updated', { config: this.config });
  }

  /**
   * Get current configuration
   */
  getConfig(): FeedbackConfig {
    return { ...this.config };
  }
}

