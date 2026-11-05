// On-access antivirus gates every file open (Defender on macOS: 0.2-2 s per
// open of a busy log). A logger that re-opens the day log for every line
// blocks the worker's event loop once per line; /api/health shares that loop,
// goes silent, and hooks reclaim the worker as wedged. These tests run the
// real logger in a child process on the slow-fs harness and assert the
// platform effect: how many times the day log is opened and how long the loop
// is blocked.
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runWithSlowFs } from '../helpers/slow-fs.js';

const loggerUrl = pathToFileURL(fileURLToPath(new URL('../../src/utils/logger.ts', import.meta.url))).href;

// The driver controls the clock through this Date subclass, so the UTC-midnight
// rollover can be crossed without waiting a day.
const FAKE_CLOCK = `
  const RealDate = Date;
  let offsetMs = 0;
  globalThis.Date = class extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offsetMs); }
    static now() { return RealDate.now() + offsetMs; }
  };
  const advanceDays = n => { offsetMs += n * 86_400_000; };
  const logPath = () => join(dataDir, 'logs', 'claude-mem-' + new Date().toISOString().split('T')[0] + '.log');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
`;

function driver(steps: string, beforeImport = ''): string {
  // beforeImport runs first: Bun snapshots a builtin's named exports at the
  // first ESM import of it, so an fs patch made after that is not seen.
  return `
    ${beforeImport}
    const { join } = await import('path');
    const { writeFileSync, renameSync, rmSync } = await import('fs');
    ${FAKE_CLOCK}
    const { logger } = await import(${JSON.stringify(loggerUrl)});
    await sleep(30);
    ${steps}
  `;
}

function logLines(dataDir: string): string[] {
  const logs = join(dataDir, 'logs');
  if (!existsSync(logs)) return [];
  return readdirSync(logs).sort().flatMap(f => readFileSync(join(logs, f), 'utf8').split('\n').filter(Boolean));
}

describe('logger on a slow filesystem', () => {
  it('opens the day log at most once for a burst of lines', () => {
    const run = runWithSlowFs({
      openDelayMs: 20,
      body: driver(`
        for (let i = 0; i < 50; i++) logger.info('SYSTEM', 'burst line ' + i);
        return logPath();
      `),
    });
    try {
      expect(run.opens[run.result as string]).toBe(1);
      const lines = logLines(run.dataDir);
      expect(lines.length).toBe(50);
      expect(lines[49]).toContain('burst line 49');
    } finally {
      run.cleanup();
    }
  });

  it('keeps the event loop responsive while lines arrive over time', () => {
    const run = runWithSlowFs({
      openDelayMs: 100,
      body: driver(`
        for (let i = 0; i < 20; i++) { logger.info('SYSTEM', 'spaced line ' + i); await sleep(20); }
        return logPath();
      `),
    });
    try {
      // The loop is held once, by the day's first open (100 ms). A re-open per
      // line would hold it 20 times (2000 ms). Measured by the harness, not by
      // wall-clock lag, which a loaded CI machine inflates.
      expect(run.opens[run.result as string]).toBe(1);
      expect(run.blockedMs).toBe(100);
      expect(logLines(run.dataDir).length).toBe(20);
    } finally {
      run.cleanup();
    }
  });

  it('moves to the new day file after UTC midnight', () => {
    const run = runWithSlowFs({
      openDelayMs: 1,
      body: driver(`
        logger.info('SYSTEM', 'day one');
        const first = logPath();
        advanceDays(1);
        logger.info('SYSTEM', 'day two');
        return [first, logPath()];
      `),
    });
    try {
      const [first, second] = run.result as [string, string];
      expect(first).not.toBe(second);
      expect(readFileSync(first, 'utf8')).toContain('day one');
      expect(readFileSync(first, 'utf8')).not.toContain('day two');
      expect(readFileSync(second, 'utf8')).toContain('day two');
      expect(run.opens[first]).toBe(1);
      expect(run.opens[second]).toBe(1);
    } finally {
      run.cleanup();
    }
  });

  it('writes to a fresh file when the day log is renamed away (external rotation)', () => {
    const run = runWithSlowFs({
      openDelayMs: 1,
      body: driver(`
        logger.info('SYSTEM', 'before rotation');
        renameSync(logPath(), logPath() + '.rotated');
        logger.info('SYSTEM', 'after rotation');
        return logPath();
      `),
    });
    try {
      const path = run.result as string;
      expect(readFileSync(path, 'utf8')).toContain('after rotation');
      expect(readFileSync(path + '.rotated', 'utf8')).toContain('before rotation');
      expect(readFileSync(path + '.rotated', 'utf8')).not.toContain('after rotation');
    } finally {
      run.cleanup();
    }
  });

  it('recreates the logs directory when it is deleted while running', () => {
    const run = runWithSlowFs({
      openDelayMs: 1,
      body: driver(`
        logger.info('SYSTEM', 'before delete');
        rmSync(join(dataDir, 'logs'), { recursive: true, force: true });
        logger.info('SYSTEM', 'after delete');
        return logPath();
      `),
    });
    try {
      const path = run.result as string;
      expect(readFileSync(path, 'utf8')).toContain('after delete');
    } finally {
      run.cleanup();
    }
  });

  it('keeps writing after the day log is cleared in place (the viewer clear-logs route)', () => {
    const run = runWithSlowFs({
      openDelayMs: 1,
      body: driver(`
        logger.info('SYSTEM', 'before clear');
        writeFileSync(logPath(), '', 'utf-8');
        logger.info('SYSTEM', 'after clear');
        return logPath();
      `),
    });
    try {
      const text = readFileSync(run.result as string, 'utf8');
      expect(text).not.toContain('before clear');
      expect(text).toContain('after clear');
      // Appending must start at the new end of file, not leave a hole of NUL bytes.
      expect(text.startsWith('[')).toBe(true);
    } finally {
      run.cleanup();
    }
  });

  it('writes whole lines when the kernel accepts only part of a write', () => {
    const run = runWithSlowFs({
      openDelayMs: 1,
      body: driver(`
        logger.info('SYSTEM', 'a line long enough to need several short writes');
        logger.info('SYSTEM', 'second line');
        return globalThis.shortWrites;
      `, `
        // A regular-file write may return fewer bytes than asked (full disk, signal).
        const fs = require('fs');
        const realWriteSync = fs.writeSync;
        globalThis.shortWrites = 0;
        fs.writeSync = (fd, data) => {
          globalThis.shortWrites++;
          return realWriteSync(fd, typeof data === 'string' ? data.slice(0, 10) : data.subarray(0, 10));
        };
      `),
    });
    try {
      const lines = logLines(run.dataDir);
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('a line long enough to need several short writes');
      expect(lines[1]).toContain('second line');
      // The patch really cut the writes: two lines took many 10-byte writes.
      expect(run.result as number).toBeGreaterThan(10);
    } finally {
      run.cleanup();
    }
  });

  it('gives up on a line instead of spinning when the kernel writes nothing', () => {
    const run = runWithSlowFs({
      openDelayMs: 1,
      timeoutMs: 10_000,
      body: driver(`
        logger.info('SYSTEM', 'never written');
        return 'returned';
      `, `
        const fs = require('fs');
        fs.writeSync = () => 0;
      `),
    });
    try {
      expect(run.result).toBe('returned');
    } finally {
      run.cleanup();
    }
  });
});
