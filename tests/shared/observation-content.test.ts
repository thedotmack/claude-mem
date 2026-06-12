import { describe, expect, it } from 'bun:test';
import {
  deriveObservationDisplayTitle,
  hasDurableObservationContent,
  isNoOpObservationContent,
} from '../../src/shared/observation-content.js';

describe('observation-content', () => {
  it('classifies no-op observation text without requiring a skip type', () => {
    expect(isNoOpObservationContent({})).toBe(false);

    expect(isNoOpObservationContent({
      narrative: 'No durable observation to record.',
    })).toBe(true);

    expect(hasDurableObservationContent({
      narrative: 'No observations to record for this summary batch.',
    })).toBe(false);

    expect(hasDurableObservationContent({
      text: 'No observation to record.',
    })).toBe(false);

    expect(isNoOpObservationContent({
      narrative: 'No observation to record.',
    })).toBe(true);

    expect(isNoOpObservationContent({
      narrative: 'No observations to record for summary batch.',
    })).toBe(true);
  });

  it('derives display titles from durable content instead of Untitled', () => {
    expect(deriveObservationDisplayTitle({
      title: null,
      narrative: 'Implemented queue coalescing. More details follow.',
    })).toBe('Implemented queue coalescing.');

    expect(deriveObservationDisplayTitle({
      subtitle: 'Fallback subtitle',
    })).toBe('Fallback subtitle');

    expect(deriveObservationDisplayTitle({
      text: 'Legacy text-only observation. More details follow.',
    })).toBe('Legacy text-only observation.');

    expect(deriveObservationDisplayTitle({
      facts: '["Queue depth is capped at 5"]',
    })).toBe('Queue depth is capped at 5');

    expect(deriveObservationDisplayTitle({
      concepts: ['queue', 'observer'],
    })).toBe('Concepts: queue, observer');
  });

  it('returns null for no-op display titles', () => {
    expect(deriveObservationDisplayTitle({
      narrative: 'No durable observation to record.',
    })).toBeNull();
  });

  it('treats subtitle-only observations as durable content', () => {
    expect(hasDurableObservationContent({
      subtitle: 'Fallback subtitle',
    })).toBe(true);

    expect(hasDurableObservationContent({
      text: 'Legacy text-only observation',
    })).toBe(true);
  });
});
