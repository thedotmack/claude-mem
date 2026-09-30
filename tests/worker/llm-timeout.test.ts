import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveLlmTimeoutMs, withRetry } from '../../src/services/worker/retry.js';
import { isClassified } from '../../src/services/worker/provider-errors.js';

// Every resolve reads a settings file; point it at a scratch one so the tests
// never see (or seed) the real ~/.claude-mem/settings.json.
let settingsDir: string;
let settingsPath: string;

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'llm-timeout-'));
  settingsPath = join(settingsDir, 'settings.json');
  writeFileSync(settingsPath, '{}');
});

afterEach(() => {
  rmSync(settingsDir, { recursive: true, force: true });
});

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings));
}

// #3794: the per-attempt deadline was hardcoded at 30s and unreachable from
// configuration. On a local model that truncates work already computed — a
// reported Ollama backend had a p99 of 29.8s against a 30s deadline — and the
// only workaround was editing the installed bundle after every update.
describe('resolveLlmTimeoutMs', () => {
  it('defaults to 30s when nothing is configured', () => {
    expect(resolveLlmTimeoutMs({}, settingsPath)).toBe(30_000);
  });

  // The key was env-only, so a value in settings.json — where every other
  // CLAUDE_MEM_* setting lives — had no effect at all.
  it('reads settings.json when the env var is unset', () => {
    writeSettings({ CLAUDE_MEM_LLM_TIMEOUT_MS: '120000' });
    expect(resolveLlmTimeoutMs({}, settingsPath)).toBe(120_000);
  });

  it('lets the env var override settings.json', () => {
    writeSettings({ CLAUDE_MEM_LLM_TIMEOUT_MS: '120000' });
    expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: '45000' }, settingsPath)).toBe(45_000);
  });

  it('validates a settings.json value like an env value', () => {
    writeSettings({ CLAUDE_MEM_LLM_TIMEOUT_MS: '90000ms' });
    expect(resolveLlmTimeoutMs({}, settingsPath)).toBe(30_000);
  });

  // loadFromFile returns JSON values as-is, so a bare number used to reach
  // .trim() and throw before the retry loop started.
  it('honors a numeric settings.json value like its string form', () => {
    writeSettings({ CLAUDE_MEM_LLM_TIMEOUT_MS: 90000 });
    expect(resolveLlmTimeoutMs({}, settingsPath)).toBe(90_000);
  });

  it('falls back without throwing on an out-of-range number or a non-string, non-number value', () => {
    for (const value of [300001, 499, true]) {
      writeSettings({ CLAUDE_MEM_LLM_TIMEOUT_MS: value });
      expect(resolveLlmTimeoutMs({}, settingsPath)).toBe(30_000);
    }
  });

  // String([90000]) is "90000", so an array used to pass the integer check.
  it('falls back on an array or an object value', () => {
    for (const value of [[90000], { ms: 90000 }]) {
      writeSettings({ CLAUDE_MEM_LLM_TIMEOUT_MS: value });
      expect(resolveLlmTimeoutMs({}, settingsPath)).toBe(30_000);
    }
  });

  it('takes a value inside the shared 500..300000 bounds', () => {
    expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: '90000' }, settingsPath)).toBe(90_000);
    expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: '500' }, settingsPath)).toBe(500);
    expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: '300000' }, settingsPath)).toBe(300_000);
  });

  it('falls back to the default rather than trusting a value out of range', () => {
    // A zero or a negative would disable the deadline; a huge one would park a
    // worker for hours. Both keep the default, matching the other
    // CLAUDE_MEM_*_TIMEOUT_MS settings.
    for (const value of ['0', '-1', '499', '300001', 'abc', '', '90000ms']) {
      expect(resolveLlmTimeoutMs({ CLAUDE_MEM_LLM_TIMEOUT_MS: value }, settingsPath)).toBe(30_000);
    }
  });
});

describe('per-attempt deadline', () => {
  it('does not retry a request that blew the deadline', async () => {
    // The abort surfaces with no HTTP status, so it classified as transient and
    // was retried twice against a backend that is already saturated.
    let attempts = 0;
    const started = Date.now();
    await expect(
      withRetry(
        async signal => {
          attempts += 1;
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
          });
          return 'unreachable';
        },
        { label: 'probe', perAttemptTimeoutMs: 20, maxRetries: 2 },
      ),
    ).rejects.toThrow(/per-attempt deadline/);
    expect(attempts).toBe(1);
    // Three attempts plus backoff would take far longer than one deadline.
    expect(Date.now() - started).toBeLessThan(500);
  });

  // Unclassified, the expiry left the provider's abortReason null and the
  // session finalized, dropping its buffered observer work.
  it('classifies an expired deadline as transient', async () => {
    const error = await withRetry(
      signal => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
      }),
      { label: 'probe', perAttemptTimeoutMs: 20, maxRetries: 0 },
    ).catch((err: unknown) => err);

    expect(isClassified(error)).toBe(true);
    expect(isClassified(error) && error.kind).toBe('transient');
    expect((error as Error).message).toMatch(/exceeded the 20ms per-attempt deadline/);
  });

  it('still retries a genuine transient failure', async () => {
    let attempts = 0;
    const out = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('socket hang up');
        return 'ok';
      },
      { label: 'probe', perAttemptTimeoutMs: 5_000, maxRetries: 2, baseDelayMs: 1 },
    );
    expect(out).toBe('ok');
    expect(attempts).toBe(2);
  });
});
