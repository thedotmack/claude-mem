import { describe, it, expect } from 'vitest';
import { validateConcepts } from '../../src/sdk/parser.js';
import type { ModeConfig } from '../../src/services/domain/types.js';

/**
 * Build a minimal ModeConfig with the given observation types and concepts.
 */
function buildMode(
  types: string[] = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision'],
  concepts: string[] = ['how-it-works', 'why-it-exists', 'what-changed', 'problem-solution', 'gotcha', 'pattern', 'trade-off']
): ModeConfig {
  return {
    name: 'test',
    description: 'test mode',
    version: '1.0.0',
    observation_types: types.map(id => ({
      id,
      label: id,
      description: id,
      emoji: '',
      work_emoji: ''
    })),
    observation_concepts: concepts.map(id => ({
      id,
      label: id,
      description: id
    })),
    prompts: {} as ModeConfig['prompts']
  };
}

const codeMode = buildMode();

describe('validateConcepts', () => {
  describe('direct match', () => {
    it('should pass through valid concepts unchanged', () => {
      const result = validateConcepts(
        ['how-it-works', 'what-changed'],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['how-it-works', 'what-changed']);
    });

    it('should normalize case to lowercase', () => {
      const result = validateConcepts(
        ['How-It-Works', 'WHAT-CHANGED'],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['how-it-works', 'what-changed']);
    });

    it('should trim whitespace', () => {
      const result = validateConcepts(
        ['  how-it-works  ', 'pattern '],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['how-it-works', 'pattern']);
    });
  });

  describe('colon-prefix normalization', () => {
    it('should extract valid concept from colon-prefixed description', () => {
      const result = validateConcepts(
        ['how-it-works: understanding the auth flow'],
        'discovery',
        codeMode
      );
      expect(result).toEqual(['how-it-works']);
    });

    it('should handle multiple colon-prefixed concepts', () => {
      const result = validateConcepts(
        ['gotcha: edge case with null values', 'pattern: factory function approach'],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['gotcha', 'pattern']);
    });

    it('should drop colon-prefixed concepts with invalid prefix', () => {
      const result = validateConcepts(
        ['authentication: understanding OAuth2 flows'],
        'discovery',
        codeMode
      );
      // All dropped, inferred default for discovery = how-it-works
      expect(result).toEqual(['how-it-works']);
    });
  });

  describe('invalid concept removal', () => {
    it('should drop freeform text concepts', () => {
      const result = validateConcepts(
        ['how-it-works', 'authentication-flow', 'database-migration'],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['how-it-works']);
    });

    it('should drop long sentence concepts', () => {
      const result = validateConcepts(
        ['pattern', 'HTTP POST with NDJSON payload sends test results to DIG'],
        'change',
        codeMode
      );
      expect(result).toEqual(['pattern']);
    });
  });

  describe('type removal from concepts', () => {
    it('should remove observation type from concepts array', () => {
      const result = validateConcepts(
        ['discovery', 'how-it-works', 'pattern'],
        'discovery',
        codeMode
      );
      expect(result).toEqual(['how-it-works', 'pattern']);
    });
  });

  describe('deduplication', () => {
    it('should deduplicate after normalization', () => {
      const result = validateConcepts(
        ['how-it-works', 'how-it-works: understanding the auth flow'],
        'discovery',
        codeMode
      );
      expect(result).toEqual(['how-it-works']);
    });

    it('should deduplicate exact duplicates', () => {
      const result = validateConcepts(
        ['pattern', 'pattern', 'gotcha'],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['pattern', 'gotcha']);
    });
  });

  describe('default inference when all concepts invalid', () => {
    it('should infer problem-solution for bugfix', () => {
      const result = validateConcepts(
        ['authentication-flow', 'database-migration'],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['problem-solution']);
    });

    it('should infer what-changed for feature', () => {
      const result = validateConcepts(
        ['new-endpoint'],
        'feature',
        codeMode
      );
      expect(result).toEqual(['what-changed']);
    });

    it('should infer what-changed for refactor', () => {
      const result = validateConcepts(
        ['code-restructure'],
        'refactor',
        codeMode
      );
      expect(result).toEqual(['what-changed']);
    });

    it('should infer what-changed for change', () => {
      const result = validateConcepts(
        ['config-update'],
        'change',
        codeMode
      );
      expect(result).toEqual(['what-changed']);
    });

    it('should infer how-it-works for discovery', () => {
      const result = validateConcepts(
        ['investigation-results'],
        'discovery',
        codeMode
      );
      expect(result).toEqual(['how-it-works']);
    });

    it('should infer trade-off for decision', () => {
      const result = validateConcepts(
        ['architectural-choice'],
        'decision',
        codeMode
      );
      expect(result).toEqual(['trade-off']);
    });

    it('should infer from empty concepts array', () => {
      const result = validateConcepts(
        [],
        'bugfix',
        codeMode
      );
      expect(result).toEqual(['problem-solution']);
    });
  });

  describe('mode-aware fallback', () => {
    it('should fall back to first concept in mode when type has no mapping', () => {
      const customMode = buildMode(
        ['entity', 'relationship'],
        ['subject', 'connection', 'timeline']
      );
      const result = validateConcepts(
        ['invalid-concept'],
        'entity',
        customMode
      );
      // 'entity' not in typeToConceptMap, falls back to first mode concept
      expect(result).toEqual(['subject']);
    });

    it('should fall back to first concept when mapped concept not in mode', () => {
      const customMode = buildMode(
        ['bugfix'],
        ['gotcha', 'pattern']  // no 'problem-solution'
      );
      const result = validateConcepts(
        ['invalid'],
        'bugfix',
        customMode
      );
      // bugfix maps to problem-solution, but that's not in this mode
      // Falls back to first concept: gotcha
      expect(result).toEqual(['gotcha']);
    });

    it('should validate concepts against custom mode concept list', () => {
      const customMode = buildMode(
        ['entity'],
        ['subject', 'connection']
      );
      const result = validateConcepts(
        ['subject', 'how-it-works', 'connection'],
        'entity',
        customMode
      );
      // how-it-works not in this mode's concepts, dropped
      expect(result).toEqual(['subject', 'connection']);
    });
  });
});
