import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { spawn } from 'child_process';
import { GeminiCliProvider } from '../../../src/services/worker/GeminiCliProvider.js';

// Mock child_process
mock.module('child_process', () => ({
  spawn: mock(),
}));

describe('GeminiCliProvider', () => {
  beforeEach(() => {
    // Reset mocks between tests
  });

  it('spawns gemini with -p - and -m flags', async () => {
    const mockProcess: any = {
      stdin: { write: mock(), end: mock() },
      stdout: { on: mock() },
      stderr: { on: mock() },
      on: mock((event: string, cb: Function) => {
        if (event === 'close') setImmediate(() => cb(0));
      }),
    };

    (spawn as any).mockReturnValue(mockProcess);

    const provider = new GeminiCliProvider({
      binary: 'gemini',
      model: 'gemini-2.5-flash-lite',
    });

    const promise = provider.extract({ prompt: 'extract observations from: ...' });

    // Simulate JSON output on stdout (as gemini CLI outputs)
    const dataCb = mockProcess.stdout.on.mock.calls.find((c: any) => c[0] === 'data')?.[1];
    if (dataCb) {
      dataCb(Buffer.from('{"response":"<observations><observation>x</observation></observations>"}'));
    }

    await promise;

    // Verify spawn was called with correct args
    expect((spawn as any).mock.calls.length).toBeGreaterThan(0);
    const lastCall = (spawn as any).mock.calls[(spawn as any).mock.calls.length - 1];
    expect(lastCall[0]).toBe('gemini');
    expect(lastCall[1]).toContain('-p');
    expect(lastCall[1]).toContain('-');
    expect(lastCall[1]).toContain('--model');
    expect(lastCall[1]).toContain('gemini-2.5-flash-lite');
  });

  it('returns the response field from JSON output', async () => {
    const mockProcess: any = {
      stdin: { write: mock(), end: mock() },
      stdout: { on: mock() },
      stderr: { on: mock() },
      on: mock((event: string, cb: Function) => {
        if (event === 'close') setImmediate(() => cb(0));
      }),
    };

    (spawn as any).mockReturnValue(mockProcess);

    const provider = new GeminiCliProvider({
      binary: 'gemini',
      model: 'gemini-2.5-flash-lite',
    });

    const promise = provider.extract({ prompt: 'hi' });

    const dataCb = mockProcess.stdout.on.mock.calls.find((c: any) => c[0] === 'data')?.[1];
    if (dataCb) {
      dataCb(Buffer.from('{"response":"hello world"}'));
    }

    const result = await promise;
    expect(result).toBe('hello world');
  });

  it('falls back to raw output if JSON parse fails', async () => {
    const mockProcess: any = {
      stdin: { write: mock(), end: mock() },
      stdout: { on: mock() },
      stderr: { on: mock() },
      on: mock((event: string, cb: Function) => {
        if (event === 'close') setImmediate(() => cb(0));
      }),
    };

    (spawn as any).mockReturnValue(mockProcess);

    const provider = new GeminiCliProvider({
      binary: 'gemini',
      model: 'gemini-2.5-flash-lite',
    });

    const promise = provider.extract({ prompt: 'hi' });

    const dataCb = mockProcess.stdout.on.mock.calls.find((c: any) => c[0] === 'data')?.[1];
    if (dataCb) {
      dataCb(Buffer.from('raw text output'));
    }

    const result = await promise;
    expect(result).toBe('raw text output');
  });

  it('throws error when gemini exits non-zero', async () => {
    const mockProcess: any = {
      stdin: { write: mock(), end: mock() },
      stdout: { on: mock() },
      stderr: {
        on: mock((event: string, cb: Function) => {
          if (event === 'data') setImmediate(() => cb(Buffer.from('Invalid API key')));
        })
      },
      on: mock((event: string, cb: Function) => {
        if (event === 'close') setImmediate(() => cb(1));
      }),
    };

    (spawn as any).mockReturnValue(mockProcess);

    const provider = new GeminiCliProvider({
      binary: 'gemini',
      model: 'gemini-2.5-flash-lite',
    });

    try {
      await provider.extract({ prompt: 'hi' });
      expect(false).toBe(true); // Should not reach
    } catch (e: any) {
      expect(e.message).toContain('Invalid API key');
    }
  });

  it('throws unrecoverable error when gemini binary is missing', async () => {
    const err: any = new Error('spawn gemini ENOENT');
    err.code = 'ENOENT';

    (spawn as any).mockImplementation(() => {
      throw err;
    });

    const provider = new GeminiCliProvider({
      binary: 'gemini',
      model: 'gemini-2.5-flash-lite',
    });

    try {
      await provider.extract({ prompt: 'hi' });
      expect(false).toBe(true); // Should not reach
    } catch (e: any) {
      expect(e.message).toContain('not found');
    }
  });
});
