import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('follows same-size replacements whose file IDs differ beyond Number precision', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-mem-follow-identity-'));
  const log = join(home, '.claude-mem', 'logs', `claude-mem-${new Date().toISOString().slice(0, 10)}.log`);
  mkdirSync(join(home, '.claude-mem', 'logs'), { recursive: true });
  writeFileSync(log, 'old line 1\n');
  const preload = join(home, 'large-file-ids.cjs');
  // Keep native reads, descriptors, polling and rename/recreate. Normalize
  // only the file ID into the 64-bit range used by filesystems such as NTFS:
  // distinct adjacent IDs there can become the same JavaScript Number.
  writeFileSync(preload, `
    const fs = require('fs');
    const nativeStat = fs.fstatSync, nativeWatch = fs.watchFile;
    const ids = new Map();
    function withFileId(stats, bigint) {
      const key = String(stats.dev) + ':' + String(stats.ino);
      if (!ids.has(key)) ids.set(key, 9007199254740992n + BigInt(ids.size));
      const id = ids.get(key);
      const mapped = Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: id });
      if (!bigint) for (const key of Object.keys(mapped)) {
        if (typeof mapped[key] === 'bigint') mapped[key] = Number(mapped[key]);
      }
      return mapped;
    }
    let statCount = 0;
    fs.fstatSync = function(fd, options) {
      const output = withFileId(nativeStat(fd, { bigint: true }), !!options?.bigint);
      if (++statCount === 2) process.stderr.write('INITIAL_DRAIN_READY\\n');
      return output;
    };
    fs.watchFile = function(path, options, listener) {
      return nativeWatch(path, { ...options, bigint: true }, (current, previous) => {
        listener(withFileId(current, !!options?.bigint), withFileId(previous, !!options?.bigint));
        if (current.ino !== previous.ino) process.stderr.write('ROTATION_POLL\\n');
      });
    };
  `);
  const child = spawn('node', ['--require', preload, join(import.meta.dir, '../../scripts/worker-logs.cjs'), '--follow'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MEM_DATA_DIR: '', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', trace = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { trace += chunk; });
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify({ output, trace })}`);
      await Bun.sleep(10);
    }
  };
  try {
    await wait(() => output === 'old line 1\n' && trace.includes('INITIAL_DRAIN_READY'), 'initial tail');
    renameSync(log, `${log}.1`);
    writeFileSync(log, 'new line A\n');
    await wait(() => trace.includes('ROTATION_POLL'), 'native rotation event');
    await wait(() => output.includes('new line A\n'), 'replacement bytes');
    appendFileSync(log, 'appended €\n');
    await wait(() => output.includes('appended €\n'), 'replacement append');
    expect(output).toBe('old line 1\nnew line A\nappended €\n');
  } finally {
    const exited = child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
