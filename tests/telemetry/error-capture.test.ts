import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  postHogExceptionCalls,
  postHogConstructorCalls,
  postHogCaptureCalls,
} from '../preload';
import {
  captureException,
  captureEvent,
  __resetTelemetryForTests,
  __errorBeforeSendForTests,
} from '../../src/services/telemetry/telemetry';
import { logger } from '../../src/utils/logger';

/**
 * Phase 3 error-capture tests: consent gate, kill-switch, fingerprint
 * rate-limiting (incl. before_send autocapture path), $process_person_profile,
 * and the logger error-sink hook. posthog-node is mocked globally in
 * tests/preload.ts; the mock records captureException calls in
 * postHogExceptionCalls (see preload.ts).
 */

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CLAUDE_MEM_DATA_DIR',
  'CLAUDE_MEM_TELEMETRY',
  'CLAUDE_MEM_TELEMETRY_ERRORS',
  'CLAUDE_MEM_TELEMETRY_DEBUG',
  'CLAUDE_MEM_TELEMETRY_KEY',
  'DO_NOT_TRACK',
];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-error-capture-'));
  process.env.CLAUDE_MEM_DATA_DIR = tempDir;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.CLAUDE_MEM_TELEMETRY_ERRORS;
  delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
  delete process.env.CLAUDE_MEM_TELEMETRY_KEY;
  delete process.env.DO_NOT_TRACK;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  logger.setErrorSink(null);
  rmSync(tempDir, { recursive: true, force: true });
  __resetTelemetryForTests();
});

beforeEach(() => {
  // Fresh state per test: clears client, consent cache, shutdown latch, and the
  // error-rate-limit Map.
  __resetTelemetryForTests();
  postHogConstructorCalls.length = 0;
  postHogCaptureCalls.length = 0;
  postHogExceptionCalls.length = 0;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.CLAUDE_MEM_TELEMETRY_ERRORS;
  delete process.env.DO_NOT_TRACK;
  logger.setErrorSink(null);
});

describe('captureException: consent gate', () => {
  it('sends an $exception when consent is ON', () => {
    captureException(new Error('boom'));
    expect(postHogExceptionCalls.length).toBe(1);
  });

  it('sends ZERO exceptions when consent is OFF (env)', () => {
    process.env.CLAUDE_MEM_TELEMETRY = '0';
    __resetTelemetryForTests();
    captureException(new Error('boom'));
    expect(postHogExceptionCalls.length).toBe(0);
  });

  it('sends ZERO exceptions when DO_NOT_TRACK is set', () => {
    process.env.DO_NOT_TRACK = '1';
    __resetTelemetryForTests();
    captureException(new Error('boom'));
    expect(postHogExceptionCalls.length).toBe(0);
  });
});

describe('captureException: kill-switch', () => {
  it('CLAUDE_MEM_TELEMETRY_ERRORS=0 ⇒ zero exception captures', () => {
    process.env.CLAUDE_MEM_TELEMETRY_ERRORS = '0';
    __resetTelemetryForTests();
    captureException(new Error('boom'));
    expect(postHogExceptionCalls.length).toBe(0);
  });

  it('analytics is UNAFFECTED by the error kill-switch', () => {
    process.env.CLAUDE_MEM_TELEMETRY_ERRORS = '0';
    __resetTelemetryForTests();
    captureException(new Error('boom'));
    captureEvent('worker_started');
    expect(postHogExceptionCalls.length).toBe(0);
    expect(postHogCaptureCalls.length).toBe(1);
  });
});

describe('captureException: $exception payload', () => {
  it('carries $process_person_profile:false and the redacted fields', () => {
    captureException(new TypeError('something broke'));
    expect(postHogExceptionCalls.length).toBe(1);
    const props = postHogExceptionCalls[0].additionalProperties!;
    expect(props.$process_person_profile).toBe(false);
    expect(props.$exception_type).toBe('TypeError');
    expect(typeof props.$exception_message).toBe('string');
    expect(props.occurrence_count).toBe(1);
  });

  it('passes the install id as the 2nd positional arg (distinctId)', () => {
    captureException(new Error('boom'));
    expect(typeof postHogExceptionCalls[0].distinctId).toBe('string');
    expect((postHogExceptionCalls[0].distinctId as string).length).toBeGreaterThan(0);
  });

  it('redacts secrets out of the message it ships', () => {
    captureException(new Error('token sk-ABCdef1234567890ghij leaked to bob@h.com'));
    const props = postHogExceptionCalls[0].additionalProperties!;
    const msg = String(props.$exception_message);
    expect(msg).not.toContain('sk-ABCdef1234567890ghij');
    expect(msg).not.toContain('bob@h.com');
  });
});

describe('captureException: fingerprint rate-limit', () => {
  it('same fingerprint 100x within window ⇒ exactly one send, count reflects occurrences', () => {
    for (let i = 0; i < 100; i++) {
      captureException(new Error(`User ${i} not found`));
    }
    // messageTemplate collapses the varying id ⇒ one fingerprint ⇒ 1 send.
    expect(postHogExceptionCalls.length).toBe(1);
    expect(postHogExceptionCalls[0].additionalProperties!.occurrence_count).toBe(1);
  });

  it('distinct fingerprints each send once', () => {
    captureException(new Error('alpha failure'));
    captureException(new TypeError('beta failure'));
    expect(postHogExceptionCalls.length).toBe(2);
  });
});

describe('before_send autocapture rate-limit', () => {
  it('drops a repeated $exception fingerprint (returns null)', () => {
    const mkEvent = () => ({
      event: '$exception',
      properties: {
        $exception_type: 'Error',
        $exception_message: 'autocaptured boom',
      },
    });
    const first = __errorBeforeSendForTests(mkEvent());
    const second = __errorBeforeSendForTests(mkEvent());
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('passes non-$exception events through untouched', () => {
    const ev = { event: 'worker_started', properties: { a: 1 } };
    expect(__errorBeforeSendForTests(ev)).toBe(ev);
  });

  it('attaches occurrence_count to the sent exception', () => {
    const ev = {
      event: '$exception',
      properties: { $exception_type: 'Error', $exception_message: 'counted boom' },
    } as { event: string; properties: Record<string, unknown> };
    const out = __errorBeforeSendForTests(ev) as typeof ev;
    expect(out.properties.occurrence_count).toBe(1);
  });
});

describe('before_send FULLY REDACTS SDK-autocaptured $exception (one-way-door)', () => {
  // posthog-node's addSourceContext reads the user's real source off disk and
  // attaches raw context_line/pre_context/post_context + abs filename + the RAW
  // unredacted message. before_send MUST strip all of it. This test FAILS
  // against the pre-fix code (which returned autocaptured events unchanged).
  const mkAutocapturedEvent = () => ({
    event: '$exception',
    properties: {
      $exception_list: [
        {
          type: 'TypeError',
          value: 'boom at /Users/alex/secret/path with token sk-ABCdef1234567890ghij',
          stacktrace: {
            frames: [
              {
                filename: '/Users/alex/proj/src/secret.ts',
                function: 'doThing',
                lineno: 5,
                colno: 3,
                context_line: 'const key = "sk-deadbeef0123456789abc"',
                pre_context: ['function doThing() {', '  // secret below'],
                post_context: ['  return key', '}'],
              },
            ],
          },
        },
      ],
    } as Record<string, unknown>,
  });

  it('redacts value, deletes source-context frames, redacts filename, sets profile false', () => {
    const ev = mkAutocapturedEvent();
    const out = __errorBeforeSendForTests(ev) as typeof ev;
    expect(out).not.toBeNull();

    const list = out.properties.$exception_list as Array<Record<string, unknown>>;
    const entry = list[0];

    // 1. Raw message scrubbed — no raw path, no token.
    const value = String(entry.value);
    expect(value).not.toContain('/Users/alex/secret/path');
    expect(value).not.toContain('sk-ABCdef1234567890ghij');

    // 2. Raw source lines DELETED from every frame.
    const frame = (entry.stacktrace as { frames: Array<Record<string, unknown>> }).frames[0];
    expect('context_line' in frame).toBe(false);
    expect('pre_context' in frame).toBe(false);
    expect('post_context' in frame).toBe(false);

    // 3. filename redacted to basename (no abs path, no /Users/alex).
    const filename = String(frame.filename);
    expect(filename).not.toContain('/Users/alex');
    expect(filename).toContain('secret.ts');

    // 4. profile-less.
    expect(out.properties.$process_person_profile).toBe(false);

    // function/lineno preserved (lower-risk, kept by design).
    expect(frame.function).toBe('doThing');
    expect(frame.lineno).toBe(5);
  });

  it('never ships raw source — context lines gone even for the second (dropped) occurrence', () => {
    const first = __errorBeforeSendForTests(mkAutocapturedEvent());
    expect(first).not.toBeNull();
    // Same fingerprint within window ⇒ dropped (null).
    const second = __errorBeforeSendForTests(mkAutocapturedEvent());
    expect(second).toBeNull();
  });
});

describe('before_send sentinel: manual captureException is NOT double-rate-limited (B1)', () => {
  it('passes a manual (sentinel-marked) event through with accumulated count, strips the marker', () => {
    // Simulate the REAL two-pass flow: captureException rate-limits + redacts +
    // stamps the sentinel (pass #1), then the SDK runs before_send on the SAME
    // event (pass #2). The sentinel must short-circuit pass #2 so the limiter is
    // NOT re-run and occurrence_count is NOT clobbered to 1.
    captureException(new Error('manual two-pass boom'));
    expect(postHogExceptionCalls.length).toBe(1);

    const additional = postHogExceptionCalls[0].additionalProperties as Record<string, unknown>;
    // The sentinel actually landed on the additionalProperties (so it reaches
    // before_send via event.properties in production).
    expect(additional.__cm_rate_limited).toBe(true);
    const accumulatedCount = additional.occurrence_count as number;

    // Now drive the SDK's before_send pass on that same event's properties.
    const sdkEvent = {
      event: '$exception',
      properties: { ...additional },
    } as { event: string; properties: Record<string, unknown> };
    const out = __errorBeforeSendForTests(sdkEvent) as typeof sdkEvent;

    // Passed through (not dropped) ...
    expect(out).not.toBeNull();
    // ... occurrence_count is the manual path's accumulated count, NOT clobbered
    // to a fresh pass-#2 value ...
    expect(out.properties.occurrence_count).toBe(accumulatedCount);
    // ... and the private marker is stripped so it never ships to PostHog.
    expect('__cm_rate_limited' in out.properties).toBe(false);
  });

  it('a sentinel-marked event does NOT consume a second rate-limit slot', () => {
    // Manual event #1 sends. A sentinel-marked before_send pass must not create
    // a separate fingerprint entry, so a DISTINCT manual error still sends.
    captureException(new Error('distinct alpha'));
    const ev = {
      event: '$exception',
      properties: { ...(postHogExceptionCalls[0].additionalProperties as Record<string, unknown>) },
    };
    __errorBeforeSendForTests(ev);
    captureException(new TypeError('distinct beta'));
    expect(postHogExceptionCalls.length).toBe(2);
  });
});

describe('captureException: never throws on hostile input', () => {
  it('swallows null / circular / throwing-getter input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'message', {
      enumerable: true,
      get() {
        throw new Error('gotcha');
      },
    });
    expect(() => captureException(null)).not.toThrow();
    expect(() => captureException(circular)).not.toThrow();
    expect(() => captureException(hostile)).not.toThrow();
  });
});

describe('logger error-sink hook', () => {
  it('logger.error with an Error routes exactly one exception via the sink', () => {
    logger.setErrorSink((err) => captureException(err));
    logger.error('WORKER', 'something failed', { sessionId: 1 }, new Error('sink boom'));
    expect(postHogExceptionCalls.length).toBe(1);
    expect(postHogExceptionCalls[0].additionalProperties!.$exception_type).toBe('Error');
  });

  it('logger.failure with an Error also routes via the sink', () => {
    logger.setErrorSink((err) => captureException(err));
    logger.failure('WORKER', 'op failed', undefined, new Error('failure boom'));
    expect(postHogExceptionCalls.length).toBe(1);
  });

  it('does NOT route when data is not an Error', () => {
    logger.setErrorSink((err) => captureException(err));
    logger.error('WORKER', 'plain message', { sessionId: 1 }, { not: 'an error' });
    expect(postHogExceptionCalls.length).toBe(0);
  });

  it('logging still works (no throw) with no sink installed', () => {
    logger.setErrorSink(null);
    expect(() => logger.error('WORKER', 'no sink', undefined, new Error('x'))).not.toThrow();
    expect(postHogExceptionCalls.length).toBe(0);
  });

  it('a throwing sink never breaks logging', () => {
    logger.setErrorSink(() => {
      throw new Error('sink exploded');
    });
    expect(() => logger.error('WORKER', 'boom', undefined, new Error('x'))).not.toThrow();
  });
});
