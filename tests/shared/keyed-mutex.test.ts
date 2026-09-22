import { describe, it, expect } from 'bun:test';
import { KeyedMutex } from '../../src/shared/keyed-mutex.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe('KeyedMutex', () => {
  it('serializes sections that share a key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const first = mutex.runExclusive('corpus', async () => {
      order.push('first:start');
      await tick();
      order.push('first:end');
    });
    const second = mutex.runExclusive('corpus', async () => {
      order.push('second:start');
      await tick();
      order.push('second:end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('runs sections with different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const a = mutex.runExclusive('a', async () => {
      order.push('a:start');
      await tick();
      order.push('a:end');
    });
    const b = mutex.runExclusive('b', async () => {
      order.push('b:start');
      await tick();
      order.push('b:end');
    });

    await Promise.all([a, b]);
    expect(order.slice(0, 2).sort()).toEqual(['a:start', 'b:start']);
  });

  it('releases the lock when a section throws', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.runExclusive('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const result = await mutex.runExclusive('k', async () => 'ok');
    expect(result).toBe('ok');
  });
});
