import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AimlapiProvider } from '../../src/services/worker/AimlapiProvider.js';
import { DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS } from '../../src/services/worker/context-window.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';

/**
 * The worker provider must send the user's own output cap, like every sibling
 * HTTP provider, instead of a hardcoded 4096.
 *
 * A hardcoded cap was not the conservative choice it looked like. A reply cut
 * off inside the observation XML is rejected by the parser; two of those in a
 * row made the worker acknowledge the queued batch and drop it with nothing
 * stored. Raising CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS is how a user prevents
 * that, and the setting was being ignored.
 *
 * The default of that setting IS 4096, so honoring it changes nothing until
 * someone raises it — which the first case below pins.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS',
  'AIMLAPI_API_KEY',
  'CLAUDE_MEM_AIMLAPI_API_KEY',
  'CLAUDE_MEM_AIMLAPI_MODEL',
  'CLAUDE_MEM_AIMLAPI_BASE_URL',
] as const;

const WRAPUP = {
  sessionDbId: 1,
  contentSessionId: 'session-1',
  project: 'proj',
  platformSource: 'claude',
  summaryText: 'did a thing',
};

describe('aimlapi.com observer output cap', () => {
  let saved: Record<string, string | undefined> = {};
  let realFetch: typeof fetch;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      process.env[key] = '';
    }
    process.env.AIMLAPI_API_KEY = 'test-key-never-leaves-this-process';
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /** The cap on the wire for one real request through the provider. */
  async function sentCap(configured?: string): Promise<number | undefined> {
    if (configured !== undefined) {
      process.env.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS = configured;
    }
    let body: { max_tokens?: number } = {};
    let reached: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: { body?: string }) => {
      reached = String(url);
      body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AimlapiProvider({} as DatabaseManager, {} as SessionManager);
    await provider.formatTelegramWrapup(WRAPUP);

    // the request was intercepted here and went nowhere else
    expect(reached).toBe('https://api.aimlapi.com/v1/chat/completions');
    return body.max_tokens;
  }

  it('sends the setting default when nothing is configured', async () => {
    expect(await sentCap()).toBe(DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS);
    expect(DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS).toBe(4096);
  });

  it('sends a raised cap instead of the old hardcoded 4096', async () => {
    expect(await sentCap('16384')).toBe(16384);
  });

  it('sends a lowered cap too: the setting wins in both directions', async () => {
    expect(await sentCap('1024')).toBe(1024);
  });

  it('falls back to the default for a value outside the allowed bounds', async () => {
    expect(await sentCap('99')).toBe(DEFAULT_OBSERVER_MAX_OUTPUT_TOKENS);
  });
});
