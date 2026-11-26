import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The childhood skill's default after-release watch is a full day. A shorter
// default misses slow registry updates, late CI and overnight user reports.
const text = readFileSync(join(import.meta.dir, '../../plugin/skills/childhood/SKILL.md'), 'utf8');

describe('childhood skill observation window', () => {
  it('defaults to 24 hours after the release is public or production is ready', () => {
    expect(text).toContain('Without one, watch through 24 hours after the release first becomes publicly available');
    expect(text).not.toMatch(/watch through 30 minutes/);
  });

  it('spaces checks out across the day and ends with a final sweep', () => {
    expect(text).toContain('**First hour:**');
    expect(text).toContain('**Hours 1–6:**');
    expect(text).toContain('**Hours 6–24:**');
    expect(text).toContain('final sweep at the 24-hour mark');
    expect(text).toContain('returns that surface to first-hour polling');
  });

  it('does not hold a session open for the long gaps', () => {
    expect(text).toContain('Keep individual in-session waits at most 60 seconds');
    expect(text).toContain('record the next check time with `work_state_write`');
    expect(text).toContain('report the window as still open with the next check due, not as clean');
  });
});
