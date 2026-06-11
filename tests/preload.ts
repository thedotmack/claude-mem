import { mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Data-dir tripwire (Phase 6, worker-restart plan): no test may ever touch the
 * real ~/.claude-mem. src/shared/paths.ts freezes DATA_DIR at first evaluation
 * (env CLAUDE_MEM_DATA_DIR wins), and module-level consts like ProcessManager's
 * PID_FILE inherit that frozen value — so the env var must point at a safe
 * directory BEFORE any module loads. This preload runs first (bunfig.toml
 * [test].preload), so when the env var is unset we pin it to a fresh per-run
 * temp dir. Tests that want tighter isolation still override it per-file /
 * per-test; this only fills the default so nothing can fall through to the
 * real data dir. The leaked temp dir per run is deliberate: correctness over
 * cleanup (an afterAll here could rip the dir out from under frozen module
 * constants while later test files still run).
 */
if (!process.env.CLAUDE_MEM_DATA_DIR) {
  process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-test-run-'));
}

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
