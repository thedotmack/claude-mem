import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { postHogCaptureCalls, postHogExceptionCalls } from '../preload';
import { captureEvent, captureException, __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';
import { getOrCreateAnonymousDistinctId, getOrCreateInstallId } from '../../src/services/telemetry/consent';
import {
  __clearTelemetryVolumeFileForTests,
  __setTelemetryVolumeClockForTests,
  __setTelemetryVolumePathForTests,
  observeTelemetryVolume,
  WORK_VIEW_OPEN_INTERVAL_MS,
} from '../../src/services/telemetry/daily-volume';

const DAY = Date.parse('2026-11-02T12:00:00.000Z');
const NEXT = Date.parse('2026-11-03T00:00:01.000Z');

let directory: string;
const savedImmediate = process.env.CLAUDE_MEM_TELEMETRY_IMMEDIATE;
const savedTelemetry = process.env.CLAUDE_MEM_TELEMETRY;
const savedDoNotTrack = process.env.DO_NOT_TRACK;

function arm(now: number): void {
  __resetTelemetryForTests();
  delete process.env.CLAUDE_MEM_TELEMETRY_IMMEDIATE;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.DO_NOT_TRACK;
  __setTelemetryVolumePathForTests(join(directory, 'telemetry-daily.json'));
  __clearTelemetryVolumeFileForTests();
  __setTelemetryVolumeClockForTests(() => now);
  postHogCaptureCalls.length = 0;
  postHogExceptionCalls.length = 0;
}

afterEach(() => {
  if (savedImmediate === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_IMMEDIATE;
  else process.env.CLAUDE_MEM_TELEMETRY_IMMEDIATE = savedImmediate;
  if (savedTelemetry === undefined) delete process.env.CLAUDE_MEM_TELEMETRY;
  else process.env.CLAUDE_MEM_TELEMETRY = savedTelemetry;
  if (savedDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
  else process.env.DO_NOT_TRACK = savedDoNotTrack;
  __resetTelemetryForTests();
});

describe('daily telemetry volume', () => {
  it('drops saved errors at send time once the person turns error reporting off', () => {
    const saved = process.env.CLAUDE_MEM_TELEMETRY_ERRORS;
    directory = mkdtempSync(join(tmpdir(), 'cmem-daily-'));
    try {
      arm(DAY);
      captureEvent('hook_failed', { hook_name: 'stop', error_category: 'timeout' });
      captureException(new TypeError('saved before the opt-out'));
      expect(postHogExceptionCalls).toHaveLength(0);

      process.env.CLAUDE_MEM_TELEMETRY_ERRORS = '0';
      __setTelemetryVolumeClockForTests(() => NEXT);
      captureEvent('test_event_flush_errors');
      expect(postHogExceptionCalls).toHaveLength(0);
      // Only error text is opted out; the anonymous counters still go.
      expect(postHogCaptureCalls.filter(call => call.event === 'hook_failed')).toHaveLength(1);

      // Dropped, not postponed: turning reporting back on must not send what was opted out.
      delete process.env.CLAUDE_MEM_TELEMETRY_ERRORS;
      __setTelemetryVolumeClockForTests(() => NEXT + 24 * 60 * 60_000);
      captureEvent('test_event_flush_errors');
      expect(postHogExceptionCalls).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_ERRORS;
      else process.env.CLAUDE_MEM_TELEMETRY_ERRORS = saved;
      __setTelemetryVolumeClockForTests(null);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('sums a day of rollups into one event and sends it when the day closes', () => {
    directory = mkdtempSync(join(tmpdir(), 'telemetry-daily-'));
    try {
      arm(DAY);
      captureEvent('search_performed', { endpoint: 'unified', outcome: 'ok', result_count: 2, duration_ms: 10, search_strategy: 'chroma' });
      captureEvent('search_performed', { endpoint: 'by-file', outcome: 'ok', result_count: 5, duration_ms: 30, search_strategy: 'chroma' });
      captureEvent('observer_turn_rollup', { count: 4, total_cost_usd: 0.1, outcomes_ok: 3, outcomes_error: 1, provider: 'claude' });
      captureEvent('observer_turn_rollup', { count: 6, total_cost_usd: 0.2, outcomes_ok: 6, outcomes_error: 0, provider: 'claude' });
      expect(postHogCaptureCalls.map(call => call.event)).not.toContain('search_performed');
      expect(postHogCaptureCalls.map(call => call.event)).not.toContain('observer_turn_rollup');

      __setTelemetryVolumeClockForTests(() => NEXT);
      captureEvent('test_event_after_midnight');
      const searches = postHogCaptureCalls.filter(call => call.event === 'search_performed');
      const turns = postHogCaptureCalls.filter(call => call.event === 'observer_turn_rollup');
      expect(searches).toHaveLength(1);
      expect(searches[0].properties.count).toBe(2);
      expect(searches[0].properties.result_count).toBe(7);
      expect(searches[0].properties.duration_ms).toBe(40);
      expect(turns).toHaveLength(1);
      expect(turns[0].properties.count).toBe(10);
      expect(turns[0].properties.total_cost_usd).toBeCloseTo(0.3);
      expect(turns[0].properties.outcomes_ok).toBe(9);
      expect(turns[0].properties.provider).toBe('claude');
      expect(searches[0].properties.$process_person_profile).toBe(false);
      expect(searches[0].properties.$set).toBeUndefined();
      expect(searches[0].distinctId).toBe(getOrCreateAnonymousDistinctId());
      expect(searches[0].distinctId).not.toBe(getOrCreateInstallId());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the daily bucket across a reset of the in-memory clock reader and sends worker restarts once', () => {
    directory = mkdtempSync(join(tmpdir(), 'telemetry-daily-life-'));
    try {
      arm(DAY);
      captureEvent('worker_started', { trigger: 'start', runtime_mode: 'worker' });
      captureEvent('worker_started', { trigger: 'start', runtime_mode: 'worker' });
      captureEvent('worker_stopped', { shutdown_reason: 'restart', uptime_seconds: 10 });
      expect(postHogCaptureCalls.map(call => call.event)).not.toContain('worker_started');

      // A new process reads the same file. The in-memory module state is the file.
      __setTelemetryVolumeClockForTests(() => NEXT);
      captureEvent('test_event_next_day');
      const started = postHogCaptureCalls.filter(call => call.event === 'worker_started');
      const stopped = postHogCaptureCalls.filter(call => call.event === 'worker_stopped');
      expect(started).toHaveLength(1);
      expect(started[0].properties.restart_count).toBe(2);
      expect(stopped).toHaveLength(1);
      expect(stopped[0].properties.restart_count).toBe(1);
      expect(started[0].properties.$set).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('dedupes failures per error type per day with a count', () => {
    directory = mkdtempSync(join(tmpdir(), 'telemetry-daily-err-'));
    try {
      arm(DAY);
      captureEvent('hook_failed', { hook_type: 'observation', error_mode: 'worker_unavailable', consecutive_failures: 3 });
      captureEvent('hook_failed', { hook_type: 'observation', error_mode: 'worker_unavailable', consecutive_failures: 4 });
      captureEvent('hook_failed', { hook_type: 'summarize', error_mode: 'blocking_error', consecutive_failures: 1 });
      captureEvent('worker_start_failed', { outcome: 'dead', error_category: 'boot_crash' });
      captureEvent('worker_start_failed', { outcome: 'dead', error_category: 'boot_crash' });
      captureException(new TypeError('first boom'));
      captureException(new TypeError('second boom'));
      captureException(new Error('different type'));
      expect(postHogCaptureCalls.filter(call => call.event === 'hook_failed')).toHaveLength(0);
      expect(postHogExceptionCalls).toHaveLength(0);

      __setTelemetryVolumeClockForTests(() => NEXT);
      captureEvent('test_event_flush_errors');
      const hooks = postHogCaptureCalls.filter(call => call.event === 'hook_failed');
      const starts = postHogCaptureCalls.filter(call => call.event === 'worker_start_failed');
      expect(hooks.map(call => call.properties.count).sort()).toEqual([1, 2]);
      expect(starts).toHaveLength(1);
      expect(starts[0].properties.count).toBe(2);
      expect(starts[0].properties.error_category).toBe('boot_crash');
      expect(postHogExceptionCalls).toHaveLength(2);
      const counts = postHogExceptionCalls.map(call => call.additionalProperties?.count).sort();
      expect(counts).toEqual([1, 2]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('forwards at most one work_view_opened per view per minute and keeps the window on disk', () => {
    directory = mkdtempSync(join(tmpdir(), 'telemetry-daily-open-'));
    try {
      let now = DAY;
      arm(now);
      __setTelemetryVolumeClockForTests(() => now);
      const work = { view: 'work', viewer_host: 'local', hostname: 'localhost' };
      captureEvent('work_view_opened', work);
      captureEvent('work_view_opened', work);
      captureEvent('work_view_opened', { ...work, view: 'rules' });
      expect(postHogCaptureCalls.filter(call => call.event === 'work_view_opened')).toHaveLength(2);

      now += WORK_VIEW_OPEN_INTERVAL_MS - 1;
      captureEvent('work_view_opened', work);
      expect(postHogCaptureCalls.filter(call => call.event === 'work_view_opened')).toHaveLength(2);

      now += 2;
      captureEvent('work_view_opened', work);
      expect(postHogCaptureCalls.filter(call => call.event === 'work_view_opened')).toHaveLength(3);
      expect(postHogCaptureCalls.filter(call => call.event === 'work_view_opened').every(call => call.properties.viewer_host === 'local')).toBe(true);

      // Same file, clock still inside the window: a restarted worker does not send again.
      const again = observeTelemetryVolume('work_view_opened', work, now);
      expect(again.forward).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
