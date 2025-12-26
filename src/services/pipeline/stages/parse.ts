/**
 * Parse Stage - Extract structured data from LLM response
 *
 * Uses fault-tolerant parsing with fallbacks.
 *
 * Responsibilities:
 * - Parse XML-formatted observations and summaries
 * - Validate field types and values
 * - Provide fallbacks for missing/invalid data
 * - Track parsing metrics
 */

import { logger } from '../../../utils/logger.js';
import {
  parseObservations,
  parseSummary,
  getParseMetrics,
  getParseSuccessRate
} from '../../../sdk/parser.js';
import type {
  ParseInput,
  ParseOutput,
  PipelineConfig
} from '../../../types/pipeline.js';

type ParseConfig = PipelineConfig['stages']['parse'];

export class ParseStage {
  private config: ParseConfig;

  constructor(config: ParseConfig) {
    this.config = config;
  }

  async execute(input: ParseInput): Promise<ParseOutput> {
    const { responseText, expectedFormat } = input;

    let observations: ParseOutput['observations'] = [];
    let summary: ParseOutput['summary'];

    // Parse observations
    if (expectedFormat === 'observation' || expectedFormat === 'both') {
      const parsedObs = parseObservations(responseText);
      observations = parsedObs.map(obs => ({
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        facts: obs.facts,
        narrative: obs.narrative,
        concepts: obs.concepts,
        files_read: obs.files_read,
        files_modified: obs.files_modified
      }));
    }

    // Parse summary
    if (expectedFormat === 'summary' || expectedFormat === 'both') {
      const parsedSummary = parseSummary(responseText);
      if (parsedSummary) {
        summary = {
          request: parsedSummary.request,
          investigated: parsedSummary.investigated,
          learned: parsedSummary.learned,
          completed: parsedSummary.completed,
          next_steps: parsedSummary.next_steps,
          notes: parsedSummary.notes
        };
      }
    }

    // Get metrics
    const metrics = getParseMetrics();
    const successRate = getParseSuccessRate();

    const output: ParseOutput = {
      observations,
      summary,
      parseMetrics: {
        successRate,
        fallbacksUsed: metrics.fallbacksUsed,
        fieldsExtracted: metrics.successfulExtractions
      }
    };

    if (this.config.logMetrics) {
      logger.debug('PIPELINE:PARSE', 'Parsing complete', {
        observationCount: observations.length,
        hasSummary: !!summary,
        successRate: `${successRate.toFixed(1)}%`,
        fallbacksUsed: metrics.fallbacksUsed
      });
    }

    // Validate in strict mode
    if (this.config.strictMode) {
      if (observations.length === 0 && !summary) {
        throw new Error('Parse failed: No observations or summary found in response');
      }
    }

    return output;
  }
}
