import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  KNOWN_OBSERVATION_TYPES,
  CATEGORY_ORDER,
  categoryOf,
  countByCategory,
  labelForCategory,
} from '../../src/ui/viewer/utils/category';
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

describe('labelForCategory', () => {
  it('title-cases single-word categories', () => {
    expect(labelForCategory('bugfix')).toBe('Bugfix');
    expect(labelForCategory('discovery')).toBe('Discovery');
  });

  it('replaces underscores with spaces and title-cases each word', () => {
    expect(labelForCategory('security_alert')).toBe('Security Alert');
    expect(labelForCategory('security_note')).toBe('Security Note');
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
