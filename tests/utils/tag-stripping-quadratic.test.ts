import { describe, it, expect } from 'bun:test';
import { stripMemoryTagsFromJsonStrings, stripSystemReminderBlocks } from '../../src/utils/tag-stripping.js';

describe('stripSystemReminderBlocks', () => {
  it('keeps tag-free text byte-identical (small)', () => {
    const text = 'lead </system-reminder> trail';
    expect(stripSystemReminderBlocks(text)).toBe(text);
  });

  it('keeps tag-free text byte-identical (large, lookalike tags included)', () => {
    const text = 'a<system-reminderX>b</system-reminderX>c</system-reminder>d' + 'x'.repeat(2000);
    expect(stripSystemReminderBlocks(text)).toBe(text);
  });

  it('cuts well-formed blocks leftmost-first (small)', () => {
    expect(stripSystemReminderBlocks('A<system-reminder>r</system-reminder>B')).toBe('AB');
  });

  it('cuts well-formed blocks leftmost-first (large, stray close preserved)', () => {
    const text = 'a</system-reminder>b'
      + 'x<system-reminder>r0</system-reminder>y'
      + '<system-reminder>r1</system-reminder>y';
    expect(stripSystemReminderBlocks(text)).toBe('a</system-reminder>bxyy');
  });

  it('pairs the leftmost open with the first close, nested open included (small)', () => {
    const text = 'A<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>B';
    expect(stripSystemReminderBlocks(text)).toBe('Ac</system-reminder>B');
  });

  it('pairs the leftmost open with the first close, nested open included (large)', () => {
    const text = 'x<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>y'
      + '<system-reminder>d</system-reminder>z';
    expect(stripSystemReminderBlocks(text)).toBe('xc</system-reminder>yz');
  });

  it('keeps the tail verbatim when an open has no close (small)', () => {
    expect(stripSystemReminderBlocks('A<system-reminder>never closed'))
      .toBe('A<system-reminder>never closed');
  });

  it('keeps the tail verbatim when an open has no close (large)', () => {
    const text = 'A<system-reminder>r</system-reminder>B<system-reminder>x<system-reminder>y';
    expect(stripSystemReminderBlocks(text)).toBe('AB<system-reminder>x<system-reminder>y');
  });
});

describe('stripMemoryTagsFromJsonStrings gate', () => {
  // Byte-identity with the shipped behavior: the old
  // `<(name)\b[^>]*>[\s\S]*?</\1>` probe ran stripMemoryTags when positive and
  // returned the string untouched when negative. Expected values below are the
  // outputs that semantics produced.
  describe('byte-identity with the old regex-gate behavior', () => {
    it('tag-free string (small)', () => {
      expect(stripMemoryTagsFromJsonStrings({ s: 'plain text' })).toEqual({ s: 'plain text' });
    });

    it('tag-free string with angle brackets (large)', () => {
      const s = '<div>a</div> ' + 'mid <angled> & plain '.repeat(50);
      expect(stripMemoryTagsFromJsonStrings({ s })).toEqual({ s });
    });

    it('well-formed tag (small)', () => {
      expect(stripMemoryTagsFromJsonStrings({ s: 'x<private>secret</private>y' }))
        .toEqual({ s: 'xy' });
    });

    it('well-formed tags, trim through the positive gate (large)', () => {
      expect(stripMemoryTagsFromJsonStrings({
        s: '  a<private>p</private>b<system-reminder>r</system-reminder>'
          + 'c<claude-mem-context>m</claude-mem-context>d  ',
      })).toEqual({ s: 'abcd' });
    });

    it('nested tags (small)', () => {
      expect(stripMemoryTagsFromJsonStrings({
        s: '<private>a<system-reminder>b</system-reminder>c</private>',
      })).toEqual({ s: '' });
    });

    it('nested tags across names (large)', () => {
      expect(stripMemoryTagsFromJsonStrings({
        s: 'keep <system-reminder>a<private>b</private>c</system-reminder>'
          + 'd<claude-mem-context>e</claude-mem-context>end',
      })).toEqual({ s: 'keep dend' });
    });

    it('unclosed tag (small)', () => {
      expect(stripMemoryTagsFromJsonStrings({ s: '<private>never closed' }))
        .toEqual({ s: '<private>never closed' });
    });

    it('unclosed tags (large)', () => {
      const s = '<private>'.repeat(2000);
      expect(stripMemoryTagsFromJsonStrings({ s })).toEqual({ s });
    });
  });

  it('strips a whitespace-closed tag the old regex gate silently kept', () => {
    expect(stripMemoryTagsFromJsonStrings({ s: 'x<private>y</private >z' })).toEqual({ s: 'xz' });
  });

  it('keeps a hyphen lookalike tag byte-identical, whitespace included', () => {
    expect(stripMemoryTagsFromJsonStrings({ s: '  <private-x>y</private>  ' }))
      .toEqual({ s: '  <private-x>y</private>  ' });
  });

  it('keeps a hyphen lookalike tag untouched without surrounding whitespace', () => {
    expect(stripMemoryTagsFromJsonStrings({ s: '<private-x>y</private>' }))
      .toEqual({ s: '<private-x>y</private>' });
  });

  it('stays linear on a ~400KB payload of unclosed opens', () => {
    const payload = '<private>'.repeat(45_000);
    const start = Date.now();
    const result = stripMemoryTagsFromJsonStrings({ payload });
    const elapsed = Date.now() - start;
    expect(result).toEqual({ payload });
    expect(elapsed).toBeLessThan(500);
  });
});
