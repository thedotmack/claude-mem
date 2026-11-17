import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  KNOWN_OBSERVATION_TYPES,
  CATEGORY_ORDER,
  categoryOf,
  countByCategory,
} from '../../src/ui/viewer/utils/category';
import { KIND_CHIP_WORDS } from '../../src/ui/viewer/components/CategoryFilter';
import { viewerZh } from '../../src/ui/i18n/viewer-zh';
import { FeedItem } from '../../src/ui/viewer/types';

const modesDir = new URL('../../plugin/modes/', import.meta.url);
const codeTypes = [...new Set(readdirSync(modesDir)
  .filter(file => /^code(?:--.*)?\.json$/.test(file))
  .flatMap(file => JSON.parse(readFileSync(new URL(file, modesDir), 'utf8'))
    .observation_types?.map((type: { id: string }) => type.id) ?? []))] as string[];

function makeObservationItem(type: string): FeedItem {
  return { itemType: 'observation', type } as FeedItem;
}

function makeSummaryItem(): FeedItem {
  return { itemType: 'summary' } as FeedItem;
}

function makePromptItem(): FeedItem {
  return { itemType: 'prompt' } as FeedItem;
}

describe('categoryOf', () => {
  it.each(codeTypes)('keeps the code mode observation type %s filterable', (type) => {
    expect(categoryOf(makeObservationItem(type))).toBe(type);
    expect(CATEGORY_ORDER).toContain(type);
  });

  it('buckets unknown observation types into "other"', () => {
    expect(categoryOf(makeObservationItem('made_up_type'))).toBe('other');
  });

  it('returns itemType for summaries and prompts', () => {
    expect(categoryOf(makeSummaryItem())).toBe('summary');
    expect(categoryOf(makePromptItem())).toBe('prompt');
  });
});

describe('KNOWN_OBSERVATION_TYPES', () => {
  it('contains the observation types defined by the code modes', () => {
    expect(codeTypes.length).toBeGreaterThan(0);
    expect([...KNOWN_OBSERVATION_TYPES].sort()).toEqual([...codeTypes].sort());
  });
});

describe('countByCategory', () => {
  it('counts items per derived category', () => {
    const items = [
      makeObservationItem('bugfix'),
      makeObservationItem('bugfix'),
      makeObservationItem('discovery'),
      makeSummaryItem(),
      makePromptItem(),
      makePromptItem(),
    ];
    expect(countByCategory(items)).toEqual({
      bugfix: 2,
      discovery: 1,
      summary: 1,
      prompt: 2,
    });
  });

  it('returns an empty object for an empty list', () => {
    expect(countByCategory([])).toEqual({});
  });
});

describe('kind chip words', () => {
  const english = (source: string) => source;
  it('keeps the English words the chips always had', () => {
    expect(KIND_CHIP_WORDS.bugfix(english)).toBe('Bugfix');
    expect(KIND_CHIP_WORDS.discovery(english)).toBe('Discovery');
    expect(KIND_CHIP_WORDS.security_alert(english)).toBe('Security Alert');
    expect(KIND_CHIP_WORDS.security_note(english)).toBe('Security Note');
  });

  it('says every kind in the reader\'s language', () => {
    const chinese = (source: string) => viewerZh[source] ?? source;
    for (const category of CATEGORY_ORDER) {
      const word = KIND_CHIP_WORDS[category](english);
      expect(KIND_CHIP_WORDS[category](chinese)).not.toBe(word);
    }
  });
});

describe('CATEGORY_ORDER', () => {
  it('includes every known category exactly once', () => {
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  it('covers every category categoryOf can derive, so none go unfilterable', () => {
    for (const type of KNOWN_OBSERVATION_TYPES) {
      expect(CATEGORY_ORDER).toContain(type);
    }
    for (const category of ['summary', 'prompt', 'other']) {
      expect(CATEGORY_ORDER).toContain(category);
    }
  });
});
