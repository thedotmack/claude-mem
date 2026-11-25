import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A one-node ONNX model (y = x · W, W a 4x4 matrix of ones), so a real
// onnxruntime-node session starts without downloading the embedding model.
const TINY_MODEL_BASE64 =
  'CAg6iQEKEQoBeAoBdxIBeSIGTWF0TXVsEgFnKksIBAgEEAEiQAAAgD8AAIA/AACAPwAAgD8AAIA/AACAPwAAgD8AAIA/AACAPwAAgD8AAIA/AACAPwAAgD8AAIA/AACAPwAAgD9CAXdaEQoBeBIMCgoIARIGCgAKAggEYhEKAXkSDAoKCAESBgoACgIIBEIECgAQDQ==';

const GUARD = join(import.meta.dir, '..', 'helpers', 'onnxruntime-exit-guard.ts');
// The child script sits in a temp dir, so it imports onnxruntime-node by path.
const ORT = require.resolve('onnxruntime-node');

// Each case runs in its own process: releasing the runtime in this one would
// break every later test that embeds.
function runChild(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ort-exit-guard-'));
  try {
    const modelPath = join(dir, 'tiny.onnx');
    writeFileSync(modelPath, Buffer.from(TINY_MODEL_BASE64, 'base64'));
    const scriptPath = join(dir, 'child.ts');
    writeFileSync(scriptPath, script);
    const result = Bun.spawnSync([process.execPath, scriptPath], {
      cwd: join(import.meta.dir, '..', '..'),
      env: { ...process.env, TINY_MODEL: modelPath, GUARD, ORT },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('onnxruntime exit guard', () => {
  it('does nothing until the binding is loaded, then releases a live runtime once', () => {
    const { exitCode, stdout, stderr } = runChild(`
      const { releaseOnnxRuntimeForExit } = await import(process.env.GUARD);
      console.log('before import', releaseOnnxRuntimeForExit());
      const ort = await import(process.env.ORT);
      console.log('before session', releaseOnnxRuntimeForExit());
      const session = await ort.InferenceSession.create(process.env.TINY_MODEL);
      const out = await session.run({ x: new ort.Tensor('float32', new Float32Array(4).fill(2), [1, 4]) });
      console.log('ran', Array.from(out.y.data).join(','));
      console.log('after session', releaseOnnxRuntimeForExit());
      console.log('again', releaseOnnxRuntimeForExit());
    `);
    expect(stderr).not.toContain('panic');
    expect(stdout.trim().split('\n')).toEqual([
      'before import not-loaded',
      'before session idle',
      'ran 8,8,8,8',
      'after session released',
      'again idle',
    ]);
    expect(exitCode).toBe(0);
  });

  // Bun ends a test run through libc exit() on macOS, which runs the C++
  // static destructors that crashed. Leave the same way here, on every
  // platform, and check the exit code chosen survives.
  it('leaves through libc exit() with the chosen exit code after a session ran', () => {
    const libc = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
    const { exitCode, stdout, stderr } = runChild(`
      const { releaseOnnxRuntimeForExit } = await import(process.env.GUARD);
      const { dlopen, FFIType } = await import('bun:ffi');
      const ort = await import(process.env.ORT);
      const session = await ort.InferenceSession.create(process.env.TINY_MODEL);
      await session.run({ x: new ort.Tensor('float32', new Float32Array(4).fill(1), [1, 4]) });
      console.log(releaseOnnxRuntimeForExit());
      dlopen(${JSON.stringify(libc)}, { exit: { args: [FFIType.i32], returns: FFIType.void } }).symbols.exit(3);
    `);
    expect(stdout.trim()).toBe('released');
    expect(stderr).not.toContain('panic');
    expect(stderr).not.toContain('mutex lock failed');
    expect(exitCode).toBe(3);
  });

  // The fix is the hook in tests/preload.ts. Run a real `bun test` with the
  // repo's preload over two files that each run a session, and check the hook
  // released the runtime once, after both files, with the run passing.
  it('releases the runtime from the preload after the last test file of a bun test run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ort-exit-guard-run-'));
    try {
      const modelPath = join(dir, 'tiny.onnx');
      writeFileSync(modelPath, Buffer.from(TINY_MODEL_BASE64, 'base64'));
      const report = join(dir, 'report.txt');
      const files = ['a', 'b'].map(name => {
        const file = join(dir, `${name}.test.ts`);
        writeFileSync(file, `
          import { appendFileSync } from 'fs';
          import { expect, it } from 'bun:test';
          it('runs a session', async () => {
            const ort = await import(process.env.ORT!);
            const session = await ort.InferenceSession.create(process.env.TINY_MODEL!);
            const out = await session.run({ x: new ort.Tensor('float32', new Float32Array(4).fill(1), [1, 4]) });
            expect(Array.from(out.y.data)).toEqual([4, 4, 4, 4]);
            appendFileSync(process.env.CLAUDE_MEM_ORT_EXIT_GUARD_REPORT!, '${name} done\\n');
          });
        `);
        return file;
      });
      const result = Bun.spawnSync([process.execPath, 'test', ...files], {
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, TINY_MODEL: modelPath, ORT, CLAUDE_MEM_ORT_EXIT_GUARD_REPORT: report },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain('panic');
      expect(output).toContain('2 pass');
      expect(result.exitCode).toBe(0);
      expect(readFileSync(report, 'utf8').trim().split('\n').sort()).toEqual(['a done', 'b done', 'guard released']);
      expect(readFileSync(report, 'utf8').trim().split('\n').at(-1)).toBe('guard released');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
