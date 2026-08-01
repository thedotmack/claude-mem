import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { saveStatusClass } from '../../src/ui/viewer/components/ContextSettingsModal';
import { saveSettings, submitSettings } from '../../src/ui/viewer/hooks/useSettings';
import { describeSaveFailure, SAVE_ERROR_MAX_CHARS } from '../../src/ui/viewer/utils/save-error';

const REPRO_PATH = join(import.meta.dir, '../fixtures/settings-save-error-repro.json');
const reproRaw = readFileSync(REPRO_PATH, 'utf-8').trim();

describe('describeSaveFailure', () => {
  describe('base-fails/head-passes: captured 400 validator body from the issue fixture', () => {
    it('returns the server error message from the fixture', async () => {
      const response = new Response(reproRaw, {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' }
      });
      const baseMessage = response.status === 401 ? 'Unauthorized' : response.statusText;
      expect(baseMessage).toBe('Bad Request');
      expect(reproRaw).toContain('CLAUDE_MEM_GEMINI_MODEL');
      expect(baseMessage).not.toContain('CLAUDE_MEM_GEMINI_MODEL');
      const result = await describeSaveFailure(response);
      expect(result).toBe(
        '\u2717 Error: CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-flash-latest, gemini-flash-lite-latest, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3-flash-preview'
      );
    });

    it('head wires useSettings.ts to describeSaveFailure (regression guard)', () => {
      const source = readFileSync(
        join(import.meta.dir, '../../src/ui/viewer/hooks/useSettings.ts'),
        'utf-8'
      );
      expect(source).not.toContain("response.status === 401 ? 'Unauthorized' : response.statusText");
      expect(source).toContain('describeSaveFailure');
    });
  });

  it('401 with body "not json" returns exactly \u2717 Error: Unauthorized (invariant 3)', async () => {
    const response = new Response('not json', {
      status: 401,
      statusText: 'Unauthorized'
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Unauthorized');
  });

  it('401 with a custom statusText still uses the stable Unauthorized fallback', async () => {
    const response = new Response('not json', {
      status: 401,
      statusText: 'Proxy Unauthorized'
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Unauthorized');
  });

  it('401 with a blank body and custom statusText still uses the stable Unauthorized fallback', async () => {
    const response = new Response(JSON.stringify({ error: '   ' }), {
      status: 401,
      statusText: 'Proxy Unauthorized',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Unauthorized');
  });

  it('401 with {error:"Unauthorized",message:"Missing API key (...)"} includes both parts', async () => {
    const body = JSON.stringify({
      error: 'Unauthorized',
      message: 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)'
    });
    const response = new Response(body, {
      status: 401,
      statusText: 'Unauthorized',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe(
      '\u2717 Error: Unauthorized: Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)'
    );
  });

  it('400 {error:"CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535"} surfaces error (invariants 1-2)', async () => {
    const body = JSON.stringify({ error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535');
  });

  it('400 {error:"ValidationError",issues:[...]} formats path and message', async () => {
    const body = JSON.stringify({
      error: 'ValidationError',
      issues: [{ path: ['enabled'], message: 'Required', code: 'invalid_type' }]
    });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: ValidationError: enabled: Required');
  });

  it('502 HTML body falls back to statusText (invariants 1-2)', async () => {
    const response = new Response('<html><body>Bad Gateway</body></html>', {
      status: 502,
      statusText: 'Bad Gateway'
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Bad Gateway');
  });

  it('502 empty body with empty statusText falls back to HTTP 502 (invariants 1-2)', async () => {
    const response = new Response('', {
      status: 502,
      statusText: ''
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: HTTP 502');
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
    const startedAt = Date.now();
    const result = await describeSaveFailure({
      status: 502,
      statusText: 'Bad Gateway',
      body: stream,
      text: async () => 'unreachable'
    });

    expect(result).toBe('\u2717 Error: partial body');
    expect(Date.now() - startedAt).toBeLessThan(2000);
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

  it('malformed validation issues cannot reject the failure formatter', async () => {
    const response = new Response(JSON.stringify({ error: 'ValidationError', issues: [null] }), {
      status: 400,
      statusText: 'Bad Request'
    });
    await expect(describeSaveFailure(response)).resolves.toBe('\u2717 Error: ValidationError');
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
    const result = await describeSaveFailure({
      status: 502,
      statusText: 'Bad Gateway',
      text: () => new Promise<string>(() => {})
    });
    expect(result).toBe('\u2717 Error: Bad Gateway');
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
    expect(SAVE_ERROR_MAX_CHARS).toBe(240);
    const msgPart = result.slice('\u2717 Error: '.length);
    expect(msgPart).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect([...msgPart].length).toBe(SAVE_ERROR_MAX_CHARS);
    expect(msgPart.endsWith('\u2026')).toBe(true);
  });

  it('structural proof: 200 response.ok guard prevents describeSaveFailure (invariant 5)', async () => {
    const response200 = new Response(JSON.stringify({ success: false, error: 'boom' }), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' }
    });
    expect(response200.ok).toBe(true);
    const wouldBeWrong = await describeSaveFailure({
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true })
    });
    expect(wouldBeWrong).toStartWith('\u2717 Error:');
  });

  it('runs the production submitSettings failure branch with a mocked fetch', async () => {
    const statuses: string[] = [];
    let saving = true;
    await submitSettings({} as never, {
      fetchImpl: async () => new Response(reproRaw, { status: 400, statusText: 'Bad Request' }),
      setSettings: () => {},
      setSaveStatus: status => statuses.push(status),
      setIsSaving: value => { saving = value; },
    });
    expect(statuses).toEqual([
      '\u2717 Error: CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-flash-latest, gemini-flash-lite-latest, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3-flash-preview',
    ]);
    expect(saving).toBe(false);
  });

  it('keeps the production success and 2xx-error branches separate from the extractor', async () => {
    const statuses: string[] = [];
    let saved = false;
    const deps = {
      fetchImpl: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      setSettings: () => { saved = true; },
      setSaveStatus: (status: string) => statuses.push(status),
      setIsSaving: () => {},
      setStatusTimeout: (callback: () => void) => callback(),
    };
    await submitSettings({} as never, deps);
    expect(statuses).toEqual(['\u2713 Saved', '']);
    expect(saved).toBe(true);

    await submitSettings({} as never, {
      ...deps,
      fetchImpl: async () => new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 200 }),
    });
    expect(statuses).toEqual(['\u2713 Saved', '', '\u2717 Error: boom']);
  });

  it('keeps a rejected production fetch inside the outer saveSettings catch', async () => {
    const statuses: string[] = [];
    let saving = false;
    await saveSettings({} as never, {
      fetchImpl: async () => { throw new Error('network down'); },
      setSettings: () => {},
      setSaveStatus: status => statuses.push(status),
      setIsSaving: value => { saving = value; },
    });
    expect(statuses).toEqual(['Saving...', '✗ Error: network down']);
    expect(saving).toBe(false);
  });

  it('{message:"rate limit exceeded"} uses message field when error is absent', async () => {
    const body = JSON.stringify({ message: 'rate limit exceeded' });
    const response = new Response(body, {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: rate limit exceeded');
  });

  it('{error:"Duplicate key",message:"Duplicate key"} uses error field when err === msg', async () => {
    const body = JSON.stringify({ error: 'Duplicate key', message: 'Duplicate key' });
    const response = new Response(body, {
      status: 409,
      statusText: 'Conflict',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Duplicate key');
  });

  it('{success:false,foo:1} (JSON object with no error/message) falls back to statusText', async () => {
    const body = JSON.stringify({ success: false, foo: 1 });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Bad Request');
  });

  it('[{error:"nope"}] (array body) is not a plain object and falls back to statusText', async () => {
    const body = JSON.stringify([{ error: 'nope' }]);
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Bad Request');
  });

  it('{error,message: whitespace-only} enters recovery block and uses statusText', async () => {
    const body = JSON.stringify({ error: '\n\t  ', message: ' \t ' });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Bad Request');
  });

  it('{error:"\\u0007"} at 401 with empty statusText uses Unauthorized from recovery', async () => {
    const body = JSON.stringify({ error: '\u0007' });
    const response = new Response(body, {
      status: 401,
      statusText: '',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Unauthorized');
  });

  it('{issues:[...]} without error field falls back to statusText', async () => {
    const body = JSON.stringify({ issues: [{ path: ['x'], message: 'invalid' }] });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: Bad Request');
  });

  it('{error:"value \u2713 rejected"} preserves \u2713 in output; styling fix is at ContextSettingsModal:488', async () => {
    const body = JSON.stringify({ error: 'value \u2713 rejected' });
    const response = new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await describeSaveFailure(response);
    expect(result).toBe('\u2717 Error: value \u2713 rejected');
  });

  it('error styling wins when an error message contains the success glyph', () => {
    expect(saveStatusClass('\u2717 Error: value \u2713 rejected')).toBe('error');
    expect(saveStatusClass('\u2713 Saved')).toBe('success');
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

describe('tests/viewer/ regression baseline', () => {
  it('describeSaveFailure module loads without errors', () => {
    expect(typeof describeSaveFailure).toBe('function');
    expect(SAVE_ERROR_MAX_CHARS).toBe(240);
  });
});
