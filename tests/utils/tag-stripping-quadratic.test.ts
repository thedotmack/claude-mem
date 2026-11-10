import { describe, it, expect } from 'bun:test';
import { stripMemoryTagsFromJsonStrings, stripSystemReminderBlocks } from '../../src/utils/tag-stripping.js';

describe('stripSystemReminderBlocks', () => {
  it.each<[string, string, string]>([
    ['keeps tag-free text byte-identical (small)', 'lead </system-reminder> trail', 'lead </system-reminder> trail'],
    ['keeps tag-free text byte-identical (large, lookalike tags included)', 'a<system-reminderX>b</system-reminderX>c</system-reminder>d' + 'x'.repeat(2000), 'a<system-reminderX>b</system-reminderX>c</system-reminder>d' + 'x'.repeat(2000)],
    ['cuts well-formed blocks leftmost-first (small)', 'A<system-reminder>r</system-reminder>B', 'AB'],
    ['cuts well-formed blocks leftmost-first (large, stray close preserved)', 'a</system-reminder>b' + 'x<system-reminder>r0</system-reminder>y' + '<system-reminder>r1</system-reminder>y', 'a</system-reminder>bxyy'],
    ['pairs the leftmost open with the first close, nested open included (small)', 'A<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>B', 'Ac</system-reminder>B'],
    ['pairs the leftmost open with the first close, nested open included (large)', 'x<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>y' + '<system-reminder>d</system-reminder>z', 'xc</system-reminder>yz'],
    ['keeps the tail verbatim when an open has no close (small)', 'A<system-reminder>never closed', 'A<system-reminder>never closed'],
    ['keeps the tail verbatim when an open has no close (large)', 'A<system-reminder>r</system-reminder>B<system-reminder>x<system-reminder>y', 'AB<system-reminder>x<system-reminder>y'],
  ])('%s', (_name, input, expected) => {
    expect(stripSystemReminderBlocks(input)).toBe(expected);
  });
});

describe('stripMemoryTagsFromJsonStrings gate', () => {
  // Byte-identity with the shipped behavior: the old
  // `<(name)\b[^>]*>[\s\S]*?</\1>` probe ran stripMemoryTags when positive and
  // returned the string untouched when negative. Expected values below are the
  // outputs that semantics produced.
  describe('byte-identity with the old regex-gate behavior', () => {
    it.each<[string, { s: string }, { s: string }]>([
      ['tag-free string (small)', { s: 'plain text' }, { s: 'plain text' }],
      ['tag-free string with angle brackets (large)', { s: '<div>a</div> ' + 'mid <angled> & plain '.repeat(50) }, { s: '<div>a</div> ' + 'mid <angled> & plain '.repeat(50) }],
      ['well-formed tag (small)', { s: 'x<private>secret</private>y' }, { s: 'xy' }],
      ['well-formed tags, trim through the positive gate (large)', { s: '  a<private>p</private>b<system-reminder>r</system-reminder>' + 'c<claude-mem-context>m</claude-mem-context>d  ' }, { s: 'abcd' }],
      ['nested tags (small)', { s: '<private>a<system-reminder>b</system-reminder>c</private>' }, { s: '' }],
      ['nested tags across names (large)', { s: 'keep <system-reminder>a<private>b</private>c</system-reminder>' + 'd<claude-mem-context>e</claude-mem-context>end' }, { s: 'keep dend' }],
      ['unclosed tag (small)', { s: '<private>never closed' }, { s: '<private>never closed' }],
      ['unclosed tags (large)', { s: '<private>'.repeat(2000) }, { s: '<private>'.repeat(2000) }],
    ])('%s', (_name, input, expected) => {
      expect(stripMemoryTagsFromJsonStrings(input)).toEqual(expected);
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
