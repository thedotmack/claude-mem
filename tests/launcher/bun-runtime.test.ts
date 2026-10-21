import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { findBun } from '../../src/launcher/bun-runtime.js';

function pendingChildProcess(): ChildProcess & {
  stdout: EventEmitter;
  killed: boolean;
} {
  const child = new EventEmitter() as ChildProcess & {
    stdout: EventEmitter;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', null, 'SIGTERM');
    return true;
  };
  return child;
}

describe('findBun Windows discovery', () => {
  it('checks an explicit Bun path before running where.exe', async () => {
    let lookupStarted = false;
    const result = await findBun({
      platform: 'win32',
      env: { BUN_PATH: 'C:\\tools\\bun.exe' },
      homeDirectory: 'C:\\Users\\test',
      exists: (candidate) => candidate === 'C:\\tools\\bun.exe',
      spawnProcess: (() => {
        lookupStarted = true;
        return pendingChildProcess();
      }) as never,
    });

    expect(result).toBe('C:\\tools\\bun.exe');
    expect(lookupStarted).toBe(false);
  });

  it('kills a stalled where.exe lookup at the deadline', async () => {
    const child = pendingChildProcess();
    const result = await findBun({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      homeDirectory: 'C:\\Users\\test',
      exists: () => false,
      spawnProcess: (() => child) as never,
      timeoutMs: 10,
    });

    expect(result).toBeNull();
    expect(child.killed).toBe(true);
  });

  it('returns an existing Bun executable reported by where.exe', async () => {
    const child = pendingChildProcess();
    const bunPath = 'C:\\Users\\test\\.bun\\bin\\bun.exe';
    const resultPromise = findBun({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      homeDirectory: 'C:\\Users\\test',
      exists: (candidate) => candidate === bunPath,
      spawnProcess: (() => child) as never,
      timeoutMs: 100,
    });
    setTimeout(() => {
      child.stdout.emit('data', `${bunPath}\r\n`);
      child.emit('close', 0, null);
    }, 1);

    expect(await resultPromise).toBe(bunPath);
  });
});
