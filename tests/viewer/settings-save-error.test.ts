import { describe, it, expect, jest, spyOn } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NO_SAVE_STATUS, SAVE_OUTCOMES, saveSettings, submitSettings, type SaveStatus } from '../../src/ui/viewer/hooks/useSettings';
import { describeSaveFailure, SAVE_ERROR_MAX_CHARS } from '../../src/ui/viewer/utils/save-error';

const REPRO_PATH = join(import.meta.dir, '../fixtures/settings-save-error-repro.json');
const reproRaw = readFileSync(REPRO_PATH, 'utf-8').trim();

describe('describeSaveFailure', () => {
  it.each([
    [401, 'Proxy Unauthorized', 'not json', 'Unauthorized'],
    [401, 'Unauthorized', JSON.stringify({ error: 'Unauthorized', message: 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)' }), 'Unauthorized: Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)'],
    [400, 'Bad Request', JSON.stringify({ error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' }), 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535'],
    [400, 'Bad Request', JSON.stringify({ error: 'ValidationError', issues: [{ path: ['enabled'], message: 'Required', code: 'invalid_type' }] }), 'ValidationError: enabled: Required'],
    [502, 'Bad Gateway', '<html><body>Bad Gateway</body></html>', 'Bad Gateway'],
    [502, '', '', 'HTTP 502'],
    [400, 'Bad Request', JSON.stringify({ error: 'ValidationError', issues: [null] }), 'ValidationError'],
    [429, 'Too Many Requests', JSON.stringify({ message: 'rate limit exceeded' }), 'rate limit exceeded'],
    [409, 'Conflict', JSON.stringify({ error: 'Duplicate key', message: 'Duplicate key' }), 'Duplicate key'],
    [400, 'Bad Request', JSON.stringify({ success: false, foo: 1 }), 'Bad Request'],
    [400, 'Bad Request', JSON.stringify([{ error: 'nope' }]), 'Bad Request'],
    [400, 'Bad Request', JSON.stringify({ error: '\n\t  ', message: ' \t ' }), 'Bad Request'],
    [401, '', JSON.stringify({ error: '\u0007' }), 'Unauthorized'],
    [400, 'Bad Request', JSON.stringify({ issues: [{ path: ['x'], message: 'invalid' }] }), 'Bad Request'],
  ] as const)('formats HTTP %i %s body %s as %s', async (status, statusText, body, expected) => {
    expect(await describeSaveFailure(new Response(body, { status, statusText }))).toBe(`✗ Error: ${expected}`);
  });

  it('response whose text() rejects still resolves without throwing (invariant 6)', async () => {
    const fakeResponse = {
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.reject(new Error('body stream error'))
    };
    const result = await describeSaveFailure(fakeResponse);
    expect(result).toStartWith('\u2717 Error: ');
    expect(result).toBe('\u2717 Error: Service Unavailable');
  });

  it('bounded body read returns a partial JSON body when the stream never closes', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: 'partial body' })));
      }
    });
    jest.useFakeTimers();
    try {
      const result = describeSaveFailure({
        status: 502,
        statusText: 'Bad Gateway',
        body: stream,
        text: async () => 'unreachable'
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      jest.advanceTimersByTime(1000);
      expect(await result).toBe('\u2717 Error: partial body');
    } finally { jest.useRealTimers(); }
  });

  it('cancels a response stream that reaches the exact byte cap', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      }
    });
    await expect(describeSaveFailure({
      status: 502,
      statusText: 'Bad Gateway',
      body: stream,
      text: async () => 'unreachable'
    })).resolves.toBe('\u2717 Error: Bad Gateway');
    expect(cancelled).toBe(true);
  });

  it('cancels a response stream that yields an empty chunk forever', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancelled = true;
      }
    });
    await expect(describeSaveFailure({
      status: 502,
      statusText: 'Bad Gateway',
      body: stream,
      text: async () => 'unreachable'
    })).resolves.toBe('\u2717 Error: Bad Gateway');
    expect(cancelled).toBe(true);
  });

  it('extracts and clamps an error field when the JSON body exceeds the read cap', async () => {
    const response = new Response(JSON.stringify({ error: 'X'.repeat(70000) }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    const msgPart = result.slice('\u2717 Error: '.length);
    expect([...msgPart].length).toBe(SAVE_ERROR_MAX_CHARS);
    expect(msgPart).toBe(`${'X'.repeat(SAVE_ERROR_MAX_CHARS - 1)}\u2026`);
  });

  it('times out a response without a readable body', async () => {
    jest.useFakeTimers();
    try {
      const result = describeSaveFailure({
        status: 502,
        statusText: 'Bad Gateway',
        text: () => new Promise<string>(() => {})
      });
      jest.advanceTimersByTime(1000);
      expect(await result).toBe('\u2717 Error: Bad Gateway');
    } finally { jest.useRealTimers(); }
  });

  it('600-char body with \\n and \\u0007 is clamped to SAVE_ERROR_MAX_CHARS code points and ends with \u2026', async () => {
    const long = 'A'.repeat(100) + '\n' + '\u0007' + 'B'.repeat(500);
    const body = JSON.stringify({ error: long });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    const msgPart = result.slice('\u2717 Error: '.length);
    expect(msgPart).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect([...msgPart].length).toBe(SAVE_ERROR_MAX_CHARS);
    expect(msgPart.endsWith('\u2026')).toBe(true);
  });

  it('logs only the bounded diagnostic instead of the raw response body', async () => {
    const consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rawSecret = 'internal-secret-' + 'x'.repeat(70000);
      const result = await describeSaveFailure(new Response(JSON.stringify({ error: 'short diagnostic', details: rawSecret }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }));

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const logged = consoleErrorSpy.mock.calls[0] as unknown[];
      expect(logged[1]).toBe(400);
      expect(logged[2]).toBe('short diagnostic');
      expect(logged.join(' ')).not.toContain('internal-secret-');
      expect(result).toContain('\u2717 Error:');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('runs the production submitSettings failure branch with a mocked fetch', async () => {
    const statuses: SaveStatus[] = [];
    let saving = true;
    await submitSettings({} as never, {
      fetchImpl: async () => new Response(reproRaw, { status: 400, statusText: 'Bad Request' }),
      setSettings: () => {},
      setSaveStatus: status => statuses.push(status),
      setIsSaving: value => { saving = value; },
    });
    expect(statuses).toEqual([{
      outcome: 'failed',
      reason: '\u2717 Error: CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-flash-latest, gemini-flash-lite-latest, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3-flash-preview',
    }]);
    expect(saving).toBe(false);
  });

  it('keeps the production success and 2xx-error branches separate from the extractor', async () => {
    const statuses: SaveStatus[] = [];
    let saved = false;
    const deps = {
      fetchImpl: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      setSettings: () => { saved = true; },
      setSaveStatus: (status: SaveStatus) => statuses.push(status),
      setIsSaving: () => {},
    };
    await submitSettings({} as never, deps);
    expect(statuses).toEqual([{ outcome: 'saved', reason: null }]);
    expect(saved).toBe(true);

    await submitSettings({} as never, {
      ...deps,
      fetchImpl: async () => new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 200 }),
    });
    expect(statuses).toEqual([{ outcome: 'saved', reason: null }, { outcome: 'failed', reason: '\u2717 Error: boom' }]);
  });

  it('never POSTs the file-only CLAUDE_CODE_PATH, even when GET echoed it into local state', async () => {
    let postedBody = '';
    await submitSettings({ CLAUDE_CODE_PATH: '/usr/local/bin/claude', CLAUDE_MEM_MODEL: 'haiku' } as never, {
      fetchImpl: async (_url, init) => {
        postedBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      },
      setSettings: () => {},
      setSaveStatus: () => {},
      setIsSaving: () => {},
    });
    expect(JSON.parse(postedBody)).toEqual({ CLAUDE_MEM_MODEL: 'haiku' });
  });

  it('POSTs only the keys edited since the tab loaded, so other changes on disk survive (#4597)', async () => {
    const loaded = {
      CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
      CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS: '4096',
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
      CLAUDE_CODE_PATH: '/usr/local/bin/claude',
    };
    const bodies: unknown[] = [];
    let saved: unknown;
    const deps = {
      fetchImpl: async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '')));
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      },
      setSettings: (settings: unknown) => { saved = settings; },
      setSaveStatus: () => {},
      setIsSaving: () => {},
    } as never;

    const edited = { ...loaded, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '80' };
    await saveSettings(edited as never, deps, loaded as never);
    await saveSettings(edited as never, deps, edited as never);

    expect(bodies).toEqual([{ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '80' }, {}]);
    // Local state still holds the whole form, so the next save diffs against it.
    expect(saved).toEqual(edited);
  });

  it('keeps a rejected production fetch inside the outer saveSettings catch', async () => {
    const statuses: SaveStatus[] = [];
    let saving = false;
    await saveSettings({} as never, {
      fetchImpl: async () => { throw new Error('network down'); },
      setSettings: () => {},
      setSaveStatus: status => statuses.push(status),
      setIsSaving: value => { saving = value; },
    });
    // A new save starts from no outcome, then ends failed with the network's reason.
    expect(statuses).toEqual([NO_SAVE_STATUS, { outcome: 'failed', reason: '✗ Error: network down' }]);
    expect(saving).toBe(false);
  });

  it('decides saved or failed by the outcome it writes, never by a glyph in the words', async () => {
    // The outcome used to be read from a ✓ or ✗ inside the (translated) status text.
    expect([...SAVE_OUTCOMES].sort()).toEqual(['failed', 'none', 'saved']);
    const outcomes: SaveStatus[] = [];
    const deps = (response: () => Response) => ({
      fetchImpl: async () => response(),
      setSettings: () => {},
      setSaveStatus: (status: SaveStatus) => outcomes.push(status),
      setIsSaving: () => {},
    });
    await submitSettings({} as never, deps(() => Response.json({ error: 'value \u2713 rejected' }, { status: 400, statusText: 'Bad Request' })));
    await submitSettings({} as never, deps(() => Response.json({ success: false, error: 'no glyph here' })));
    await submitSettings({} as never, deps(() => Response.json({ success: true })));
    expect(outcomes.map(status => status.outcome)).toEqual(['failed', 'failed', 'saved']);
    expect(outcomes[0].reason).toContain('value \u2713 rejected');
    expect(outcomes[2].reason).toBeNull();
  });

  it('clamps on code points not code units: surrogate pair at boundary is not split', async () => {
    const astral = '\u{1F4A9}';
    const body = JSON.stringify({ error: 'A'.repeat(238) + astral + 'B'.repeat(10) });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    const msgPart = result.slice('\u2717 Error: '.length);
    expect([...msgPart].length).toBe(SAVE_ERROR_MAX_CHARS);
    expect(msgPart.endsWith('\u2026')).toBe(true);
    const encoded = new TextEncoder().encode(msgPart);
    const decoded = new TextDecoder().decode(encoded);
    expect(decoded).toBe(msgPart);
  });
});
