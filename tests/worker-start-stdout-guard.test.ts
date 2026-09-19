/**
 * Issue #4081, the second SessionStart hook.
 *
 * plugin/hooks/hooks.json registers TWO SessionStart commands, and the report
 * shows the parse error twice per session because both are affected:
 *
 *   worker-service start                 -> main()'s `start` case
 *   worker-service hook claude-code context -> hookCommand()
 *
 * Only the second goes through hookCommand, so only the second was covered by
 * the stdout guard. The `start` case emitted its status envelope with a bare
 * console.log on an unguarded stdout, which is the channel #4081 says a banner
 * gets into.
 *
 * These tests do not reproduce that banner -- nobody has been able to find its
 * emitter. They pin the property that makes it irrelevant on this path too: a
 * third party writing to stdout during the `start` window cannot reach stdout,
 * and the status envelope still can.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHookStdoutGuard, resetHookIoState } from '../src/shared/hook-io.js';
import { buildStatusOutput, emitStatusOutput } from '../src/services/worker-service.js';

const REPO_ROOT = join(import.meta.dir, '..');

/**
 * Capture both stdout channels. console.log is intercepted separately from
 * process.stdout.write because under Bun they are not the same channel, so a
 * helper that replaced only process.stdout.write would score the unguarded
 * control as clean and the file would prove nothing. (tests/hook-stdout-guard
 * .test.ts measures that Bun behaviour out of process.)
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

describe('SessionStart `start` hook stdout (#4081)', () => {
  test('the control: what the start case did before, banner and envelope both on stdout', () => {
    const { stdout } = capture(() => {
      process.stdout.write(BANNER);
      // Verbatim the old exitWithStatus body: no guard, envelope via console.log.
      console.log(JSON.stringify(buildStatusOutput('ready')));
    });

    // Two JSON objects concatenated -- exactly what the hook parser chokes on.
    expect(stdout.trimEnd().split('\n')).toHaveLength(2);
    expect(() => JSON.parse(stdout)).toThrow();
  });

  test('with the guard, stdout is the envelope alone and still parses', () => {
    const { stdout } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        process.stdout.write(BANNER);
        emitStatusOutput('ready');
      } finally {
        guard.restore();
      }
    });

    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    const payload = JSON.parse(stdout) as { continue: boolean; status: string };
    expect(payload.continue).toBe(true);
    expect(payload.status).toBe('ready');
  });

  test('the diverted banner is not dropped, it reaches stderr', () => {
    const { stderr } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        process.stdout.write(BANNER);
        emitStatusOutput('ready');
      } finally {
        guard.restore();
      }
    });

    expect(stderr).toContain('Detected an AI agent environment');
  });

  test('console.log noise during the worker boot is diverted too', () => {
    // ensureWorkerStarted runs inside the guarded window, so anything it or a
    // dependency prints with console.log has to be diverted as well -- under
    // Bun console.log does not go through process.stdout.write.
    const { stdout, stderr } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        console.log('spawning worker...');
        emitStatusOutput('ready');
      } finally {
        guard.restore();
      }
    });

    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('spawning worker...');
  });

  test('the error envelope survives the guard as well as the ready one', () => {
    // The `dead` branch carries the boot failure text to the user; it must not
    // be the one payload the guard eats.
    const { stdout } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        process.stdout.write(BANNER);
        emitStatusOutput('error', 'Failed to start worker: port in use');
      } finally {
        guard.restore();
      }
    });

    const payload = JSON.parse(stdout) as { status: string; message: string };
    expect(payload.status).toBe('error');
    expect(payload.message).toBe('Failed to start worker: port in use');
  });

  test('the envelope keeps its trailing newline', () => {
    const { stdout } = capture(() => {
      const guard = installHookStdoutGuard();
      try {
        emitStatusOutput('ready');
      } finally {
        guard.restore();
      }
    });

    expect(stdout.endsWith('\n')).toBe(true);
  });

  test('measured: the real `start` command emits one JSON object on real fd 1', () => {
    // The cells above exercise the pieces; this one runs the actual command the
    // SessionStart hook runs and reads its real stdout. The worker boot is
    // stubbed (spawning one from a test would be slow and would fight the
    // developer's own worker) and made to print the banner from inside the
    // start window, which is where an in-process guard can act on it.
    //
    // Both writers, on purpose: under Bun console.log does not go through
    // process.stdout.write, so a guard that replaced only the latter would
    // still leak the second line.
    const dir = mkdtempSync(join(tmpdir(), 'cmem-4081-'));
    try {
      const preload = join(dir, 'preload.ts');
      writeFileSync(
        preload,
        [
          "import { mock } from 'bun:test';",
          `mock.module(${JSON.stringify(join(REPO_ROOT, 'src/services/worker-spawner.ts'))}, () => ({`,
          '  ensureWorkerStarted: async () => {',
          `    process.stdout.write(${JSON.stringify(BANNER)});`,
          "    console.log('{\"type\":\"message\",\"message\":\"banner via console.log\"}');",
          "    return 'running';",
          '  },',
          '  getLastWorkerBootFailure: () => null,',
          '}));',
          `mock.module(${JSON.stringify(join(REPO_ROOT, 'src/shared/plugin-state.ts'))}, () => ({`,
          '  isPluginDisabledInClaudeSettings: () => false,',
          '}));',
        ].join('\n')
      );

      const result = spawnSync(
        process.execPath,
        ['--preload', preload, join(REPO_ROOT, 'src/services/worker-service.ts'), 'start'],
        {
          encoding: 'utf-8',
          cwd: REPO_ROOT,
          env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data') },
        }
      );

      expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
      const payload = JSON.parse(result.stdout) as { continue: boolean; status: string };
      expect(payload.continue).toBe(true);
      expect(payload.status).toBe('ready');
      // Diverted, not dropped.
      expect(result.stderr).toContain('Detected an AI agent environment');
      expect(result.stderr).toContain('banner via console.log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('without a guard installed the envelope still reaches stdout', () => {
    // Non-hook callers and the pre-guard tests: emitStdoutPayload falls back to
    // console.log, so this path must not depend on a guard being installed.
    const { stdout } = capture(() => {
      emitStatusOutput('ready');
    });

    expect(JSON.parse(stdout)).toMatchObject({ continue: true, status: 'ready' });
  });
});
