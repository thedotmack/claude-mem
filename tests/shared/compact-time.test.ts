import { describe, it, expect, afterEach } from 'bun:test';
import { compactTime, formatHeaderDateTime } from '../../src/shared/timeline-formatting.js';

describe('compactTime', () => {
  it('compacts a clock with a plain space before the meridiem', () => {
    expect(compactTime('3:05 PM')).toBe('3:05p');
    expect(compactTime('11:30 AM')).toBe('11:30a');
  });

  it('compacts a clock with the U+202F separator newer ICU emits', () => {
    expect(compactTime('3:05\u202FPM')).toBe('3:05p');
    expect(compactTime('11:30\u202FAM')).toBe('11:30a');
  });

  it('leaves a clock without a meridiem alone apart from lowercasing', () => {
    expect(compactTime('15:05 UTC')).toBe('15:05 utc');
  });
});

describe('formatHeaderDateTime with a U+202F meridiem separator', () => {
  const original = {
    date: Date.prototype.toLocaleDateString,
    time: Date.prototype.toLocaleTimeString,
  };

  afterEach(() => {
    Date.prototype.toLocaleDateString = original.date;
    Date.prototype.toLocaleTimeString = original.time;
  });

  it('removes the narrow no-break space from the header clock', () => {
    Date.prototype.toLocaleDateString = (() => '2025-01-04') as typeof Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleTimeString = ((_locale?: string, options?: Intl.DateTimeFormatOptions) =>
      options?.timeZoneName ? '9:34:56\u202FPM PST' : '9:34\u202FPM') as typeof Date.prototype.toLocaleTimeString;

    expect(formatHeaderDateTime(new Date('2025-01-04T21:34:56.000Z'))).toBe('2025-01-04 9:34pm PST');
  });
});
