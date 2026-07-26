import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { logger } from '../../src/utils/logger.js';
import { paths } from '../../src/shared/paths.js';

// Regression test for #3415: a long-running worker daemon resolved its log
// file path once (lazily, on first log call) and kept appending to the file
// named for its *start* date forever, even after the date rolled over.

const RealDate = Date;

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
  (globalThis as { Date: typeof Date }).Date = RealDate;
});

describe('logger log file date rollover (#3415)', () => {
  it('rolls the log file onto the new date instead of appending to the startup-date file forever', () => {
    const logsDir = paths.logsDir();
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

    const day1File = join(logsDir, 'claude-mem-2030-06-01.log');
    const day2File = join(logsDir, 'claude-mem-2030-06-02.log');
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

    rmSync(day1File, { force: true });
    rmSync(day2File, { force: true });
  });
});
