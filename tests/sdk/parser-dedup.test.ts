/**
 * Parser-level deduplication tests
 * Verifies that parseObservations() removes duplicate/near-duplicate observation blocks
 * from a single LLM response before they reach storage.
 */

import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock ModeManager before imports
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }, { id: 'feature' }],
        observation_concepts: [],
      }),
    }),
  },
}));

import { parseObservations } from '../../src/sdk/parser.js';

function makeObservation(title: string, narrative: string, type: string = 'discovery'): string {
  return `<observation>
  <type>${type}</type>
  <title>${title}</title>
  <subtitle>test</subtitle>
  <narrative>${narrative}</narrative>
  <facts><fact>fact1</fact></facts>
  <concepts><concept>concept1</concept></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>`;
}

describe('Parser-level deduplication', () => {
  it('deduplicates identical observation blocks', () => {
    const obs = makeObservation('Same Title', 'Same narrative content');
    const text = `${obs}\n${obs}\n${obs}`;

    const result = parseObservations(text, 'test-correlation');
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('Same Title');
  });

  it('deduplicates near-identical observations with minor wording differences', () => {
    const obs1 = makeObservation('Feature Complete', 'The authentication feature is now fully implemented and tested.');
    const obs2 = makeObservation('Feature Complete', 'The authentication feature is now fully implemented and tested!');
    const text = `${obs1}\n${obs2}`;

    const result = parseObservations(text, 'test-correlation');
    expect(result.length).toBe(1);
  });

  it('preserves genuinely different observations', () => {
    const obs1 = makeObservation('Auth Feature', 'Added JWT authentication middleware.');
    const obs2 = makeObservation('Database Migration', 'Created migration for new users table.');
    const text = `${obs1}\n${obs2}`;

    const result = parseObservations(text, 'test-correlation');
    expect(result.length).toBe(2);
  });

  it('returns single observation as-is (no dedup overhead)', () => {
    const obs = makeObservation('Single Observation', 'Just one observation in this response.');
    const result = parseObservations(obs, 'test-correlation');
    expect(result.length).toBe(1);
    expect(result[0].title).toBe('Single Observation');
  });

  it('deduplicates observations with whitespace differences in title', () => {
    const obs1 = makeObservation('Same  Title', 'Same narrative');
    const obs2 = makeObservation('Same Title', 'Same narrative');
    const text = `${obs1}\n${obs2}`;

    const result = parseObservations(text, 'test-correlation');
    expect(result.length).toBe(1);
  });

  it('keeps observations with different titles but similar narratives', () => {
    const obs1 = makeObservation('Authentication Setup', 'Implemented the user login flow with session management.');
    const obs2 = makeObservation('Database Migration', 'Implemented the user login flow with session management.');
    const text = `${obs1}\n${obs2}`;

    const result = parseObservations(text, 'test-correlation');
    // Different titles → both should be kept (title similarity < 0.85)
    expect(result.length).toBe(2);
  });

  it('returns empty array for text with no observations', () => {
    const result = parseObservations('No observations here', 'test-correlation');
    expect(result.length).toBe(0);
  });

  it('preserves observations with empty/null title or narrative (no false dedup)', () => {
    const obs1 = makeObservation('', 'Some narrative');
    const obs2 = makeObservation('', 'Different narrative');
    const text = `${obs1}\n${obs2}`;

    const result = parseObservations(text, 'test-correlation');
    expect(result.length).toBe(2);
  });

  describe('configurable threshold via CLAUDE_MEM_DEDUP_SIMILARITY_THRESHOLD', () => {
    afterEach(() => {
      delete process.env.CLAUDE_MEM_DEDUP_SIMILARITY_THRESHOLD;
    });

    it('with low threshold (0.5), deduplicates loosely similar observations', () => {
      // These have the same title but different narratives — normally kept at 0.95
      const obs1 = makeObservation('Feature Done', 'Authentication feature implemented with JWT tokens.');
      const obs2 = makeObservation('Feature Done', 'Authentication feature implemented with session cookies.');
      const text = `${obs1}\n${obs2}`;

      // Default threshold (0.95) should keep both
      const resultDefault = parseObservations(text, 'test-correlation');
      expect(resultDefault.length).toBe(2);

      // Low threshold (0.5) should dedup them
      process.env.CLAUDE_MEM_DEDUP_SIMILARITY_THRESHOLD = '0.5';
      const resultLow = parseObservations(text, 'test-correlation');
      expect(resultLow.length).toBe(1);
    });

    it('with threshold of 1.0, only deduplicates exact matches', () => {
      process.env.CLAUDE_MEM_DEDUP_SIMILARITY_THRESHOLD = '1.0';

      // Near-identical (one char difference) should be kept at threshold 1.0
      const obs1 = makeObservation('Feature Complete', 'The authentication feature is now fully implemented and tested.');
      const obs2 = makeObservation('Feature Complete', 'The authentication feature is now fully implemented and tested!');
      const text = `${obs1}\n${obs2}`;

      const result = parseObservations(text, 'test-correlation');
      expect(result.length).toBe(2);
    });
  });
});
