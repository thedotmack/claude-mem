import { describe, it, expect, afterEach } from 'bun:test';
import { sampleEvent } from '../../src/services/telemetry/telemetry';

/**
 * Unit tests for the high-volume event sampler wired into the PostHog
 * `before_send` hook. The hook is the cost lever for `session_compressed`,
 * which is ~89% of all ingested events — sampling drops the bulk of it before
 * it is ever sent or billed, while keeping the event itself alive.
 */

const SAMPLED = new Set(['session_compressed']);
const realRandom = Math.random;

afterEach(() => {
  Math.random = realRandom;
});

describe('sampleEvent', () => {
  it('passes through events whose name is not sampled, untouched', () => {
    Math.random = () => 0.99; // would drop if it were sampled
    const event = { event: 'worker_started', properties: { trigger: 'boot' } };
    const result = sampleEvent(event, SAMPLED, 0.1);
    expect(result).toBe(event);
    expect(result?.properties.telemetry_sample_rate).toBeUndefined();
  });

  it('drops a sampled event when the draw exceeds the keep rate', () => {
    Math.random = () => 0.5; // 0.5 >= 0.1 -> drop
    const event = { event: 'session_compressed', properties: { outcome: 'ok' } };
    expect(sampleEvent(event, SAMPLED, 0.1)).toBeNull();
  });

  it('keeps a sampled event when the draw is under the keep rate and stamps the rate', () => {
    Math.random = () => 0.05; // 0.05 < 0.1 -> keep
    const event = { event: 'session_compressed', properties: { outcome: 'ok' } };
    const result = sampleEvent(event, SAMPLED, 0.1);
    expect(result).toBe(event);
    expect(result?.properties.telemetry_sample_rate).toBe(0.1);
    expect(result?.properties.outcome).toBe('ok');
  });

  it('never drops when the rate is >= 1 (sampling effectively disabled)', () => {
    Math.random = () => 0.999;
    const event = { event: 'session_compressed', properties: {} };
    const result = sampleEvent(event, SAMPLED, 1);
    expect(result).toBe(event);
    // No stamp when sampling is a no-op, so dashboards don't scale a 1.0 rate.
    expect(result?.properties.telemetry_sample_rate).toBeUndefined();
  });

  it('passes a null event straight through (posthog-node may hand us null)', () => {
    expect(sampleEvent(null, SAMPLED, 0.1)).toBeNull();
  });

  it('keeps ~10% of a large sample of session_compressed events', () => {
    Math.random = realRandom;
    let kept = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const r = sampleEvent(
        { event: 'session_compressed', properties: {} },
        SAMPLED,
        0.1
      );
      if (r) kept++;
    }
    // Wide tolerance: this is a statistical check, not an exact count.
    expect(kept / n).toBeGreaterThan(0.07);
    expect(kept / n).toBeLessThan(0.13);
  });
});
