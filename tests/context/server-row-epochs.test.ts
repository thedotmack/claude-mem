import { describe, expect, it } from 'bun:test';
import { toLocalObservationShape, toLocalSummaryShape } from '../../src/services/context/ServerContextRows.js';

for (const [name, convert] of [['observation', toLocalObservationShape], ['summary', toLocalSummaryShape]] as const) {
  describe(`${name} server epoch admission`, () => {
    it('preserves a valid epoch zero', () => {
      const row = convert({ id: 'fixture', createdAtEpoch: 0 }, 'project', undefined);
      expect(row.created_at_epoch).toBe(0);
      expect(row.created_at).toBe('1970-01-01T00:00:00.000Z');
    });
    it('uses the missing-timestamp fallback for out-of-range epochs instead of throwing', () => {
      const before = Date.now();
      const row = convert({ id: 'fixture', createdAtEpoch: 9e20 }, 'project', undefined);
      expect(row.created_at_epoch).toBeGreaterThanOrEqual(before);
      expect(row.created_at_epoch).toBeLessThanOrEqual(Date.now());
      expect(Number.isFinite(Date.parse(row.created_at))).toBe(true);
    });
  });
}
