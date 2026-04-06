import { describe, it, expect } from 'bun:test';
import { betaSample, gammaSample } from '../../src/services/bandit/sampling.js';

describe('gammaSample', () => {
  it('returns positive values for shape >= 1', () => {
    for (let i = 0; i < 100; i++) {
      const val = gammaSample(2.0);
      expect(val).toBeGreaterThan(0);
    }
  });

  it('returns positive values for shape < 1', () => {
    for (let i = 0; i < 100; i++) {
      const val = gammaSample(0.5);
      expect(val).toBeGreaterThan(0);
    }
  });

  it('mean approximates shape (large sample)', () => {
    const shape = 5.0;
    const samples = Array.from({ length: 10000 }, () => gammaSample(shape));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(shape * 0.85);
    expect(mean).toBeLessThan(shape * 1.15);
  });
});

describe('betaSample', () => {
  it('returns values in [0, 1]', () => {
    for (let i = 0; i < 100; i++) {
      const val = betaSample(2.0, 3.0);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('mean approximates alpha/(alpha+beta)', () => {
    const alpha = 10;
    const beta = 5;
    const expected = alpha / (alpha + beta);
    const samples = Array.from({ length: 10000 }, () => betaSample(alpha, beta));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(expected - 0.05);
    expect(mean).toBeLessThan(expected + 0.05);
  });

  it('Beta(1,1) is approximately uniform', () => {
    const samples = Array.from({ length: 10000 }, () => betaSample(1, 1));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });
});
