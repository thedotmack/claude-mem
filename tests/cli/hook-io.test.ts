import { describe, it, expect, afterEach } from 'bun:test';
import {
  installHookStderrBuffer,
  emitDiagnostic,
  emitModelContext,
  withUserHint,
  emitBlockingError,
  exitGraceful,
  resetHookIoState,
} from '../../src/shared/hook-io.js';
import type { PlatformAdapter, HookResult } from '../../src/cli/types.js';

// Windows Terminal tab-accumulation rationale (per CLAUDE.md):
// Hooks that fail with non-zero exit codes cause Windows Terminal to keep the
// tab open in an error state, which accumulates over time. The exit-0-on-error
// policy is intentional. exitGraceful() exits 0 + drops buffered stderr;
// emitBlockingError() exits 2 only for fail-loud / unrecoverable handler errors.

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
  const original = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.join(' ')); };
  return { chunks, restore: () => { console.log = original; } };
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
});

describe('withUserHint', () => {
  it('returns a new object with systemMessage set', () => {
    const result = withUserHint({ exitCode: 0 }, 'hi');
    expect(result.systemMessage).toBe('hi');
    expect(result.exitCode).toBe(0);
  });

  it('appends to an existing systemMessage with a blank line', () => {
    const result = withUserHint({ systemMessage: 'world' }, 'hi');
    expect(result.systemMessage).toBe('world\n\nhi');
  });
});

describe('emitBlockingError', () => {
  it('writes msg to real stderr and does not exit when skipExit is set', () => {
    const real = captureRealStderr();
    try {
      emitBlockingError('boom', { skipExit: true });
      expect(real.chunks.join('')).toBe('boom\n');
    } finally {
      real.restore();
    }
  });

  it('flushes buffered stderr BEFORE its own message (ordering)', () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('preceding\n'); // buffered
      emitBlockingError('boom', { skipExit: true });
      // buffered content surfaces first, then the blocking message.
      expect(real.chunks.join('')).toBe('preceding\nboom\n');
    } finally {
      buffer.restore();
      real.restore();
    }
  });
});

describe('exitGraceful', () => {
  it('drops the buffer (buffered bytes never reach real stderr)', () => {
    const real = captureRealStderr();
    const buffer = installHookStderrBuffer();
    try {
      process.stderr.write('should-be-dropped\n');
      exitGraceful({ skipExit: true });
      buffer.flush(); // nothing left to flush
      expect(real.chunks.join('')).toBe('');
    } finally {
      buffer.restore();
      real.restore();
    }
  });
});
