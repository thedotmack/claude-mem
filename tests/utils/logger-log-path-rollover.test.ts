import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { logger } from '../../src/utils/logger.js';
import { paths } from '../../src/shared/paths.js';

// Regression test for #3415: a long-running worker daemon resolved its log
// file path once (lazily, on first log call) and kept appending to the file
// named for its *start* date forever, even after the date rolled over.

const RealDate = Date;
const logsDir = paths.logsDir();
const generatedFiles = [
  join(logsDir, 'claude-mem-2030-06-01.log'),
  join(logsDir, 'claude-mem-2030-06-02.log'),
  join(logsDir, 'claude-mem-2030-06-03.log'),
];
let logsDirSpy: ReturnType<typeof spyOn> | undefined;

function setFakeDate(iso: string): void {
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(iso);
      } else {
        // @ts-expect-error - forwarding constructor args to the real Date
        super(...args);
      }
    }
    static now(): number {
      return new RealDate(iso).getTime();
    }
  }
  (globalThis as { Date: typeof Date }).Date = FixedDate;
}

afterEach(() => {
  logsDirSpy?.mockRestore();
  logsDirSpy = undefined;
  (globalThis as { Date: typeof Date }).Date = RealDate;
  for (const file of generatedFiles) {
    rmSync(file, { force: true });
  }
});

describe('logger log file date rollover (#3415)', () => {
  it('rolls the log file onto the new date instead of appending to the startup-date file forever', () => {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

    const [day1File, day2File] = generatedFiles;
    rmSync(day1File, { force: true });
    rmSync(day2File, { force: true });

    setFakeDate('2030-06-01T23:59:00.000Z');
    logger.info('SYSTEM', 'rollover-marker-day1');

    setFakeDate('2030-06-02T00:05:00.000Z');
    logger.info('SYSTEM', 'rollover-marker-day2');

    expect(existsSync(day1File)).toBe(true);
    expect(existsSync(day2File)).toBe(true);

    const day1Content = readFileSync(day1File, 'utf8');
    const day2Content = readFileSync(day2File, 'utf8');

    expect(day1Content).toContain('rollover-marker-day1');
    expect(day1Content).not.toContain('rollover-marker-day2');
    expect(day2Content).toContain('rollover-marker-day2');
  });

  it('retries same-day initialization after a transient path failure', () => {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const day3File = generatedFiles[2];
    rmSync(day3File, { force: true });

    let calls = 0;
    logsDirSpy = spyOn(paths, 'logsDir').mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('transient path failure');
      return logsDir;
    });

    setFakeDate('2030-06-03T00:05:00.000Z');
    logger.info('SYSTEM', 'first-attempt-fails');
    logger.info('SYSTEM', 'same-day-retry-succeeds');

    expect(calls).toBe(2);
    expect(existsSync(day3File)).toBe(true);
    expect(readFileSync(day3File, 'utf8')).toContain('same-day-retry-succeeds');
  });
});
