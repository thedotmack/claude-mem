import { describe, it, expect, mock, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Guards the PostHog client construction options. The posthog-node SDK stamps
 * $geoip_disable: true on every event unless disableGeoip: false is passed —
 * losing ingest-side coarse location for every worker event. The module is
 * mocked so no real client (and no network) is ever created.
 */

type ConstructorCall = { apiKey: string; options: Record<string, unknown> };
const constructorCalls: ConstructorCall[] = [];
const captureCalls: Array<Record<string, unknown>> = [];

mock.module('posthog-node', () => ({
  PostHog: class {
    constructor(apiKey: string, options: Record<string, unknown>) {
      constructorCalls.push({ apiKey, options });
    }
    capture(payload: Record<string, unknown>): void {
      captureCalls.push(payload);
    }
    async shutdown(): Promise<void> {}
  },
}));

const { captureEvent } = await import('../../src/services/telemetry/telemetry');

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

    expect(constructorCalls.length).toBe(1);
    expect(constructorCalls[0].options.disableGeoip).toBe(false);
  });

  it('reuses the client and queues the capture', () => {
    captureEvent('test_event_2');

    expect(constructorCalls.length).toBe(1);
    expect(captureCalls.length).toBe(2);
    expect(captureCalls[1].event).toBe('test_event_2');
  });
});
