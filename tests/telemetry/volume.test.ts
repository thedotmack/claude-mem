import { describe, expect, it, beforeEach } from 'bun:test';
import {
  sampleBucket,
  shouldSampleEvent,
  SAMPLE_RATES,
  SAMPLEABLE_EVENTS,
} from '../../src/services/telemetry/volume.js';
import { __resetTelemetryForTests } from '../../src/services/telemetry/telemetry.js';

describe('volume sampling', () => {
  beforeEach(() => {
    __resetTelemetryForTests();
  });

  it('sampleBucket is stable for the same install+event', () => {
    const a = sampleBucket('install-aaa', 'worker_started');
    const b = sampleBucket('install-aaa', 'worker_started');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('sampleBucket differs across events for the same install', () => {
    const a = sampleBucket('install-aaa', 'worker_started');
    const b = sampleBucket('install-aaa', 'search_performed');
    expect(a).not.toBe(b);
  });

  it('always sends non-sampleable events (funnels untouched)', () => {
    expect(SAMPLEABLE_EVENTS.has('pro_checkout_started')).toBe(false);
    const r = shouldSampleEvent('pro_checkout_started', {});
    expect(r.send).toBe(true);
    expect(r.sampleRate).toBe(1);
  });

  it('always sends worker_started after a crash', () => {
    const r = shouldSampleEvent('worker_started', { previous_shutdown: 'crash' });
    expect(r.send).toBe(true);
    expect(r.sampleRate).toBe(1);
  });

  it('samples clean worker_started at the configured keep-rate', () => {
    let sent = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const bucket = sampleBucket(`install-${i}`, 'worker_started');
      if (bucket < SAMPLE_RATES.worker_started) sent += 1;
    }
    // 5% of 200 ≈ 10; allow wide band for hash distribution
    expect(sent).toBeGreaterThan(2);
    expect(sent).toBeLessThan(30);
  });
});
