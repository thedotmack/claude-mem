import { mock } from 'bun:test';

/**
 * Global posthog-node mock, registered via bunfig.toml [test].preload BEFORE
 * any test file or src module loads. It must be global, not per-file:
 *
 *  1. telemetry.ts imports PostHog at module top level, and many src modules
 *     (ResponseProcessor, SessionRoutes, SearchRoutes, worker-service, ...)
 *     transitively import telemetry.ts. The whole suite runs in one bun
 *     process, so a per-file mock.module registers too late once any earlier
 *     test file has touched those modules — the cached telemetry module keeps
 *     the real PostHog binding.
 *  2. Telemetry consent is default-on and the publishable key ships in the
 *     code, so without this mock a full-suite run constructs a REAL PostHog
 *     client and can flush fabricated test events into production analytics
 *     (flushAt: 20 / flushInterval: 10s vs a ~25s suite).
 *
 * Tests assert against these recorded calls — see
 * tests/telemetry/telemetry-client.test.ts.
 */
export type PostHogConstructorCall = { apiKey: string; options: Record<string, unknown> };
export const postHogConstructorCalls: PostHogConstructorCall[] = [];
export const postHogCaptureCalls: Array<Record<string, unknown>> = [];

mock.module('posthog-node', () => ({
  PostHog: class {
    constructor(apiKey: string, options: Record<string, unknown>) {
      postHogConstructorCalls.push({ apiKey, options });
    }
    capture(payload: Record<string, unknown>): void {
      postHogCaptureCalls.push(payload);
    }
    async shutdown(): Promise<void> {}
  },
}));
