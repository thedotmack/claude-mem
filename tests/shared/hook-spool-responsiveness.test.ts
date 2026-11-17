import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookSpool } from '../../src/shared/hook-spool.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function backlog(count: number): HookSpool {
  const directory = mkdtempSync(join(tmpdir(), 'spool-responsive-'));
  directories.push(directory);
  for (let index = 0; index < count; index++) {
    writeFileSync(join(directory, `session_end-${index}.json`), JSON.stringify({
      kind: 'session_end',
      enqueuedAtEpochMs: Date.now() + index,
      payload: { contentSessionId: `session-${index}`, platformSource: 'claude' },
    }));
  }
  return new HookSpool(directory);
}

it('serves a health request while reading a metadata backlog, before the first handoff', async () => {
  const spool = backlog(1024);
  let healthRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch() { healthRequests++; return new Response('healthy'); },
  });
  let firstHandoffHealthRequests: number | undefined;
  const probe = new Promise<void>((resolve, reject) => setImmediate(async () => {
    try {
      expect(await (await fetch(server.url)).text()).toBe('healthy');
      resolve();
    } catch (error) { reject(error); }
  }));
  try {
    const result = await spool.drain(() => {
      firstHandoffHealthRequests ??= healthRequests;
      return true;
    });
    await probe;
    expect(result).toEqual({ drained: 1024, retained: 0, quarantined: 0, expired: 0 });
    expect(firstHandoffHealthRequests).toBeGreaterThan(0);
  } finally {
    try { await probe; } finally { server.stop(true); }
  }
});

it('continues servicing the event loop while removing accepted metadata', async () => {
  const spool = backlog(128);
  let yielded = false;
  let lastHandoffYielded = false;
  let accepted = 0;
  let immediate: ReturnType<typeof setImmediate> | undefined;
  try {
    const result = await spool.drain(() => {
      if (accepted++ === 0) immediate = setImmediate(() => { yielded = true; });
      lastHandoffYielded = yielded;
      return true;
    });
    expect(result.drained).toBe(128);
    expect(lastHandoffYielded).toBe(true);
  } finally {
    if (immediate) clearImmediate(immediate);
  }
});
