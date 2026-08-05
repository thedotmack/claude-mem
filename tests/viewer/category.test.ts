import { describe, it, expect } from 'bun:test';
import {
  KNOWN_OBSERVATION_TYPES,
  CATEGORY_ORDER,
  categoryOf,
  countByCategory,
  labelForCategory,
} from '../../src/ui/viewer/utils/category';
import { FeedItem, Observation, Summary, UserPrompt } from '../../src/ui/viewer/types';

function makeObservationItem(type: string, overrides: Partial<Observation> = {}): FeedItem {
  return {
    id: 1,
    memory_session_id: 'mem-1',
    content_session_id: 'sess-1',
    project: 'claude-mem',
    platform_source: 'claude',
    type,
    title: 'Title',
    subtitle: null,
    narrative: null,
    text: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: null,
    created_at: '2026-01-01T00:00:00.000Z',
    created_at_epoch: 1735689600000,
    ...overrides,
    itemType: 'observation',
  };
}

function makeSummaryItem(overrides: Partial<Summary> = {}): FeedItem {
  return {
    id: 2,
    session_id: 'sess-1',
    project: 'claude-mem',
    platform_source: 'claude',
    created_at_epoch: 1735689600000,
    ...overrides,
    itemType: 'summary',
  };
}

function makePromptItem(overrides: Partial<UserPrompt> = {}): FeedItem {
  return {
    id: 3,
    content_session_id: 'sess-1',
    project: 'claude-mem',
    platform_source: 'claude',
    prompt_number: 1,
    prompt_text: 'do the thing',
    created_at_epoch: 1735689600000,
    ...overrides,
    itemType: 'prompt',
  };
}

describe('categoryOf', () => {
  it('returns the observation type when it is known', () => {
    expect(categoryOf(makeObservationItem('bugfix'))).toBe('bugfix');
    expect(categoryOf(makeObservationItem('security_alert'))).toBe('security_alert');
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
  it('contains exactly the eight canonical observation types', () => {
    expect([...KNOWN_OBSERVATION_TYPES].sort()).toEqual(
      ['bugfix', 'change', 'decision', 'discovery', 'feature', 'refactor', 'security_alert', 'security_note'].sort()
    );
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
    const expected = ['prompt', 'summary', 'discovery', 'decision', 'bugfix', 'feature', 'refactor', 'change', 'security_alert', 'security_note', 'other'];
    expect([...CATEGORY_ORDER].sort()).toEqual(expected.sort());
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });
});
