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
  parseSummary
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
    let parseErrors = 0;

    // Parse observations
    if (expectedFormat === 'observation' || expectedFormat === 'both') {
      try {
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
      } catch (error) {
        parseErrors++;
        logger.warn('PIPELINE', 'Failed to parse observations', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Parse summary
    if (expectedFormat === 'summary' || expectedFormat === 'both') {
      try {
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
      } catch (error) {
        parseErrors++;
        logger.warn('PIPELINE', 'Failed to parse summary', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Calculate simple metrics
    const totalParsed = observations.length + (summary ? 1 : 0);
    const successRate = totalParsed > 0 ? ((totalParsed / (totalParsed + parseErrors)) * 100) : 0;

    const output: ParseOutput = {
      observations,
      summary,
      parseMetrics: {
        successRate,
        fallbacksUsed: parseErrors,
        fieldsExtracted: totalParsed
      }
    };

    if (this.config.logMetrics) {
      logger.debug('PIPELINE', 'Parsing complete', {
        observationCount: observations.length,
        hasSummary: !!summary,
        successRate: `${successRate.toFixed(1)}%`,
        parseErrors
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
