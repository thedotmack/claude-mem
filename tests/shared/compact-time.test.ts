import { describe, it, expect } from 'bun:test';
import { compactTime } from '../../src/shared/timeline-formatting.js';

describe('compactTime', () => {
  it('compacts a clock with a plain space before the meridiem', () => {
    expect(compactTime('3:05 PM')).toBe('3:05p');
    expect(compactTime('11:30 AM')).toBe('11:30a');
  });

  it('compacts a clock with the U+202F separator newer ICU emits', () => {
    expect(compactTime('3:05\u202FPM')).toBe('3:05p');
    expect(compactTime('11:30\u202FAM')).toBe('11:30a');
  });

  it('leaves an ISO fallback clock alone', () => {
    expect(compactTime('15:05 UTC')).toBe('15:05 utc');
  });
});
