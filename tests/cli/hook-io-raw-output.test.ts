import { describe, it, expect, afterEach } from 'bun:test';
import { emitModelContext, resetHookIoState } from '../../src/shared/hook-io.js';
import { kiroAdapter } from '../../src/cli/adapters/kiro.js';
import type { PlatformAdapter } from '../../src/cli/types.js';

// Raw-text output mode (Kiro CLI): when an adapter's formatOutput returns a
// string, emitModelContext prints it verbatim — no JSON envelope — and an
// empty string produces ZERO stdout bytes. On Kiro, agentSpawn/userPromptSubmit
// stdout is injected into model context verbatim (JSON would be garbage), and
// `stop` stdout is parsed for a `{"decision":"block"}` override (silence is
// the only safe success signal).

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { chunks.push(args.join(' ')); };
  return { chunks, restore: () => { console.log = original; } };
}

const rawStringAdapter: PlatformAdapter = {
  normalizeInput: (raw) => raw as never,
  formatOutput: (result) => result.hookSpecificOutput?.additionalContext ?? '',
};

const jsonAdapter: PlatformAdapter = {
  normalizeInput: (raw) => raw as never,
  formatOutput: () => ({ continue: true }),
};

afterEach(() => {
  resetHookIoState();
});

describe('emitModelContext — raw string mode', () => {
  it('prints a non-empty string verbatim without JSON quoting', () => {
    const stdout = captureStdout();
    try {
      emitModelContext(rawStringAdapter, {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '# Memory\nline "quoted"' },
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.chunks).toEqual(['# Memory\nline "quoted"']);
  });

  it('emits nothing at all for an empty string', () => {
    const stdout = captureStdout();
    try {
      emitModelContext(rawStringAdapter, { continue: true, suppressOutput: true });
    } finally {
      stdout.restore();
    }

    expect(stdout.chunks).toEqual([]);
  });

  it('keeps the JSON envelope for object-returning adapters', () => {
    const stdout = captureStdout();
    try {
      emitModelContext(jsonAdapter, { continue: true });
    } finally {
      stdout.restore();
    }

    expect(stdout.chunks).toEqual(['{"continue":true}']);
  });

  it('still guards against double emit in raw mode, even when nothing was printed', () => {
    const stdout = captureStdout();
    try {
      emitModelContext(rawStringAdapter, { continue: true });
      expect(() => emitModelContext(rawStringAdapter, { continue: true })).toThrow('emitModelContext called twice');
    } finally {
      stdout.restore();
    }
  });
});

describe('emitModelContext — kiro stop invariant', () => {
  it('a summarize success result produces zero stdout bytes through the real kiro adapter', () => {
    const stdout = captureStdout();
    try {
      // Shape returned by summarizeHandler on every success/skip path.
      emitModelContext(kiroAdapter, { continue: true, suppressOutput: true, exitCode: 0 });
    } finally {
      stdout.restore();
    }

    expect(stdout.chunks).toEqual([]);
  });
});
