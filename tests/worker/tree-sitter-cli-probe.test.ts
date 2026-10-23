import { afterAll, describe, expect, it, mock } from 'bun:test';
import * as childProcess from 'node:child_process';

const realChildProcess = { ...childProcess };
let callbackResult: { error: Error | null; stdout: string | Buffer; stderr: string | Buffer };

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execFile: ((...args: any[]) => {
    const callback = args[3] as (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;
    const { error, stdout, stderr } = callbackResult;
    queueMicrotask(() => callback(error, stdout, stderr));
    return { stdin: { end() {} } };
  }) as typeof childProcess.execFile,
}));

const { isTreeSitterCliBinaryUsable } = await import('../../src/services/smart-file-read/tree-sitter-cli-provision.js');

afterAll(() => {
  mock.module('node:child_process', () => realChildProcess);
});

async function probeWithUncaughtExceptionCapture(): Promise<{ result: boolean | undefined; uncaught: unknown }> {
  let uncaught: unknown;
  const captureUncaught = (error: unknown) => { uncaught = error; };
  process.on('uncaughtException', captureUncaught);
  try {
    const result = await Promise.race([
      isTreeSitterCliBinaryUsable('/fake-plugin-root'),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);
    return { result, uncaught };
  } finally {
    process.off('uncaughtException', captureUncaught);
  }
}

describe('tree-sitter CLI version probe callback output', () => {
  it('treats an ENOENT callback with Buffer stderr as unavailable without throwing', async () => {
    callbackResult = {
      error: Object.assign(new Error('spawn tree-sitter ENOENT'), { code: 'ENOENT' }),
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('tree-sitter binary not found'),
    };

    expect(await probeWithUncaughtExceptionCapture()).toEqual({ result: false, uncaught: undefined });
  });

  it('normalizes Buffer stderr for a failed probe', async () => {
    callbackResult = {
      error: Object.assign(new Error('spawn tree-sitter EACCES'), { code: 'EACCES' }),
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('permission denied'),
    };

    expect(await probeWithUncaughtExceptionCapture()).toEqual({ result: false, uncaught: undefined });
  });

  it('accepts a version printed to Buffer stdout', async () => {
    callbackResult = {
      error: null,
      stdout: Buffer.from('tree-sitter 0.26.9\n'),
      stderr: Buffer.alloc(0),
    };

    expect(await probeWithUncaughtExceptionCapture()).toEqual({ result: true, uncaught: undefined });
  });
});
