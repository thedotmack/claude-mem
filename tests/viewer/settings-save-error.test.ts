import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
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
      const result = await describeSaveFailure(response);
      expect(result).toBe(
        '\u2717 Error: CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-flash-latest, gemini-flash-lite-latest, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3-flash-preview'
      );
    });

    it('base formula from useSettings.ts:36 yields generic status, not the server message', () => {
      const res = { status: 400, statusText: 'Bad Request' };
      const baseStatus = `\u2717 Error: ${res.status === 401 ? 'Unauthorized' : res.statusText}`;
      expect(baseStatus).toBe('\u2717 Error: Bad Request');
      expect(baseStatus).not.toContain('CLAUDE_MEM_GEMINI_MODEL');
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

  it('600-char body with \\n and \\u0007 is clamped to SAVE_ERROR_MAX_CHARS and ends with \u2026', async () => {
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
    expect(msgPart.length).toBe(SAVE_ERROR_MAX_CHARS);
    expect(msgPart.endsWith('\u2026')).toBe(true);
  });

  it('200 response.ok is true so !response.ok guard does not fire (invariant 5 witness)', () => {
    const response = new Response(JSON.stringify({ success: false, error: 'boom' }), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' }
    });
    expect(response.ok).toBe(true);
  });
});

describe('tests/viewer/ regression baseline', () => {
  it('describeSaveFailure module loads without errors', () => {
    expect(typeof describeSaveFailure).toBe('function');
    expect(SAVE_ERROR_MAX_CHARS).toBe(240);
  });
});