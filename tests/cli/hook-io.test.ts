import { describe, it, expect, afterEach } from 'bun:test';
import {
  installHookStderrBuffer,
  emitDiagnostic,
  emitModelContext,
  exitGraceful,
  resetHookIoState,
  HookStdoutError,
} from '../../src/shared/hook-io.js';
import type { PlatformAdapter, HookResult } from '../../src/cli/types.js';

// Windows Terminal tab-accumulation rationale (per CLAUDE.md):
// Hooks that fail with non-zero exit codes cause Windows Terminal to keep the
// tab open in an error state, which accumulates over time. The exit-0-on-error
// policy is intentional. exitGraceful() exits 0 + drops buffered stderr, and
// no hook path exits 2 (plan-17 step 2).

/** Capture real stderr by replacing the bound writer. Returns captured chunks. */
function captureRealStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  return { chunks, restore: () => { process.stderr.write = original as typeof process.stderr.write; } };
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string, callback: () => void): boolean => {
    chunks.push(String(chunk));
    callback();
    return true;
  }) as typeof process.stdout.write;
  return { chunks, restore: () => { process.stdout.write = original; } };
}

const fakeAdapter: PlatformAdapter = {
  normalizeInput: (raw) => raw as never,
  formatOutput: (result) => ({ ok: true, systemMessage: result.systemMessage }),
};

afterEach(() => {
  resetHookIoState();
});

describe('installHookStderrBuffer', () => {
  it('buffers direct process.stderr.write so it does not reach real stderr until flushed', () => {
    // capture the REAL stderr first, then install the buffer on top.
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('hello\n');
      expect(real.chunks.join('')).toBe(''); // buffered, nothing surfaced yet
      buffer.flush();
      expect(real.chunks.join('')).toBe('hello\n');
    } finally {
      buffer.restore();
      real.restore();
    }
  });

  it('drop() discards buffered bytes so a later flush writes nothing', () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('discarded\n');
      buffer.drop();
      buffer.flush();
      expect(real.chunks.join('')).toBe('');
    } finally {
      buffer.restore();
      real.restore();
    }
  });

  it('restore() lets subsequent writes reach stderr immediately', () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    buffer.restore();
    try {
      process.stderr.write('direct\n');
      expect(real.chunks.join('')).toBe('direct\n');
    } finally {
      real.restore();
    }
  });
});

describe('emitDiagnostic', () => {
  it('reaches real stderr even while the buffer is installed (bypass channel)', () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('buffered\n'); // captured
      emitDiagnostic('diag\n');           // bypasses buffer → real stderr now
      expect(real.chunks.join('')).toBe('diag\n');
    } finally {
      buffer.restore();
      real.restore();
    }
  });
});

describe('emitModelContext', () => {
  it('calls adapter.formatOutput and JSON.stringifies to stdout', () => {
    const out = captureStdout();
    try {
      const result: HookResult = { systemMessage: 'hi' };
      emitModelContext(fakeAdapter, result);
      expect(out.chunks).toHaveLength(1);
      expect(JSON.parse(out.chunks[0])).toEqual({ ok: true, systemMessage: 'hi' });
      expect(out.chunks[0]).toEndWith('\n');
    } finally {
      out.restore();
    }
  });

  it('preserves raw-string adapter output and its trailing newline', () => {
    const out = captureStdout();
    const rawAdapter: PlatformAdapter = {
      normalizeInput: (raw) => raw as never,
      formatOutput: () => 'plain context\nsecond line',
    };
    try {
      emitModelContext(rawAdapter, {});
      expect(out.chunks).toEqual(['plain context\nsecond line\n']);
    } finally {
      out.restore();
    }
  });

  it('throws when called twice in the same emitter lifetime', () => {
    const out = captureStdout();
    try {
      emitModelContext(fakeAdapter, {});
      expect(() => emitModelContext(fakeAdapter, {})).toThrow('emitModelContext called twice');
    } finally {
      out.restore();
    }
  });

  it('resetHookIoState clears the double-emit guard', () => {
    const out = captureStdout();
    try {
      emitModelContext(fakeAdapter, {});
      resetHookIoState();
      expect(() => emitModelContext(fakeAdapter, {})).not.toThrow();
      expect(out.chunks).toHaveLength(2);
    } finally {
      out.restore();
    }
  });

  it('skips stdout when the adapter returns an empty string', () => {
    const emptyAdapter: PlatformAdapter = {
      normalizeInput: (raw) => raw as never,
      formatOutput: () => '',
    };
    const out = captureStdout();
    try {
      emitModelContext(emptyAdapter, {});
      expect(out.chunks).toHaveLength(0);
    } finally {
      out.restore();
    }
  });

  it('empty emit does not trip the double-emit guard', () => {
    const emptyAdapter: PlatformAdapter = {
      normalizeInput: (raw) => raw as never,
      formatOutput: () => '',
    };
    const out = captureStdout();
    try {
      emitModelContext(emptyAdapter, {});
      expect(() => emitModelContext(fakeAdapter, {})).not.toThrow();
      expect(out.chunks).toHaveLength(1);
    } finally {
      out.restore();
    }
  });

  it('two real emits still throw', () => {
    const out = captureStdout();
    try {
      emitModelContext(fakeAdapter, {});
      expect(() => emitModelContext(fakeAdapter, {})).toThrow('emitModelContext called twice');
    } finally {
      out.restore();
    }
  });
});

describe('exitGraceful', () => {
  it('drops the buffer (buffered bytes never reach real stderr)', async () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('should-be-dropped\n');
      await exitGraceful({ skipExit: true });
      buffer.flush(); // nothing left to flush
      expect(real.chunks.join('')).toBe('');
    } finally {
      buffer.restore();
      real.restore();
    }
  });

  it('waits for the stdout callback even when skipExit is enabled', async () => {
    const original = process.stdout.write;
    let completeWrite: (() => void) | undefined;
    process.stdout.write = ((_chunk: string, callback: () => void): boolean => {
      completeWrite = callback;
      return false;
    }) as typeof process.stdout.write;
    try {
      emitModelContext(fakeAdapter, {});
      let finished = false;
      const exiting = exitGraceful({ skipExit: true }).then(() => { finished = true; });
      await Promise.resolve();
      expect(finished).toBe(false);
      completeWrite!();
      await exiting;
      expect(finished).toBe(true);
    } finally {
      process.stdout.write = original;
    }
  });

  it('rejects when stdout completion reports a failed write', async () => {
    const original = process.stdout.write;
    process.stdout.write = ((_chunk: string, callback: (error?: Error | null) => void): boolean => {
      queueMicrotask(() => callback(new Error('stdout unavailable')));
      return false;
    }) as typeof process.stdout.write;
    try {
      emitModelContext(fakeAdapter, {});
      await expect(exitGraceful({ skipExit: true })).rejects.toThrow('stdout unavailable');
    } finally {
      process.stdout.write = original;
    }
  });

  it('rejects a synchronous stdout write failure', async () => {
    const original = process.stdout.write;
    process.stdout.write = (() => { throw new Error('stdout closed'); }) as typeof process.stdout.write;
    try {
      emitModelContext(fakeAdapter, {});
      await expect(exitGraceful({ skipExit: true })).rejects.toBeInstanceOf(HookStdoutError);
    } finally {
      process.stdout.write = original;
    }
  });
});
