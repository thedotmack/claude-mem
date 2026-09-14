/**
 * Issue #4081: a hook's stdout must carry the payload and nothing else.
 *
 * Claude Code parses a SessionStart hook's whole stdout as one JSON object, so
 * one extra line ahead of the payload fails the hook with "Hook output looks
 * like a JSON object but is not valid JSON". The reported emitter is an NDJSON
 * environment banner from somewhere inside the bundled worker; the reporter
 * could not find it by grepping the bundle and could not reproduce it outside
 * the real hook path, and neither could I.
 *
 * So these tests do not reproduce that emitter. They pin the property that
 * makes it irrelevant: with the guard installed, a third party writing to
 * stdout cannot reach stdout, and the payload still can.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  emitModelContext,
  installHookStderrBuffer,
  installHookStdoutGuard,
  resetHookIoState,
} from '../src/shared/hook-io.js';
import type { HookResult, PlatformAdapter } from '../src/cli/types.js';

const adapter = {
  formatOutput: (result: HookResult) => ({ ok: true, ...result }),
} as unknown as PlatformAdapter;

/**
 * Capture both stdout channels. console.log is intercepted separately from
 * process.stdout.write on purpose: under Bun they are not the same channel
 * (the `measured:` cell below pins that), so a helper that replaced only
 * process.stdout.write would score the unguarded control as clean and the
 * whole file would prove nothing.
 */
function capture<T>(run: () => T): { stdout: string; stderr: string; value: T } {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const realLog = console.log;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((c: string | Uint8Array) => {
    stdout += typeof c === 'string' ? c : Buffer.from(c).toString('utf-8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    stderr += typeof c === 'string' ? c : Buffer.from(c).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;
  console.log = ((...args: unknown[]) => {
    stdout += `${args.join(' ')}\n`;
  }) as typeof console.log;
  try {
    const value = run();
    return { stdout, stderr, value };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    console.log = realLog;
  }
}

const BANNER =
  '{"type":"message","message":"Detected an AI agent environment, printing as NDJSON."}\n';

afterEach(() => {
  resetHookIoState();
});

describe('hook stdout guard (#4081)', () => {
  test('the control: without the guard, a third-party line lands on stdout ahead of the payload', () => {
    const { stdout } = capture(() => {
      process.stdout.write(BANNER);
      emitModelContext(adapter, { continue: true } as HookResult);
    });

    // Two JSON objects concatenated — exactly what the hook parser chokes on.
    expect(stdout.trimEnd().split('\n')).toHaveLength(2);
    expect(() => JSON.parse(stdout)).toThrow();
  });

  test('with the guard, stdout is the payload alone and still parses', () => {
    const { stdout } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        process.stdout.write(BANNER);
        emitModelContext(adapter, { continue: true } as HookResult);
      } finally {
        guard.restore();
      }
    });

    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, continue: true });
  });

  test('the diverted line is not dropped: it reaches stderr', () => {
    const { stderr } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        process.stdout.write(BANNER);
        emitModelContext(adapter, { continue: true } as HookResult);
      } finally {
        guard.restore();
      }
    });

    expect(stderr).toContain('Detected an AI agent environment');
  });

  test('console.log is diverted too, not only process.stdout.write', () => {
    const { stdout, stderr } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        console.log('a library being %s', 'helpful');
        emitModelContext(adapter, { continue: true } as HookResult);
      } finally {
        guard.restore();
      }
    });

    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    // Re-bound through node:console, so %s formatting survives the diversion.
    expect(stderr).toContain('a library being helpful');
  });

  test('the whole stdout-bound console set is diverted, not just log', () => {
    const { stdout, stderr } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        console.info('info line');
        console.debug('debug line');
        console.dir({ nested: [1, 2] });
        console.table([{ column: 'value' }]);
        console.group('outer');
        console.log('indented');
        console.groupEnd();
        emitModelContext(adapter, { continue: true } as HookResult);
      } finally {
        guard.restore();
      }
    });

    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    for (const fragment of ['info line', 'debug line', 'nested', 'column', 'outer']) {
      expect(stderr).toContain(fragment);
    }
    // group indentation is the diverted console's own state, so it survives.
    expect(stderr).toContain('  indented');
  });

  test('measured: under Bun console.log bypasses a replaced process.stdout.write', () => {
    // This is why the guard swaps the console members instead of trusting the
    // process.stdout.write replacement alone. Run out-of-process because the
    // capture helper above deliberately hides the difference.
    const probe = [
      "let seen='';",
      'const real=process.stdout.write.bind(process.stdout);',
      "process.stdout.write=(c)=>{seen+=c;return true};",
      "console.log('through-console');",
      'process.stdout.write=real;',
      "process.stderr.write('SEEN='+JSON.stringify(seen));",
    ].join('');
    const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf-8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('SEEN=""');
    expect(result.stdout).toContain('through-console');
  });

  test('diverted noise joins the stderr buffer instead of bypassing it', () => {
    const { stderr } = capture(() => {
      const buffer = installHookStderrBuffer();
      const guard = installHookStdoutGuard();
      try {
        process.stdout.write(BANNER);
        console.log('more noise');
      } finally {
        guard.restore();
        buffer.flush();
        buffer.restore();
      }
    });

    expect(stderr).toContain('Detected an AI agent environment');
    expect(stderr).toContain('more noise');
  });

  test('drop() discards diverted noise the same way it discards stderr noise', () => {
    const { stderr } = capture(() => {
      const buffer = installHookStderrBuffer();
      const guard = installHookStdoutGuard();
      try {
        process.stdout.write(BANNER);
      } finally {
        guard.restore();
        buffer.drop();
        buffer.restore();
      }
    });

    expect(stderr).toBe('');
  });

  test('the payload keeps its trailing newline', () => {
    const { stdout } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        emitModelContext(adapter, { continue: true } as HookResult);
      } finally {
        guard.restore();
      }
    });

    expect(stdout.endsWith('\n')).toBe(true);
  });

  test('restore puts the real writer back', () => {
    const { stdout } = capture(() => {
      installHookStdoutGuard().restore();
      process.stdout.write('after restore\n');
    });

    expect(stdout).toBe('after restore\n');
  });

  test('restore puts the console members back', () => {
    const before = console.log;
    const guard = installHookStdoutGuard();
    const during = console.log;
    guard.restore();

    expect(during).not.toBe(before);
    expect(console.log).toBe(before);
  });

  test('restore is idempotent', () => {
    const { stdout } = capture(() => {
      const guard = installHookStdoutGuard();
      guard.restore();
      guard.restore();
      process.stdout.write('still real\n');
    });

    expect(stdout).toBe('still real\n');
  });
});
