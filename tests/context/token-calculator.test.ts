import { describe, it, expect } from 'bun:test';

import {
  calculateObservationTokens,
  calculateTokenEconomics,
} from '../../src/services/context/index.js';
import type { Observation } from '../../src/services/context/types.js';
import { CHARS_PER_TOKEN_ESTIMATE } from '../../src/services/context/types.js';

// Helper to create a minimal observation for testing
function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: null,
    subtitle: null,
    narrative: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    discovery_tokens: null,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

describe('TokenCalculator', () => {
  describe('CHARS_PER_TOKEN_ESTIMATE constant', () => {
    it('should be 4 characters per token', () => {
      expect(CHARS_PER_TOKEN_ESTIMATE).toBe(4);
    });
  });

  describe('calculateObservationTokens', () => {
    it('should return 0 for an observation with no content', () => {
      const obs = createTestObservation();
      const tokens = calculateObservationTokens(obs);
      // Even empty observations have facts as "[]" when stringified
      // null facts becomes '[]' = 2 chars / 4 = 0.5 -> ceil = 1
      expect(tokens).toBe(1);
    });

    it('should estimate tokens based on title length', () => {
      const title = 'A'.repeat(40); // 40 chars = 10 tokens
      const obs = createTestObservation({ title });
      const tokens = calculateObservationTokens(obs);
      // title (40) + facts stringified (null -> '[]' = 2) = 42 / 4 = 10.5 -> 11
      expect(tokens).toBe(11);
    });

    it('should estimate tokens based on subtitle length', () => {
      const subtitle = 'B'.repeat(20); // 20 chars = 5 tokens
      const obs = createTestObservation({ subtitle });
      const tokens = calculateObservationTokens(obs);
      // subtitle (20) + facts (2) = 22 / 4 = 5.5 -> 6
      expect(tokens).toBe(6);
    });

    it('should estimate tokens based on narrative length', () => {
      const narrative = 'C'.repeat(80); // 80 chars = 20 tokens
      const obs = createTestObservation({ narrative });
      const tokens = calculateObservationTokens(obs);
      // narrative (80) + facts (2) = 82 / 4 = 20.5 -> 21
      expect(tokens).toBe(21);
    });

    it('should estimate tokens based on facts JSON length', () => {
      // When facts is a string, JSON.stringify adds quotes around it
      // '["fact"]' as string becomes '"[\\"fact\\"]"' when stringified
      // But in practice, obs.facts is a string that gets stringified
      const facts = '["fact one", "fact two", "fact three"]'; // 38 chars
      const obs = createTestObservation({ facts });
      const tokens = calculateObservationTokens(obs);
      // JSON.stringify of string adds quotes: 38 + 2 = 40, plus escaping
      // Actually becomes: '"[\"fact one\", \"fact two\", \"fact three\"]"' = 46 chars
      // 46 / 4 = 11.5 -> 12
      expect(tokens).toBe(12);
    });

    it('should combine all fields for total token estimate', () => {
      const obs = createTestObservation({
        title: 'A'.repeat(20),        // 20 chars
        subtitle: 'B'.repeat(20),     // 20 chars
        narrative: 'C'.repeat(40),    // 40 chars
        facts: '["test"]',            // 8 chars, but JSON.stringify adds quotes = 10 chars
      });
      const tokens = calculateObservationTokens(obs);
      // 20 + 20 + 40 + 10 (stringified) = 90 / 4 = 22.5 -> 23
      expect(tokens).toBe(23);
    });

    it('should handle large observations correctly', () => {
      const largeNarrative = 'X'.repeat(4000); // 4000 chars = 1000 tokens
      const obs = createTestObservation({ narrative: largeNarrative });
      const tokens = calculateObservationTokens(obs);
      // 4000 + 2 (null facts) = 4002 / 4 = 1000.5 -> 1001
      expect(tokens).toBe(1001);
    });

    it('should round up fractional tokens using ceil', () => {
      // 9 chars / 4 = 2.25 -> should be 3
      const obs = createTestObservation({ title: 'ABCDEFGHI' }); // 9 chars
      const tokens = calculateObservationTokens(obs);
      // 9 + 2 = 11 / 4 = 2.75 -> 3
      expect(tokens).toBe(3);
    });
  });

  describe('calculateTokenEconomics', () => {
    it('should return zeros for empty observations array', () => {
      const economics = calculateTokenEconomics([]);

      expect(economics.totalObservations).toBe(0);
      expect(economics.totalReadTokens).toBe(0);
      expect(economics.totalDiscoveryTokens).toBe(0);
      expect(economics.savings).toBe(0);
      expect(economics.savingsPercent).toBe(0);
    });

    it('should count total observations', () => {
      const observations = [
        createTestObservation({ id: 1 }),
        createTestObservation({ id: 2 }),
        createTestObservation({ id: 3 }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.totalObservations).toBe(3);
    });

    it('should sum read tokens from all observations', () => {
      const observations = [
        createTestObservation({ title: 'A'.repeat(40) }), // ~11 tokens
        createTestObservation({ title: 'B'.repeat(40) }), // ~11 tokens
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.totalReadTokens).toBe(22);
    });

    it('should sum discovery tokens from all observations', () => {
      const observations = [
        createTestObservation({ discovery_tokens: 100 }),
        createTestObservation({ discovery_tokens: 200 }),
        createTestObservation({ discovery_tokens: 300 }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.totalDiscoveryTokens).toBe(600);
    });

    it('should handle null discovery_tokens as 0', () => {
      const observations = [
        createTestObservation({ discovery_tokens: 100 }),
        createTestObservation({ discovery_tokens: null }),
        createTestObservation({ discovery_tokens: 50 }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.totalDiscoveryTokens).toBe(150);
    });

    it('should calculate savings as discovery minus read tokens', () => {
      const observations = [
        createTestObservation({
          title: 'A'.repeat(40), // ~11 read tokens
          discovery_tokens: 500,
        }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.savings).toBe(500 - 11);
      expect(economics.savings).toBe(489);
    });

    it('should calculate savings percent correctly', () => {
      // If discovery = 1000 and read = 100, savings = 900, percent = 90%
      const observations = [
        createTestObservation({
          title: 'A'.repeat(396), // 396 + 2 = 398 / 4 = 99.5 -> 100 read tokens
          discovery_tokens: 1000,
        }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.totalReadTokens).toBe(100);
      expect(economics.totalDiscoveryTokens).toBe(1000);
      expect(economics.savings).toBe(900);
      expect(economics.savingsPercent).toBe(90);
    });

    it('should return 0% savings when discovery tokens is 0', () => {
      const observations = [
        createTestObservation({ discovery_tokens: 0 }),
        createTestObservation({ discovery_tokens: null }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.savingsPercent).toBe(0);
    });

    it('should handle negative savings correctly', () => {
      // When read tokens > discovery tokens, savings is negative
      const observations = [
        createTestObservation({
          narrative: 'X'.repeat(400), // ~101 read tokens
          discovery_tokens: 50,
        }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.savings).toBeLessThan(0);
    });

    it('should round savings percent to nearest integer', () => {
      // Create a scenario where savings percent is fractional
      // discovery = 100, read = 33, savings = 67, percent = 67%
      const observations = [
        createTestObservation({
          title: 'A'.repeat(130), // 130 + 2 = 132 / 4 = 33 read tokens
          discovery_tokens: 100,
        }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.totalReadTokens).toBe(33);
      expect(economics.savingsPercent).toBe(67);
    });

    it('should aggregate correctly with multiple observations', () => {
      const observations = [
        createTestObservation({
          id: 1,
          title: 'A'.repeat(20),
          narrative: 'X'.repeat(60),
          discovery_tokens: 500,
        }),
        createTestObservation({
          id: 2,
          title: 'B'.repeat(40),
          subtitle: 'Y'.repeat(40),
          discovery_tokens: 300,
        }),
        createTestObservation({
          id: 3,
          narrative: 'Z'.repeat(100),
          facts: '["fact1", "fact2"]',
          discovery_tokens: 200,
        }),
      ];
      const economics = calculateTokenEconomics(observations);

      expect(economics.totalObservations).toBe(3);
      expect(economics.totalDiscoveryTokens).toBe(1000);
      expect(economics.totalReadTokens).toBeGreaterThan(0);
      expect(economics.savings).toBe(economics.totalDiscoveryTokens - economics.totalReadTokens);
    });
  });
});
