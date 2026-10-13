import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { resolveDateBound } from '../../src/shared/date-bounds.js';

describe('resolveDateBound', () => {
  it('passes numeric epochs through unchanged', () => {
    expect(resolveDateBound(1735689600000, 'start')).toBe(1735689600000);
    expect(resolveDateBound(1735689600000, 'end')).toBe(1735689600000);
  });

  it('resolves a date-only start bound to the start of the day', () => {
    expect(resolveDateBound('2025-01-01', 'start')).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
  });

  it('resolves a date-only end bound to the last millisecond of the day', () => {
    expect(resolveDateBound('2025-01-01', 'end')).toBe(Date.parse('2025-01-01T23:59:59.999Z'));
  });

  it('covers a full day when start and end are the same date', () => {
    const start = resolveDateBound('2025-01-01', 'start');
    const end = resolveDateBound('2025-01-01', 'end');
    const midday = Date.parse('2025-01-01T12:00:00.000Z');
    expect(start).toBeLessThanOrEqual(midday);
    expect(end).toBeGreaterThanOrEqual(midday);
  });

  it('leaves an end bound with an explicit time untouched', () => {
    const value = '2025-01-01T08:30:00.000Z';
    expect(resolveDateBound(value, 'end')).toBe(Date.parse(value));
  });
});

// The child process enforces a non-UTC timezone independently of the parent runner.
describe('whitespace-padded date bounds', () => {
  it('normalizes both boundaries before parsing a date-only string', () => {
    const midnight = Date.parse('2025-01-01T00:00:00.000Z');
    for (const value of [' 2025-01-01 ', '\t2025-01-01\n']) {
      expect(resolveDateBound(value, 'start')).toBe(midnight);
      expect(resolveDateBound(value, 'end')).toBe(midnight + 86_400_000 - 1);
    }
  });
});

it('retains date-only UTC boundaries in a non-UTC child process', () => {
  const modulePath = fileURLToPath(new URL('../../src/shared/date-bounds.ts', import.meta.url));
  const script = `import { resolveDateBound } from ${JSON.stringify(modulePath)};
    console.log(JSON.stringify([resolveDateBound(' 2025-01-01 ', 'start'), resolveDateBound(' 2025-01-01 ', 'end')]));`;
  const child = Bun.spawnSync({ cmd: [process.execPath, '--eval', script], env: { ...process.env, TZ: 'America/New_York' }, stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode).toBe(0);
  const midnight = Date.parse('2025-01-01T00:00:00.000Z');
  expect(JSON.parse(child.stdout.toString())).toEqual([midnight, midnight + 86_400_000 - 1]);
});
