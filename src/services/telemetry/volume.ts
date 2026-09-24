/**
 * Client-side volume controls for PostHog ingest cost.
 *
 * Admin dashboards (claude-mem-pro /admin/*) query these events for usage
 * graphs and conversion rails. They do NOT need every install's every restart,
 * search, or skill invocation — sampling preserves trend shape while cutting
 * billable events. Funnel events (pro_*) are NEVER sampled here.
 *
 * Deterministic per-install sampling (hash of install id + event) keeps a
 * given install consistently in or out of a sample bucket so HogQL unique-user
 * counts stay coherent within the sampled population.
 */

import { createHash } from 'node:crypto';
import { getOrCreateInstallId } from './consent.js';

/** Events that may be sampled. Closed set — anything else always ships. */
export const SAMPLEABLE_EVENTS = new Set([
  'worker_started',
  'worker_stopped',
  'search_performed',
  'skill_invoked',
  'hook_failed',
]);

/**
 * Keep rates (0..1). Tuned against PostHog CMEM project volume (2026-09-19):
 * worker_started@start alone was ~2.2M/7d; search/skill/hook ~0.75M/7d;
 * context_injected_rollup ~1.3M/7d at a 5-minute flush.
 */
export const SAMPLE_RATES: Record<string, number> = {
  // Clean restarts dominate; crashes always send (see shouldSampleEvent).
  worker_started: 0.05,
  worker_stopped: 0.05,
  search_performed: 0.1,
  skill_invoked: 0.1,
  hook_failed: 0.1,
};

/**
 * Stable 0..1 bucket for (installId, event). Pure given inputs.
 */
export function sampleBucket(installId: string, event: string): number {
  const digest = createHash('sha256').update(`${installId}:${event}`).digest();
  // First 4 bytes as uint32 → [0, 1)
  const n = digest.readUInt32BE(0);
  return n / 0x1_0000_0000;
}

/**
 * Whether this event should be sent under volume controls.
 *
 * - Non-sampleable events always send.
 * - worker_started / worker_stopped with previous_shutdown === 'crash' always send
 *   (crash signal is the whole point of lifecycle telemetry).
 * - Otherwise compare the install's stable bucket to SAMPLE_RATES[event].
 *
 * Never throws.
 */
export function shouldSampleEvent(
  event: string,
  props?: Record<string, unknown>
): { send: boolean; sampleRate: number } {
  try {
    if (!SAMPLEABLE_EVENTS.has(event)) {
      return { send: true, sampleRate: 1 };
    }
    const rate = SAMPLE_RATES[event] ?? 1;
    if (rate >= 1) return { send: true, sampleRate: 1 };
    if (rate <= 0) return { send: false, sampleRate: rate };

    if (
      (event === 'worker_started' || event === 'worker_stopped') &&
      props?.previous_shutdown === 'crash'
    ) {
      return { send: true, sampleRate: 1 };
    }

    const installId = getOrCreateInstallId();
    const bucket = sampleBucket(installId, event);
    return { send: bucket < rate, sampleRate: rate };
  } catch {
    // Fail OPEN for operational events (prefer a billed event over silent
    // loss of crash/search signal when the sampler itself breaks).
    return { send: true, sampleRate: 1 };
  }
}

/** Default flush interval for context_injected_rollup (was 5 minutes). */
export const CONTEXT_INJECTED_FLUSH_MS = 30 * 60 * 1000;
