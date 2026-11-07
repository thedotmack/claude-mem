import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';

const HOOK_IO_PATH = join(import.meta.dir, '..', '..', 'src', 'shared', 'hook-io.ts');
const CONTEXT = 'x'.repeat(1024 * 1024) + '\nSynthetic context: \u03bb \ud83d\ude80';
const nodePath = Bun.which('node');
const runtimes = [
  { name: 'Bun', executable: process.execPath },
  ...(nodePath ? [{ name: 'Node', executable: nodePath }] : []),
];
let fixtureDir: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-stdout-'));
  const entrypoint = join(fixtureDir, 'fixture.ts');
  writeFileSync(entrypoint, `
    import { writeSync } from 'node:fs';
    import { emitModelContext, exitGraceful, installHookStderrBuffer } from ${JSON.stringify(HOOK_IO_PATH)};

    const context = ${JSON.stringify(CONTEXT)};
    const adapter = {
      normalizeInput: (input) => input,
      formatOutput: () => process.argv[2] === 'raw'
        ? context
        : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } },
    };
    installHookStderrBuffer();
    process.stderr.write('buffered library noise\\n');

    // Node's old immediate exit prevents this callback from running. The parent
    // then drains on child exit, exposing bytes lost from the pending write.
    // Bun's console.log can block synchronously, so release its reader first.
    if (process.versions.bun) {
      writeSync(3, 'drain');
    } else {
      setImmediate(() => writeSync(3, 'drain'));
    }
    try {
      emitModelContext(adapter, {});
      await exitGraceful();
    } catch (error) {
      writeSync(3, 'failure:' + (error instanceof Error ? error.name : String(error)) + '\\n');
      process.exit(1);
    }
  `);
  const build = await Bun.build({ entrypoints: [entrypoint], target: 'node', format: 'esm' });
  if (!build.success) {
    throw new Error(`Failed to build hook stdout fixture: ${build.logs.join('\n')}`);
  }
  fixturePath = join(fixtureDir, 'fixture.mjs');
  writeFileSync(fixturePath, await build.outputs[0].text());
});

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

interface CapturedOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  marker: string;
}

function captureWithPausedReader(
  executable: string,
  kind: 'json' | 'raw',
  closeReader = false,
): Promise<CapturedOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [fixturePath, kind], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const marker: Buffer[] = [];
    child.stdout!.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stdout!.pause();
    if (closeReader) child.stdout!.destroy();
    child.stderr!.on('data', chunk => stderr.push(Buffer.from(chunk)));
    const drainMarker = child.stdio[3] as Readable;
    drainMarker.on('data', chunk => {
      marker.push(Buffer.from(chunk));
      child.stdout!.resume();
    });
    child.once('exit', () => child.stdout!.resume());

    // A deadline prevents a broken flush implementation from leaking a child.
    // Reader release itself uses the fixture's marker or exit, never a sleep.
    const deadline = setTimeout(() => {
      child.stdout!.resume();
      child.kill();
      reject(new Error('Hook stdout fixture did not finish within 5 seconds'));
    }, 5000);
    child.once('error', error => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
        marker: Buffer.concat(marker).toString('utf-8'),
      });
    });
  });
}

describe('hook stdout completes before graceful exit', () => {
  for (const runtime of runtimes) {
    it(`${runtime.name} preserves the entire large JSON envelope through a paused pipe`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'json');
      const expected = JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT },
      }) + '\n';

      expect(output.code).toBe(0);
      expect(output.signal).toBeNull();
      expect(output.stderr).toBe('');
      expect(output.stdout.length).toBe(expected.length);
      expect(output.stdout === expected).toBe(true);
      expect(output.stdout.endsWith('\n')).toBe(true);
      expect(JSON.parse(output.stdout).hookSpecificOutput.additionalContext === CONTEXT).toBe(true);
    }, 10000);

    it(`${runtime.name} preserves the entire large raw adapter string and trailing newline`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'raw');
      const expected = CONTEXT + '\n';

      expect(output.code).toBe(0);
      expect(output.signal).toBeNull();
      expect(output.stderr).toBe('');
      expect(output.stdout.length).toBe(expected.length);
      expect(output.stdout === expected).toBe(true);
      expect(output.stdout.endsWith('\n')).toBe(true);
    }, 10000);

    it(`${runtime.name} rejects a closed stdout pipe with a handled delivery error`, async () => {
      const output = await captureWithPausedReader(runtime.executable, 'json', true);

      expect(output.code).toBe(1);
      expect(output.signal).toBeNull();
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe('');
      expect(output.marker).toContain('failure:HookStdoutError\n');
    }, 10000);
  }
});
