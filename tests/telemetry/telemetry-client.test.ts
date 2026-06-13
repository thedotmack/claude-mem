import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { postHogConstructorCalls, postHogCaptureCalls } from '../preload';

/**
 * Guards the PostHog client construction options. The posthog-node SDK stamps
 * $geoip_disable: true on every event unless disableGeoip: false is passed —
 * losing ingest-side coarse location for every worker event. The module is
 * mocked so no real client (and no network) is ever created.
 */

const {
  captureEvent,
  __resetTelemetryForTests,
} = await import('../../src/services/telemetry/telemetry');

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CLAUDE_MEM_DATA_DIR',
  'CLAUDE_MEM_TELEMETRY',
  'CLAUDE_MEM_TELEMETRY_DEBUG',
  'CLAUDE_MEM_TELEMETRY_KEY',
  'DO_NOT_TRACK',
];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-telemetry-client-'));
  process.env.CLAUDE_MEM_DATA_DIR = tempDir;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
  delete process.env.CLAUDE_MEM_TELEMETRY_KEY;
  delete process.env.DO_NOT_TRACK;
});

beforeEach(() => {
  postHogConstructorCalls.length = 0;
  postHogCaptureCalls.length = 0;
  __resetTelemetryForTests();
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.DO_NOT_TRACK;
});

afterEach(() => {
  __resetTelemetryForTests();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('PostHog client construction', () => {
  it('constructs the client with disableGeoip: false so ingest-side geolocation works', () => {
    captureEvent('test_event');

    expect(postHogConstructorCalls.length).toBe(1);
    expect(postHogConstructorCalls[0].options.disableGeoip).toBe(false);
  });

  it('reuses the client and queues the capture', () => {
    captureEvent('test_event_2');

    expect(postHogConstructorCalls.length).toBe(1);
    expect(postHogCaptureCalls.length).toBe(1);
    expect(postHogCaptureCalls[0].event).toBe('test_event_2');
  });

  it('re-resolves consent when the env override flips within the cache ttl window', () => {
    process.env.CLAUDE_MEM_TELEMETRY = '0';
    captureEvent('opted_out_event');
    expect(postHogConstructorCalls.length).toBe(0);
    expect(postHogCaptureCalls.length).toBe(0);

    process.env.CLAUDE_MEM_TELEMETRY = '1';
    captureEvent('opted_in_event');

    expect(postHogConstructorCalls.length).toBe(1);
    expect(postHogCaptureCalls.length).toBe(1);
    expect(postHogCaptureCalls[0].event).toBe('opted_in_event');
  });
});
